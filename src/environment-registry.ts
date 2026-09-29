/** Tenant-scoped WfP registry with serialized mutations and account API budget. */
import { DurableObject } from 'cloudflare:workers';

export const MAX_ENVIRONMENTS_PER_PRINCIPAL = 5;
export const ENVIRONMENT_MUTATIONS_PER_MINUTE = 10;
export const ACCOUNT_API_CALL_BUDGET = 1_000;
export const DISPATCH_REQUESTS_PER_MINUTE = 120;

const MUTATION_WINDOW_MS = 60_000;
const ACCOUNT_API_WINDOW_MS = 5 * 60_000;
const STALE_OPERATION_MS = 2 * 60_000;

export type EnvironmentRegistryStatus = 'deploying' | 'active' | 'deleting' | 'uncertain';

export interface RegistryEnvironmentInput {
	slug: string;
	title: string;
	description: string;
}

export interface RegisteredEnvironment extends RegistryEnvironmentInput {
	status: EnvironmentRegistryStatus;
	deployedAt: string | null;
	updatedAt: string;
}

export type RegistryRejection = { ok: false; reason: 'busy' | 'quota' | 'rate_limited'; retryAfterSeconds?: number };
export type RegistryDeploymentDecision = { ok: true; operationId: string } | RegistryRejection;
export type RegistryDeletionDecision = { ok: true; operationId: string } | { ok: true; absent: true } | RegistryRejection;
export type ApiBudgetDecision = { ok: true } | { ok: false; retryAfterSeconds: number };
export type DispatchAuthorization = { ok: true } | { ok: false; reason: 'inactive' | 'rate_limited'; retryAfterSeconds?: number };

interface RegistryRow {
	[key: string]: SqlStorageValue;
	slug: string;
	title: string;
	description: string;
	status: EnvironmentRegistryStatus;
	operation_id: string | null;
	previous_status: EnvironmentRegistryStatus | null;
	previous_title: string | null;
	previous_description: string | null;
	previous_deployed_at: string | null;
	deployed_at: string | null;
	updated_at: number;
}

/** One Durable Object per tenant plus a shared budget object coordinates upload,
 * delete, uncertainty recovery, and dispatch throttling.
 */
export class EnvironmentRegistry extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS environments (
				slug TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL,
				operation_id TEXT,
				previous_status TEXT,
				previous_title TEXT,
				previous_description TEXT,
				previous_deployed_at TEXT,
				deployed_at TEXT,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS environment_mutations (
				occurred_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS environment_mutations_by_time
				ON environment_mutations (occurred_at);
			CREATE TABLE IF NOT EXISTS wfp_api_budget (
				occurred_at INTEGER NOT NULL,
				calls INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS wfp_api_budget_by_time
				ON wfp_api_budget (occurred_at);
			CREATE TABLE IF NOT EXISTS environment_dispatches (
				occurred_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS environment_dispatches_by_time
				ON environment_dispatches (occurred_at);
		`);
	}

	/** Begin a fenced upsert before making the external API call.
	 * @param input - Bounded script slug and metadata.
	 * @returns Operation ID to confirm or restore after the API response.
	 */
	async beginDeploy(input: RegistryEnvironmentInput): Promise<RegistryDeploymentDecision> {
		const now = Date.now();
		let decision: RegistryDeploymentDecision = { ok: false, reason: 'busy' };

		this.ctx.storage.transactionSync(() => {
			const existing = this.read(input.slug);
			if (existing && this.isBusy(existing, now)) return;

			const rateLimit = this.checkRateLimit(now);
			if (rateLimit) {
				decision = rateLimit;
				return;
			}

			if (!existing) {
				const count = this.ctx.storage.sql
					.exec<{ [key: string]: SqlStorageValue; count: number }>('SELECT COUNT(*) AS count FROM environments')
					.one().count;
				if (count >= MAX_ENVIRONMENTS_PER_PRINCIPAL) {
					decision = { ok: false, reason: 'quota' };
					return;
				}
			}

			const operationId = crypto.randomUUID();
			this.recordMutation(now);
			if (existing) {
				const previousStatus = this.previousStatus(existing);
				const wasTransient = existing.status === 'deploying' || existing.status === 'deleting';
				this.ctx.storage.sql.exec(
					`UPDATE environments SET
						title = ?, description = ?, status = 'deploying', operation_id = ?,
						previous_status = ?, previous_title = ?, previous_description = ?,
						previous_deployed_at = ?, updated_at = ?
					 WHERE slug = ?`,
					input.title,
					input.description,
					operationId,
					previousStatus,
					wasTransient ? (existing.previous_title ?? existing.title) : existing.title,
					wasTransient ? (existing.previous_description ?? existing.description) : existing.description,
					wasTransient ? existing.previous_deployed_at : existing.deployed_at,
					now,
					input.slug,
				);
			} else {
				this.ctx.storage.sql.exec(
					`INSERT INTO environments
						(slug, title, description, status, operation_id, updated_at)
					 VALUES (?, ?, ?, 'deploying', ?, ?)`,
					input.slug,
					input.title,
					input.description,
					operationId,
					now,
				);
			}
			decision = { ok: true, operationId };
		});

		return decision;
	}

	async completeDeploy(slug: string, operationId: string, deployedAt: string): Promise<boolean> {
		const result = this.ctx.storage.sql.exec(
			`UPDATE environments SET
				status = 'active', operation_id = NULL, previous_status = NULL,
				previous_title = NULL, previous_description = NULL,
				previous_deployed_at = NULL, deployed_at = ?, updated_at = ?
			 WHERE slug = ? AND status = 'deploying' AND operation_id = ?
			 RETURNING slug`,
			deployedAt,
			Date.now(),
			slug,
			operationId,
		);
		return result.toArray().length === 1;
	}

	async failDeploy(slug: string, operationId: string, outcomeUnknown: boolean): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			const row = this.read(slug);
			if (!row || row.status !== 'deploying' || row.operation_id !== operationId) return;
			if (outcomeUnknown) {
				this.markUncertain(slug);
				return;
			}
			this.restoreOrDelete(row);
		});
	}

	/** Reserve a script deletion. Automatic expiry may bypass the visitor mutation
	 * rate limit so a busy demo cannot prevent its own cleanup.
	 */
	async beginDelete(slug: string, cleanup = false): Promise<RegistryDeletionDecision> {
		const now = Date.now();
		let decision: RegistryDeletionDecision = { ok: false, reason: 'busy' };

		this.ctx.storage.transactionSync(() => {
			const existing = this.read(slug);
			if (!existing) {
				const rateLimit = cleanup ? null : this.checkRateLimit(now);
				if (rateLimit) {
					decision = rateLimit;
					return;
				}
				if (!cleanup) this.recordMutation(now);
				decision = { ok: true, absent: true };
				return;
			}
			if (this.isBusy(existing, now)) return;

			const rateLimit = cleanup ? null : this.checkRateLimit(now);
			if (rateLimit) {
				decision = rateLimit;
				return;
			}

			const operationId = crypto.randomUUID();
			if (!cleanup) this.recordMutation(now);
			this.ctx.storage.sql.exec(
				`UPDATE environments SET
					status = 'deleting', operation_id = ?, previous_status = ?,
					previous_title = title, previous_description = description,
					previous_deployed_at = deployed_at, updated_at = ?
				 WHERE slug = ?`,
				operationId,
				this.previousStatus(existing),
				now,
				slug,
			);
			decision = { ok: true, operationId };
		});

		return decision;
	}

	/** Expiry uses the same transition as a user delete, without consuming a
	 * user-facing mutation slot that could otherwise strand a published script.
	 * @param slug - Tenant-scoped script slug to remove.
	 * @returns Fenced operation ID, absent result, or busy decision.
	 */
	async beginExpiryDelete(slug: string): Promise<RegistryDeletionDecision> {
		return this.beginDelete(slug, true);
	}

	async completeDelete(slug: string, operationId: string): Promise<boolean> {
		const result = this.ctx.storage.sql
			.exec(
				`DELETE FROM environments
				 WHERE slug = ? AND status = 'deleting' AND operation_id = ?
				 RETURNING slug`,
				slug,
				operationId,
			)
			.toArray();
		return result.length === 1;
	}

	async failDelete(slug: string, operationId: string, outcomeUnknown: boolean): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			const row = this.read(slug);
			if (!row || row.status !== 'deleting' || row.operation_id !== operationId) return;
			if (outcomeUnknown) {
				this.markUncertain(slug);
				return;
			}
			this.restoreOrDelete(row);
		});
	}

	async isActive(slug: string): Promise<boolean> {
		return this.ctx.storage.sql.exec("SELECT 1 FROM environments WHERE slug = ? AND status = 'active'", slug).toArray().length === 1;
	}

	async authorizeDispatch(slug: string): Promise<DispatchAuthorization> {
		const now = Date.now();
		let decision: DispatchAuthorization = { ok: false, reason: 'inactive' };
		this.ctx.storage.transactionSync(() => {
			if (!this.readActive(slug)) return;
			this.ctx.storage.sql.exec('DELETE FROM environment_dispatches WHERE occurred_at <= ?', now - MUTATION_WINDOW_MS);
			const rows = this.ctx.storage.sql
				.exec<{ [key: string]: SqlStorageValue; occurred_at: number }>(
					'SELECT occurred_at FROM environment_dispatches ORDER BY occurred_at ASC',
				)
				.toArray();
			if (rows.length >= DISPATCH_REQUESTS_PER_MINUTE) {
				decision = {
					ok: false,
					reason: 'rate_limited',
					retryAfterSeconds: Math.max(1, Math.ceil((rows[0].occurred_at + MUTATION_WINDOW_MS - now) / 1_000)),
				};
				return;
			}
			this.ctx.storage.sql.exec('INSERT INTO environment_dispatches (occurred_at) VALUES (?)', now);
			decision = { ok: true };
		});
		return decision;
	}

	/** Account-wide API budget is separate from per-tenant mutation limits.
	 * @param calls - Worst-case calls (including the 404 namespace check on delete).
	 * @param preserveCleanupCapacity - Reserve headroom for alarm-driven expiry.
	 * @returns Admission decision with a retry delay when the window is full.
	 */
	async reserveApiCalls(calls: number, preserveCleanupCapacity = false): Promise<ApiBudgetDecision> {
		if (!Number.isInteger(calls) || calls < 1 || calls > ACCOUNT_API_CALL_BUDGET) throw new Error('Invalid API call reservation');
		const ceiling = ACCOUNT_API_CALL_BUDGET - (preserveCleanupCapacity ? 50 : 0);
		const now = Date.now();
		let decision: ApiBudgetDecision = { ok: true };

		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec('DELETE FROM wfp_api_budget WHERE occurred_at <= ?', now - ACCOUNT_API_WINDOW_MS);
			const rows = this.ctx.storage.sql
				.exec<{ [key: string]: SqlStorageValue; occurred_at: number; calls: number }>(
					'SELECT occurred_at, calls FROM wfp_api_budget ORDER BY occurred_at ASC',
				)
				.toArray();
			const total = rows.reduce((sum, row) => sum + row.calls, 0);
			if (total + calls > ceiling) {
				let callsToExpire = total + calls - ceiling;
				let retryAt = rows[0]?.occurred_at ?? now;
				for (const row of rows) {
					callsToExpire -= row.calls;
					retryAt = row.occurred_at;
					if (callsToExpire <= 0) break;
				}
				decision = { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt + ACCOUNT_API_WINDOW_MS - now) / 1_000)) };
				return;
			}
			this.ctx.storage.sql.exec('INSERT INTO wfp_api_budget (occurred_at, calls) VALUES (?, ?)', now, calls);
		});

		return decision;
	}

	async list(): Promise<RegisteredEnvironment[]> {
		return this.ctx.storage.sql
			.exec<RegistryRow>('SELECT * FROM environments ORDER BY updated_at DESC, slug ASC')
			.toArray()
			.map((row) => ({
				slug: row.slug,
				title: row.title,
				description: row.description,
				status: row.status,
				deployedAt: row.deployed_at,
				updatedAt: new Date(row.updated_at).toISOString(),
			}));
	}

	private read(slug: string): RegistryRow | null {
		return this.ctx.storage.sql.exec<RegistryRow>('SELECT * FROM environments WHERE slug = ?', slug).toArray()[0] ?? null;
	}

	private readActive(slug: string): boolean {
		return this.ctx.storage.sql.exec("SELECT 1 FROM environments WHERE slug = ? AND status = 'active'", slug).toArray().length === 1;
	}

	private isBusy(row: RegistryRow, now: number): boolean {
		return (row.status === 'deploying' || row.status === 'deleting') && now - row.updated_at < STALE_OPERATION_MS;
	}

	private previousStatus(row: RegistryRow): EnvironmentRegistryStatus {
		return row.status === 'deploying' || row.status === 'deleting' ? (row.previous_status ?? 'uncertain') : row.status;
	}

	private checkRateLimit(now: number): RegistryRejection | null {
		const windowStart = now - MUTATION_WINDOW_MS;
		this.ctx.storage.sql.exec('DELETE FROM environment_mutations WHERE occurred_at <= ?', windowStart);
		const rows = this.ctx.storage.sql
			.exec<{ [key: string]: SqlStorageValue; occurred_at: number }>(
				'SELECT occurred_at FROM environment_mutations ORDER BY occurred_at ASC',
			)
			.toArray();
		if (rows.length < ENVIRONMENT_MUTATIONS_PER_MINUTE) return null;
		return {
			ok: false,
			reason: 'rate_limited',
			retryAfterSeconds: Math.max(1, Math.ceil((rows[0].occurred_at + MUTATION_WINDOW_MS - now) / 1_000)),
		};
	}

	private recordMutation(now: number): void {
		this.ctx.storage.sql.exec('INSERT INTO environment_mutations (occurred_at) VALUES (?)', now);
	}

	private markUncertain(slug: string): void {
		this.ctx.storage.sql.exec(
			`UPDATE environments SET
				status = 'uncertain', operation_id = NULL, previous_status = NULL,
				previous_title = NULL, previous_description = NULL,
				previous_deployed_at = NULL, updated_at = ?
			 WHERE slug = ?`,
			Date.now(),
			slug,
		);
	}

	private restoreOrDelete(row: RegistryRow): void {
		if (!row.previous_status) {
			this.ctx.storage.sql.exec('DELETE FROM environments WHERE slug = ?', row.slug);
			return;
		}
		this.ctx.storage.sql.exec(
			`UPDATE environments SET
				title = ?, description = ?, status = ?, operation_id = NULL,
				previous_status = NULL, previous_title = NULL, previous_description = NULL,
				previous_deployed_at = NULL, deployed_at = ?, updated_at = ?
			 WHERE slug = ?`,
			row.previous_title ?? row.title,
			row.previous_description ?? row.description,
			row.previous_status,
			row.previous_deployed_at,
			Date.now(),
			row.slug,
		);
	}
}
