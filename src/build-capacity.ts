/** Experimental lease/queue model for the disabled arbitrary-upload pipeline.
 * Public fixture quotas are enforced separately by PublicDemoCoordinator.
 */
import { DurableObject } from 'cloudflare:workers';

export const TOTAL_SANDBOX_SLOTS = 3;
export const MIN_LEASE_TTL_MS = 1_000;
export const MAX_LEASE_TTL_MS = 30 * 60_000;

export type CapacitySlots = 1 | 3;

export interface CapacityAcquireRequest {
	runId: string;
	ownerPrincipalId: string;
	slots: CapacitySlots;
	now: number;
	ttlMs: number;
}

export interface CapacityLease {
	runId: string;
	leaseId: string;
	ownerPrincipalId: string;
	slots: CapacitySlots;
	acquiredAt: number;
	expiresAt: number;
}

export interface CapacityQueuedRequest {
	runId: string;
	ownerPrincipalId: string;
	slots: CapacitySlots;
	position: number;
	requestedAt: number;
	expiresAt: number;
}

export type CapacityAcquireResult =
	{ status: 'granted'; lease: CapacityLease } | { status: 'queued'; position: number; retryAfterMs: number };

export type CapacityRenewResult = { status: 'renewed'; lease: CapacityLease } | { status: 'lost' };

export interface CapacityInspection {
	totalSlots: number;
	usedSlots: number;
	availableSlots: number;
	leases: CapacityLease[];
	queue: CapacityQueuedRequest[];
	nextExpiryAt: number | null;
}

interface LeaseRow {
	[key: string]: SqlStorageValue;
	run_id: string;
	lease_id: string;
	owner_principal_id: string;
	slots: CapacitySlots;
	acquired_at: number;
	expires_at: number;
}

interface QueueRow {
	[key: string]: SqlStorageValue;
	sequence: number;
	run_id: string;
	owner_principal_id: string;
	slots: CapacitySlots;
	ttl_ms: number;
	requested_at: number;
	expires_at: number;
}

interface NumberRow {
	[key: string]: SqlStorageValue;
	value: number;
}

interface ExpiryRow {
	[key: string]: SqlStorageValue;
	expires_at: number | null;
}

/** Durable leases for candidate builds; not connected to the hosted fixture API. */
export class CapacityDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS capacity_leases (
				run_id TEXT PRIMARY KEY,
				lease_id TEXT NOT NULL UNIQUE,
				owner_principal_id TEXT NOT NULL,
				slots INTEGER NOT NULL CHECK (slots IN (1, 3)),
				acquired_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS capacity_leases_by_expiry
				ON capacity_leases (expires_at);
			CREATE TABLE IF NOT EXISTS capacity_queue (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL UNIQUE,
				owner_principal_id TEXT NOT NULL,
				slots INTEGER NOT NULL CHECK (slots IN (1, 3)),
				ttl_ms INTEGER NOT NULL,
				requested_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS capacity_queue_by_expiry
				ON capacity_queue (expires_at);
		`);
	}

	async acquire(input: CapacityAcquireRequest): Promise<CapacityAcquireResult> {
		const request = validateCapacityAcquireRequest(input);
		let decision: CapacityAcquireResult | undefined;

		this.ctx.storage.transactionSync(() => {
			this.expire(request.now);

			const active = this.readLease(request.runId);
			if (active) {
				this.assertSameRequest(active, request);
				decision = { status: 'granted', lease: toLease(active) };
				return;
			}

			let queued = this.readQueuedRequest(request.runId);
			if (queued) {
				this.assertSameRequest(queued, request);
			} else {
				queued = this.ctx.storage.sql
					.exec<QueueRow>(
						`INSERT INTO capacity_queue
							(run_id, owner_principal_id, slots, ttl_ms, requested_at, expires_at)
						 VALUES (?, ?, ?, ?, ?, ?)
						 RETURNING *`,
						request.runId,
						request.ownerPrincipalId,
						request.slots,
						request.ttlMs,
						request.now,
						request.now + request.ttlMs,
					)
					.one();
			}

			const position = this.queuePosition(queued.sequence);
			if (canGrantCapacity(position, this.usedSlots(), queued.slots)) {
				const lease: CapacityLease = {
					runId: queued.run_id,
					leaseId: crypto.randomUUID(),
					ownerPrincipalId: queued.owner_principal_id,
					slots: queued.slots,
					acquiredAt: request.now,
					expiresAt: request.now + queued.ttl_ms,
				};
				this.ctx.storage.sql.exec('DELETE FROM capacity_queue WHERE run_id = ?', queued.run_id);
				this.ctx.storage.sql.exec(
					`INSERT INTO capacity_leases
						(run_id, lease_id, owner_principal_id, slots, acquired_at, expires_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					lease.runId,
					lease.leaseId,
					lease.ownerPrincipalId,
					lease.slots,
					lease.acquiredAt,
					lease.expiresAt,
				);
				decision = { status: 'granted', lease };
				return;
			}

			decision = {
				status: 'queued',
				position,
				retryAfterMs: capacityRetryAfterMs(request.now, this.expiryTimes()),
			};
		});

		await this.scheduleNextAlarm();
		if (!decision) throw new Error('Capacity decision was not produced');
		return decision;
	}

	async release(runId: string, leaseId: string): Promise<void> {
		const normalizedRunId = validateUuid(runId, 'runId');
		const normalizedLeaseId = validateUuid(leaseId, 'leaseId');
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.expire(now);
			this.ctx.storage.sql.exec('DELETE FROM capacity_leases WHERE run_id = ? AND lease_id = ?', normalizedRunId, normalizedLeaseId);
		});
		await this.scheduleNextAlarm();
	}

	async renew(runId: string, leaseId: string, now: number, ttlMs: number): Promise<CapacityRenewResult> {
		const normalizedRunId = validateUuid(runId, 'runId');
		const normalizedLeaseId = validateUuid(leaseId, 'leaseId');
		validateTime(now, ttlMs);
		let lease: CapacityLease | null = null;

		this.ctx.storage.transactionSync(() => {
			this.expire(now);
			const row = this.ctx.storage.sql
				.exec<LeaseRow>(
					`UPDATE capacity_leases
					 SET expires_at = MAX(expires_at, ?)
					 WHERE run_id = ? AND lease_id = ?
					 RETURNING *`,
					now + ttlMs,
					normalizedRunId,
					normalizedLeaseId,
				)
				.toArray()[0];
			lease = row ? toLease(row) : null;
		});

		await this.scheduleNextAlarm();
		return lease ? { status: 'renewed', lease } : { status: 'lost' };
	}

	async inspect(now = Date.now()): Promise<CapacityInspection> {
		validateEpochMilliseconds(now, 'now');
		let inspection: CapacityInspection | undefined;

		this.ctx.storage.transactionSync(() => {
			this.expire(now);
			const leases = this.ctx.storage.sql
				.exec<LeaseRow>('SELECT * FROM capacity_leases ORDER BY acquired_at ASC, run_id ASC')
				.toArray()
				.map(toLease);
			const queue = this.ctx.storage.sql
				.exec<QueueRow>('SELECT * FROM capacity_queue ORDER BY sequence ASC')
				.toArray()
				.map((row, index) => toQueuedRequest(row, index + 1));
			const usedSlots = leases.reduce((total, item) => total + item.slots, 0);
			const expiries = [...leases.map((item) => item.expiresAt), ...queue.map((item) => item.expiresAt)];
			inspection = {
				totalSlots: TOTAL_SANDBOX_SLOTS,
				usedSlots,
				availableSlots: Math.max(0, TOTAL_SANDBOX_SLOTS - usedSlots),
				leases,
				queue,
				nextExpiryAt: nextCapacityExpiryAt(expiries, now),
			};
		});

		await this.scheduleNextAlarm();
		if (!inspection) throw new Error('Capacity inspection was not produced');
		return inspection;
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		this.ctx.storage.transactionSync(() => this.expire(now));
		await this.scheduleNextAlarm();
	}

	private expire(now: number): void {
		this.ctx.storage.sql.exec('DELETE FROM capacity_leases WHERE expires_at <= ?', now);
		this.ctx.storage.sql.exec('DELETE FROM capacity_queue WHERE expires_at <= ?', now);
	}

	private readLease(runId: string): LeaseRow | null {
		return this.ctx.storage.sql.exec<LeaseRow>('SELECT * FROM capacity_leases WHERE run_id = ?', runId).toArray()[0] ?? null;
	}

	private readQueuedRequest(runId: string): QueueRow | null {
		return this.ctx.storage.sql.exec<QueueRow>('SELECT * FROM capacity_queue WHERE run_id = ?', runId).toArray()[0] ?? null;
	}

	private assertSameRequest(row: LeaseRow | QueueRow, request: CapacityAcquireRequest): void {
		if (row.owner_principal_id !== request.ownerPrincipalId || row.slots !== request.slots) {
			throw new Error('runId already belongs to a different capacity request');
		}
	}

	private usedSlots(): number {
		return this.ctx.storage.sql.exec<NumberRow>('SELECT COALESCE(SUM(slots), 0) AS value FROM capacity_leases').one().value;
	}

	private queuePosition(sequence: number): number {
		return this.ctx.storage.sql.exec<NumberRow>('SELECT COUNT(*) AS value FROM capacity_queue WHERE sequence <= ?', sequence).one().value;
	}

	private expiryTimes(): number[] {
		return this.ctx.storage.sql
			.exec<{ [key: string]: SqlStorageValue; expires_at: number }>(
				`SELECT expires_at FROM capacity_leases
				 UNION ALL
				 SELECT expires_at FROM capacity_queue`,
			)
			.toArray()
			.map((row) => row.expires_at);
	}

	private async scheduleNextAlarm(): Promise<void> {
		const next = this.ctx.storage.sql
			.exec<ExpiryRow>(
				`SELECT MIN(expires_at) AS expires_at
				 FROM (
					SELECT expires_at FROM capacity_leases
					UNION ALL
					SELECT expires_at FROM capacity_queue
				 )`,
			)
			.one().expires_at;
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(next);
	}
}

export function validateCapacityAcquireRequest(input: CapacityAcquireRequest): CapacityAcquireRequest {
	if (!input || typeof input !== 'object') throw new TypeError('Capacity request is required');
	const runId = validateUuid(input.runId, 'runId');
	if (typeof input.ownerPrincipalId !== 'string' || !input.ownerPrincipalId.trim()) {
		throw new TypeError('ownerPrincipalId must be nonempty');
	}
	if (input.slots !== 1 && input.slots !== 3) throw new RangeError('slots must be 1 or 3');
	validateTime(input.now, input.ttlMs);
	return { ...input, runId, ownerPrincipalId: input.ownerPrincipalId.trim() };
}

export function canGrantCapacity(position: number, usedSlots: number, requestedSlots: CapacitySlots): boolean {
	return position === 1 && Number.isInteger(usedSlots) && usedSlots >= 0 && usedSlots + requestedSlots <= TOTAL_SANDBOX_SLOTS;
}

export function nextCapacityExpiryAt(expiryTimes: readonly number[], now: number): number | null {
	let next: number | null = null;
	for (const expiry of expiryTimes) {
		if (!Number.isSafeInteger(expiry) || expiry <= now) continue;
		if (next === null || expiry < next) next = expiry;
	}
	return next;
}

export function capacityRetryAfterMs(now: number, expiryTimes: readonly number[]): number {
	const next = nextCapacityExpiryAt(expiryTimes, now);
	return next === null ? 1 : Math.max(1, next - now);
}

function validateTime(now: number, ttlMs: number): void {
	validateEpochMilliseconds(now, 'now');
	if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
		throw new RangeError(`ttlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}`);
	}
	if (!Number.isSafeInteger(now + ttlMs)) throw new RangeError('now plus ttlMs is outside the supported range');
}

function validateEpochMilliseconds(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be nonnegative epoch milliseconds`);
}

function validateUuid(value: string, name: string): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new TypeError(`${name} must be a UUID`);
	}
	return value.toLowerCase();
}

function toLease(row: LeaseRow): CapacityLease {
	return {
		runId: row.run_id,
		leaseId: row.lease_id,
		ownerPrincipalId: row.owner_principal_id,
		slots: row.slots,
		acquiredAt: row.acquired_at,
		expiresAt: row.expires_at,
	};
}

function toQueuedRequest(row: QueueRow, position: number): CapacityQueuedRequest {
	return {
		runId: row.run_id,
		ownerPrincipalId: row.owner_principal_id,
		slots: row.slots,
		position,
		requestedAt: row.requested_at,
		expiresAt: row.expires_at,
	};
}
