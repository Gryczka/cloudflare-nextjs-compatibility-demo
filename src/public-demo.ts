/** Anonymous demo sessions and deployment-wide reservations. The Durable Object is the
 * single coordination point for costly operations; visitor cookies never contain IDs
 * accepted directly by the publisher or the run Durable Objects.
 */
import { DurableObject } from 'cloudflare:workers';
import type { FixtureId } from './domain';
import { isFixtureId } from './fixtures';
import { destroyRunSandbox } from './sandbox-runner';
import { customerKeyForPrincipal, deleteEnvironment, WfpPublisherError } from './wfp-environments';

const SESSION_COOKIE = '__Host-compatibility-session';
const SESSION_TTL_MS = 2 * 60 * 60_000;
const RUN_DEADLINE_MS = 30 * 60_000;
const PREVIEW_TTL_MS = 30 * 60_000;
const ENVIRONMENT_TTL_MS = 30 * 60_000;
const CLEANUP_RETRY_MS = 30_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Budgets are demo policy, not Cloudflare platform limits. All limits are
 * checked in one SQLite transaction, including limits across new sessions.
 */
export const DEMO_LIMITS = {
	activeRuns: 3,
	activeRunsPerSession: 1,
	runsPerSessionHour: 3,
	runsPerIpHour: 5,
	runsPerHour: 10,
	runsPerDay: 30,
	environments: 10,
	environmentsPerSession: 1,
	publishesPerSessionMinute: 3,
	publishesPerIpHour: 5,
	publishesPerHour: 20,
	publishesPerDay: 50,
	requestsPerSessionMinute: 120,
	requestsPerIpMinute: 500,
	requestsPerMinute: 2_000,
	dispatchesPerMinute: 300,
	sessionsPerIpHour: 10,
	sessionsPerDay: 500,
} as const;

type Rejection = { ok: false; status: 401 | 404 | 409 | 429; error: string; retryAfterSeconds?: number };
type Decision = { ok: true } | Rejection;
type SessionDecision = { ok: true; hash: string; created: boolean } | Rejection;
type DemoPrincipal = { id: string; label: string; ipHash: string };
type DemoAuthorization = { principal: DemoPrincipal; setCookie?: string };
interface TimeRow {
	[key: string]: SqlStorageValue;
	happened: number;
}
interface SessionRow {
	[key: string]: SqlStorageValue;
	expires_at: number;
}
interface RunRow {
	[key: string]: SqlStorageValue;
	id: string;
	owner_id: string;
	fixture_id: FixtureId;
	deadline: number;
}
interface EnvironmentRow {
	[key: string]: SqlStorageValue;
	owner_id: string;
	slug: string;
	state: string;
	expires_at: number;
	previous_expires_at: number | null;
}
type Meter = 'session_issues' | 'request_events' | 'run_issues' | 'publish_issues';
type Scope = 'owner_id' | 'ip_hash' | null;

/** Resolve a visitor exclusively from a random HttpOnly session cookie. Bootstrap is
 * restricted to safe navigations or the explicit CLI session endpoint.
 * @param request - Incoming HTTP request; only its cookie and edge IP are used.
 * @param env - Worker bindings, including the server-only HMAC secret.
 * @returns Authenticated visitor or a response denying missing/limited sessions.
 */
export async function authenticateDemo(request: Request, env: Env): Promise<DemoAuthorization | Response> {
	if (!env.DEMO_SESSION_KEY || env.DEMO_SESSION_KEY.length < 32) {
		return Response.json({ error: 'Demo sessions are not configured' }, { status: 503 });
	}
	const path = new URL(request.url).pathname;
	const bootstrap = request.method === 'GET' && (path === '/' || path === '/api/session');
	const rawToken = request.headers
		.get('Cookie')
		?.split(';')
		.map((value) => value.trim())
		.find((value) => value.startsWith(`${SESSION_COOKIE}=`))
		?.slice(SESSION_COOKIE.length + 1);
	const existingHash = rawToken && HASH_PATTERN.test(rawToken) ? await digest(rawToken) : null;
	if (!existingHash && !bootstrap) {
		return Response.json({ error: 'Open the demo or GET /api/session to start a visitor session' }, { status: 401 });
	}
	const token = bootstrap ? randomHex(32) : null;
	const nextHash = token ? await digest(token) : null;
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown-client';
	const ipHash = await hmac(env.DEMO_SESSION_KEY, ip);
	const category = path.startsWith('/customer-environments/') ? 'dispatch' : 'request';
	const decision = await coordinator(env).authorizeSession(existingHash, ipHash, nextHash, category);
	if (!decision.ok) return rejected(decision);
	return {
		principal: { id: `demo:${decision.hash}`, label: 'Demo visitor', ipHash },
		...(decision.created && token
			? { setCookie: `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` }
			: {}),
	};
}

/** Get the deployment-wide quota object (all visitors use the same DO).
 * @param env - Worker bindings.
 * @returns RPC stub for the single demo coordinator.
 */
export function coordinator(env: Env) {
	return env.DEMO_COORDINATOR.getByName('public-demo');
}

export function isPublicDemo(env: Env): boolean {
	const mode: unknown = env.PUBLIC_DEMO;
	return mode === 'true';
}

export function rejected(decision: Rejection): Response {
	return Response.json(
		{ error: decision.error },
		{
			status: decision.status,
			headers: {
				'Cache-Control': 'no-store',
				...(decision.retryAfterSeconds ? { 'Retry-After': String(decision.retryAfterSeconds) } : {}),
			},
		},
	);
}

async function digest(value: string): Promise<string> {
	return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hmac(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(size: number): string {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return hex(bytes.buffer);
}

/** The coordinator persists only hashes of visitor tokens/IPs and enforces every
 * deployment-wide quota before work starts. Expiry alarms reclaim live resources,
 * retrying uncertain deletes rather than freeing a slot prematurely.
 */
export class PublicDemoCoordinator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_issues (ip_hash TEXT NOT NULL, happened INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS request_events (owner_id TEXT NOT NULL, ip_hash TEXT NOT NULL, kind TEXT NOT NULL, happened INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_issues (owner_id TEXT NOT NULL, ip_hash TEXT NOT NULL, happened INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publish_issues (owner_id TEXT NOT NULL, ip_hash TEXT NOT NULL, happened INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_runs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fixture_id TEXT NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_environments (
        owner_id TEXT NOT NULL, slug TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL,
        previous_expires_at INTEGER, PRIMARY KEY(owner_id, slug)
      );
      CREATE INDEX IF NOT EXISTS runs_deadline ON demo_runs(deadline);
      CREATE INDEX IF NOT EXISTS environments_expiry ON demo_environments(expires_at);
    `);
	}

	/** Atomically issue/verify a session and meter its request.
	 * @param hash - SHA-256 of the presented cookie, if any.
	 * @param ipHash - HMAC of the edge-provided IP, never a raw address.
	 * @param nextHash - Hash of a newly generated cookie on a bootstrap route.
	 * @param category - Whether this is a dispatch or regular request.
	 * @returns The validated visitor hash or a retryable limit.
	 */
	async authorizeSession(
		hash: string | null,
		ipHash: string,
		nextHash: string | null,
		category: 'request' | 'dispatch',
	): Promise<SessionDecision> {
		if (!HASH_PATTERN.test(ipHash) || (hash && !HASH_PATTERN.test(hash)) || (nextHash && !HASH_PATTERN.test(nextHash))) {
			return { ok: false, status: 401, error: 'Invalid demo session' };
		}
		const now = Date.now();
		let decision: SessionDecision = { ok: false, status: 401, error: 'Visitor session has expired; reload the demo' };
		this.ctx.storage.transactionSync(() => {
			this.prune(now);
			const row = hash ? this.ctx.storage.sql.exec<SessionRow>('SELECT expires_at FROM sessions WHERE hash = ?', hash).toArray()[0] : null;
			const existing = row && row.expires_at > now ? hash : null;
			if (!existing && !nextHash) return;
			const owner = `demo:${existing ?? nextHash}`;
			if (!existing) {
				const sessionLimit =
					this.check('session_issues', 'ip_hash', ipHash, 60 * 60_000, DEMO_LIMITS.sessionsPerIpHour, now) ??
					this.check('session_issues', null, null, 24 * 60 * 60_000, DEMO_LIMITS.sessionsPerDay, now);
				if (sessionLimit) {
					decision = sessionLimit;
					return;
				}
			}
			const requestLimit =
				this.check('request_events', 'owner_id', owner, 60_000, DEMO_LIMITS.requestsPerSessionMinute, now) ??
				this.check('request_events', 'ip_hash', ipHash, 60_000, DEMO_LIMITS.requestsPerIpMinute, now) ??
				this.check('request_events', null, null, 60_000, DEMO_LIMITS.requestsPerMinute, now);
			if (requestLimit) {
				decision = requestLimit;
				return;
			}
			if (category === 'dispatch') {
				const count = this.ctx.storage.sql
					.exec<TimeRow>(
						'SELECT happened FROM request_events WHERE kind = ? AND happened > ? ORDER BY happened ASC',
						'dispatch',
						now - 60_000,
					)
					.toArray();
				if (count.length >= DEMO_LIMITS.dispatchesPerMinute) {
					decision = throttled('Demo dispatch capacity reached', count[0].happened + 60_000, now);
					return;
				}
			}
			if (!existing) {
				this.ctx.storage.sql.exec('INSERT INTO sessions(hash, expires_at) VALUES (?, ?)', nextHash, now + SESSION_TTL_MS);
				this.ctx.storage.sql.exec('INSERT INTO session_issues(ip_hash, happened) VALUES (?, ?)', ipHash, now);
			}
			this.ctx.storage.sql.exec(
				'INSERT INTO request_events(owner_id, ip_hash, kind, happened) VALUES (?, ?, ?, ?)',
				owner,
				ipHash,
				category,
				now,
			);
			decision = { ok: true, hash: existing ?? nextHash!, created: !existing };
		});
		// transactionSync assigns inside its callback; TypeScript cannot narrow the
		// outer variable from that assignment, even though the callback is synchronous.
		const authorized = decision as SessionDecision;
		if (authorized.ok && authorized.created) await this.schedule();
		return decision;
	}

	/** Reserve a live Sandbox slot and charge sliding-window run budgets before
	 * Workflow creation; retries never clear the slot until teardown confirms.
	 * @param id - New UUID that also identifies the Workflow and Sandbox.
	 * @param owner - Session-derived owner, never supplied by the caller.
	 * @param ipHash - HMAC of the edge IP.
	 * @param fixtureId - Fixed fixture retained for idempotent failed-start recovery.
	 * @returns Admission decision with Retry-After on exhaustion.
	 */
	async reserveRun(id: string, owner: string, ipHash: string, fixtureId: FixtureId): Promise<Decision> {
		if (!isOwner(owner) || !HASH_PATTERN.test(ipHash) || !/^[a-f0-9-]{36}$/.test(id) || !isFixtureId(fixtureId)) return invalid();
		const now = Date.now();
		let decision: Decision = { ok: true };
		this.ctx.storage.transactionSync(() => {
			this.prune(now);
			const already = this.ctx.storage.sql.exec('SELECT 1 FROM demo_runs WHERE id = ?', id).toArray().length;
			if (already) {
				decision = { ok: false, status: 409, error: 'Run already reserved' };
				return;
			}
			const activeOwner = this.ctx.storage.sql.exec('SELECT 1 FROM demo_runs WHERE owner_id = ?', owner).toArray().length;
			const activeAll = this.ctx.storage.sql.exec('SELECT 1 FROM demo_runs').toArray().length;
			if (activeOwner >= DEMO_LIMITS.activeRunsPerSession || activeAll >= DEMO_LIMITS.activeRuns) {
				decision = throttled('Demo build capacity is full', now + 60_000, now);
				return;
			}
			decision = this.check('run_issues', 'owner_id', owner, 60 * 60_000, DEMO_LIMITS.runsPerSessionHour, now) ??
				this.check('run_issues', 'ip_hash', ipHash, 60 * 60_000, DEMO_LIMITS.runsPerIpHour, now) ??
				this.check('run_issues', null, null, 60 * 60_000, DEMO_LIMITS.runsPerHour, now) ??
				this.check('run_issues', null, null, 24 * 60 * 60_000, DEMO_LIMITS.runsPerDay, now) ?? { ok: true };
			if (!decision.ok) return;
			this.ctx.storage.sql.exec(
				'INSERT INTO demo_runs(id, owner_id, fixture_id, deadline, state) VALUES (?, ?, ?, ?, ?)',
				id,
				owner,
				fixtureId,
				now + RUN_DEADLINE_MS,
				'building',
			);
			this.ctx.storage.sql.exec('INSERT INTO run_issues(owner_id, ip_hash, happened) VALUES (?, ?, ?)', owner, ipHash, now);
		});
		if (decision.ok) await this.schedule();
		return decision;
	}

	async canRun(id: string): Promise<boolean> {
		const row = this.ctx.storage.sql
			.exec<RunRow>('SELECT id, owner_id, deadline FROM demo_runs WHERE id = ? AND state != ?', id, 'cleaning')
			.toArray()[0];
		return Boolean(row && row.deadline > Date.now());
	}

	/** Mark uncertain starts and preview failures for alarm-driven teardown.
	 * The reservation is held until Sandbox destruction actually succeeds.
	 * @param id - Previously reserved run ID.
	 * @returns After the durable cleanup alarm has been scheduled.
	 */
	async requestRunCleanup(id: string): Promise<void> {
		this.ctx.storage.sql.exec("UPDATE demo_runs SET state = 'cleaning', deadline = ? WHERE id = ?", Date.now() + 1_000, id);
		await this.schedule();
	}

	/** Extend a live reservation only after final route-level verification.
	 * @param id - Run ID with a still-valid build reservation.
	 * @returns False if the build deadline expired or cancellation has begun.
	 */
	async holdPreview(id: string): Promise<boolean> {
		const now = Date.now();
		const updated = this.ctx.storage.sql
			.exec(
				'UPDATE demo_runs SET state = ?, deadline = ? WHERE id = ? AND state = ? AND deadline > ? RETURNING id',
				'preview',
				now + PREVIEW_TTL_MS,
				id,
				'building',
				now,
			)
			.toArray();
		if (updated.length) await this.schedule();
		if (updated.length) return true;
		const existing = this.ctx.storage.sql
			.exec<{ [key: string]: SqlStorageValue; deadline: number }>(
				'SELECT deadline FROM demo_runs WHERE id = ? AND state = ?',
				id,
				'preview',
			)
			.toArray()[0];
		return Boolean(existing && existing.deadline > now);
	}

	async releaseRun(id: string): Promise<boolean> {
		const reserved = this.ctx.storage.sql.exec('SELECT 1 FROM demo_runs WHERE id = ?', id).toArray().length;
		if (!reserved) return true;
		// Keep the slot if the run record cannot confirm teardown or schedule expiry.
		if (!(await this.env.RUNS.getByName(id).expireAfterTeardown())) {
			await this.requestRunCleanup(id);
			return false;
		}
		this.ctx.storage.sql.exec('DELETE FROM demo_runs WHERE id = ?', id);
		await this.schedule();
		return true;
	}

	/** Reserve a fixed-template upload/update before contacting Cloudflare.
	 * @param owner - Session-derived principal.
	 * @param slug - Validated environment slug.
	 * @param ipHash - HMAC of the edge-provided IP.
	 * @returns Admission or quota/rate-limit error; uncertain uploads keep the slot.
	 */
	async reserveEnvironment(owner: string, slug: string, ipHash: string): Promise<Decision> {
		if (!isOwner(owner) || !HASH_PATTERN.test(ipHash) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return invalid();
		const now = Date.now();
		let decision: Decision = { ok: true };
		this.ctx.storage.transactionSync(() => {
			this.prune(now);
			const row = this.environment(owner, slug);
			if (row && row.state !== 'active') {
				decision = { ok: false, status: 409, error: 'Environment update in progress' };
				return;
			}
			if (!row) {
				const owned = this.ctx.storage.sql.exec('SELECT 1 FROM demo_environments WHERE owner_id = ?', owner).toArray().length;
				const all = this.ctx.storage.sql.exec('SELECT 1 FROM demo_environments').toArray().length;
				if (owned >= DEMO_LIMITS.environmentsPerSession || all >= DEMO_LIMITS.environments) {
					decision = throttled('Demo environment capacity is full', now + 60_000, now);
					return;
				}
			}
			decision = this.check('publish_issues', 'owner_id', owner, 60_000, DEMO_LIMITS.publishesPerSessionMinute, now) ??
				this.check('publish_issues', 'ip_hash', ipHash, 60 * 60_000, DEMO_LIMITS.publishesPerIpHour, now) ??
				this.check('publish_issues', null, null, 60 * 60_000, DEMO_LIMITS.publishesPerHour, now) ??
				this.check('publish_issues', null, null, 24 * 60 * 60_000, DEMO_LIMITS.publishesPerDay, now) ?? { ok: true };
			if (!decision.ok) return;
			this.ctx.storage.sql.exec(
				`INSERT INTO demo_environments(owner_id, slug, state, expires_at, previous_expires_at) VALUES (?, ?, 'publishing', ?, NULL)
         ON CONFLICT(owner_id, slug) DO UPDATE SET state = 'publishing', previous_expires_at = expires_at, expires_at = excluded.expires_at`,
				owner,
				slug,
				now + 2 * 60_000,
			);
			this.ctx.storage.sql.exec('INSERT INTO publish_issues(owner_id, ip_hash, happened) VALUES (?, ?, ?)', owner, ipHash, now);
		});
		if (decision.ok) await this.schedule();
		return decision;
	}

	async confirmEnvironment(owner: string, slug: string): Promise<number> {
		const expiry = Date.now() + ENVIRONMENT_TTL_MS;
		const updated = this.ctx.storage.sql
			.exec(
				"UPDATE demo_environments SET state = 'active', expires_at = ?, previous_expires_at = NULL WHERE owner_id = ? AND slug = ? AND state = 'publishing' RETURNING slug",
				expiry,
				owner,
				slug,
			)
			.toArray();
		if (updated.length !== 1) throw new Error('Demo environment reservation was lost');
		await this.schedule();
		return expiry;
	}

	async failEnvironment(owner: string, slug: string, outcomeUnknown: boolean): Promise<void> {
		const row = this.environment(owner, slug);
		if (row?.state !== 'publishing') return;
		if (outcomeUnknown) {
			this.ctx.storage.sql.exec(
				"UPDATE demo_environments SET state = 'uncertain', expires_at = ? WHERE owner_id = ? AND slug = ?",
				Date.now() + CLEANUP_RETRY_MS,
				owner,
				slug,
			);
		} else if (row.previous_expires_at) {
			this.ctx.storage.sql.exec(
				"UPDATE demo_environments SET state = 'active', expires_at = ?, previous_expires_at = NULL WHERE owner_id = ? AND slug = ?",
				row.previous_expires_at,
				owner,
				slug,
			);
		} else {
			this.ctx.storage.sql.exec('DELETE FROM demo_environments WHERE owner_id = ? AND slug = ?', owner, slug);
		}
		await this.schedule();
	}

	async beginEnvironmentDelete(owner: string, slug: string): Promise<Decision> {
		const row = this.environment(owner, slug);
		if (!row) return { ok: false, status: 404, error: 'Environment not found' };
		if (row.state !== 'active' && row.state !== 'uncertain') return { ok: false, status: 409, error: 'Environment update in progress' };
		this.ctx.storage.sql.exec(
			"UPDATE demo_environments SET state = 'deleting', previous_expires_at = expires_at, expires_at = ? WHERE owner_id = ? AND slug = ?",
			Date.now() + CLEANUP_RETRY_MS,
			owner,
			slug,
		);
		await this.schedule();
		return { ok: true };
	}

	async failEnvironmentDelete(owner: string, slug: string, outcomeUnknown: boolean): Promise<void> {
		const row = this.environment(owner, slug);
		if (row?.state !== 'deleting') return;
		this.ctx.storage.sql.exec(
			'UPDATE demo_environments SET state = ?, expires_at = ?, previous_expires_at = NULL WHERE owner_id = ? AND slug = ?',
			outcomeUnknown ? 'uncertain' : 'active',
			outcomeUnknown ? Date.now() + CLEANUP_RETRY_MS : (row.previous_expires_at ?? Date.now() + CLEANUP_RETRY_MS),
			owner,
			slug,
		);
		await this.schedule();
	}

	async releaseEnvironment(owner: string, slug: string): Promise<void> {
		this.ctx.storage.sql.exec('DELETE FROM demo_environments WHERE owner_id = ? AND slug = ?', owner, slug);
		await this.schedule();
	}

	async canDispatch(owner: string, slug: string): Promise<boolean> {
		const row = this.environment(owner, slug);
		return Boolean(row && row.state === 'active' && row.expires_at > Date.now());
	}

	async listEnvironments(owner: string): Promise<Record<string, { active: boolean; expiresAt: string }>> {
		const now = Date.now();
		const rows = this.ctx.storage.sql.exec<EnvironmentRow>('SELECT * FROM demo_environments WHERE owner_id = ?', owner).toArray();
		return Object.fromEntries(
			rows.map((row) => [
				row.slug,
				{
					active: row.state === 'active' && row.expires_at > now,
					expiresAt: new Date(row.state === 'active' ? row.expires_at : (row.previous_expires_at ?? row.expires_at)).toISOString(),
				},
			]),
		);
	}

	/** Reconcile expired runs and published scripts; external failures retain
	 * reservations and schedule another attempt rather than guessing they stopped.
	 * @returns After the next alarm is scheduled from current durable deadlines.
	 */
	async alarm(): Promise<void> {
		const now = Date.now();
		const runs = this.ctx.storage.sql
			.exec<RunRow>('SELECT id, owner_id, fixture_id, deadline FROM demo_runs WHERE deadline <= ? ORDER BY deadline LIMIT 10', now)
			.toArray();
		const environments = this.ctx.storage.sql
			.exec<EnvironmentRow>('SELECT * FROM demo_environments WHERE expires_at <= ? ORDER BY expires_at LIMIT 10', now)
			.toArray();
		for (const run of runs) {
			const claimed = this.ctx.storage.sql
				.exec(
					"UPDATE demo_runs SET state = 'cleaning', deadline = ? WHERE id = ? AND deadline <= ? RETURNING id",
					Date.now() + CLEANUP_RETRY_MS,
					run.id,
					now,
				)
				.toArray();
			if (!claimed.length) continue;
			try {
				let workflow;
				try {
					workflow = await this.env.COMPATIBILITY_WORKFLOW.get(run.id);
				} catch {
					// An earlier createBatch may have failed before accepting this run, or
					// its response may have been lost. createBatch skips an existing ID.
					// The slot is already cleaning, so a newly started run cannot build.
					await this.env.COMPATIBILITY_WORKFLOW.createBatch([{ id: run.id, params: { runId: run.id, fixtureId: run.fixture_id } }]);
					workflow = await this.env.COMPATIBILITY_WORKFLOW.get(run.id);
				}
				const status = await workflow.status();
				if (!['errored', 'terminated', 'complete'].includes(status.status)) await workflow.terminate();
				const record = this.env.RUNS.getByName(run.id);
				const snapshot = await record.getSnapshot();
				if (snapshot?.status === 'succeeded' && snapshot.previewPath) {
					await record.record(
						{
							key: 'preview:demo-expired',
							timestamp: new Date().toISOString(),
							type: 'preview.expired',
							level: 'info',
							stage: 'publish',
							message: 'Live preview expired',
						},
						{ previewPath: null, previewProcessId: null, previewPort: null },
					);
				} else if (snapshot && snapshot.status !== 'failed' && snapshot.status !== 'cancelled') {
					await record.cancel(new Date().toISOString());
				}
				await destroyRunSandbox(this.env, run.id);
				if (snapshot) await record.markSandboxDestroyed(new Date().toISOString(), 'demo deadline');
				await this.releaseRun(run.id);
			} catch (error) {
				console.warn(
					JSON.stringify({ event: 'demo.run.cleanup_retry', runId: run.id, error: error instanceof Error ? error.message : String(error) }),
				);
			}
		}
		for (const environment of environments) {
			const claimed = this.ctx.storage.sql
				.exec(
					"UPDATE demo_environments SET state = 'deleting', expires_at = ? WHERE owner_id = ? AND slug = ? AND expires_at <= ? RETURNING slug",
					Date.now() + CLEANUP_RETRY_MS,
					environment.owner_id,
					environment.slug,
					now,
				)
				.toArray();
			if (!claimed.length) continue;
			try {
				const customerKey = await customerKeyForPrincipal(environment.owner_id);
				const registry = this.env.ENVIRONMENT_REGISTRIES.getByName(customerKey);
				const budget = await this.env.ENVIRONMENT_REGISTRIES.getByName('wfp-account-api-budget').reserveApiCalls(2);
				if (!budget.ok) throw new Error('Cleanup API budget exhausted');
				const reservation = await registry.beginExpiryDelete(environment.slug);
				if (!reservation.ok) throw new Error('Environment registry is busy');
				try {
					await deleteEnvironment(this.env, environment.owner_id, environment.slug, 'https://demo.invalid');
				} catch (error) {
					if (!('absent' in reservation))
						await registry.failDelete(
							environment.slug,
							reservation.operationId,
							error instanceof WfpPublisherError && error.outcomeUnknown,
						);
					throw error;
				}
				if (!('absent' in reservation) && !(await registry.completeDelete(environment.slug, reservation.operationId))) {
					throw new Error('Environment registry deletion could not be confirmed');
				}
				await this.releaseEnvironment(environment.owner_id, environment.slug);
			} catch (error) {
				console.warn(
					JSON.stringify({
						event: 'demo.environment.cleanup_retry',
						slug: environment.slug,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
		this.prune(Date.now());
		await this.schedule();
	}

	private environment(owner: string, slug: string): EnvironmentRow | null {
		return (
			this.ctx.storage.sql
				.exec<EnvironmentRow>('SELECT * FROM demo_environments WHERE owner_id = ? AND slug = ?', owner, slug)
				.toArray()[0] ?? null
		);
	}

	private prune(now: number): void {
		this.ctx.storage.sql.exec('DELETE FROM sessions WHERE expires_at <= ?', now);
		this.ctx.storage.sql.exec('DELETE FROM session_issues WHERE happened <= ?', now - 24 * 60 * 60_000);
		this.ctx.storage.sql.exec('DELETE FROM request_events WHERE happened <= ?', now - 60_000);
		this.ctx.storage.sql.exec('DELETE FROM run_issues WHERE happened <= ?', now - 24 * 60 * 60_000);
		this.ctx.storage.sql.exec('DELETE FROM publish_issues WHERE happened <= ?', now - 24 * 60 * 60_000);
	}

	private check(table: Meter, scope: Scope, value: string | null, windowMs: number, limit: number, now: number): Rejection | null {
		const rows = scope
			? this.ctx.storage.sql
					.exec<TimeRow>(
						`SELECT happened FROM ${table} WHERE ${scope} = ? AND happened > ? ORDER BY happened ASC LIMIT ?`,
						value,
						now - windowMs,
						limit,
					)
					.toArray()
			: this.ctx.storage.sql
					.exec<TimeRow>(`SELECT happened FROM ${table} WHERE happened > ? ORDER BY happened ASC LIMIT ?`, now - windowMs, limit)
					.toArray();
		return rows.length < limit ? null : throttled('Demo usage limit reached', rows[0].happened + windowMs, now);
	}

	private async schedule(): Promise<void> {
		const nextRun = this.ctx.storage.sql
			.exec<{ [key: string]: SqlStorageValue; deadline: number | null }>('SELECT MIN(deadline) AS deadline FROM demo_runs')
			.one().deadline;
		const nextEnvironment = this.ctx.storage.sql
			.exec<{ [key: string]: SqlStorageValue; expiry: number | null }>('SELECT MIN(expires_at) AS expiry FROM demo_environments')
			.one().expiry;
		const nextSession = this.ctx.storage.sql
			.exec<{ [key: string]: SqlStorageValue; expiry: number | null }>('SELECT MIN(expires_at) AS expiry FROM sessions')
			.one().expiry;
		const next = Math.min(nextRun ?? Infinity, nextEnvironment ?? Infinity, nextSession ?? Infinity);
		if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, next));
		else await this.ctx.storage.deleteAlarm();
	}
}

function isOwner(value: string): boolean {
	return /^demo:[a-f0-9]{64}$/.test(value);
}
function invalid(): Rejection {
	return { ok: false, status: 401, error: 'Invalid demo reservation' };
}
function throttled(error: string, retryAt: number, now: number): Rejection {
	return { ok: false, status: 429, error, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000)) };
}
