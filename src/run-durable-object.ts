/** Per-run SQLite state and hibernating WebSocket event delivery. */
import { DurableObject } from 'cloudflare:workers';
import { buildRunComparison } from './comparison';
import {
	applyRunPatch,
	publicRunSnapshot,
	type RunEvent,
	type RunEventInput,
	type RunEventPage,
	type RunPatch,
	type RunSnapshot,
} from './domain';

const EVENT_PAGE_SIZE = 200;
const RUN_HISTORY_RETENTION_MS = 2 * 60 * 60_000;
const RETENTION_RETRY_MS = 30_000;

interface SnapshotRow {
	[key: string]: SqlStorageValue;
	payload: string;
}

interface EventRow {
	[key: string]: SqlStorageValue;
	seq: number;
	event_key: string;
	timestamp: string;
	type: string;
	level: RunEvent['level'];
	stage: RunEvent['stage'];
	message: string;
}

/** A run ID selects its own Durable Object; the parent Worker checks visitor
 * ownership before accessing it, while the internal WebSocket hop rechecks.
 */
export class RunDurableObject extends DurableObject<Env> {
	private historyDeleted = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS run_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				payload TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS run_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				event_key TEXT NOT NULL UNIQUE,
				timestamp TEXT NOT NULL,
				type TEXT NOT NULL,
				level TEXT NOT NULL,
				stage TEXT,
				message TEXT NOT NULL
			);
		`);
	}

	async initialize(snapshot: RunSnapshot): Promise<RunSnapshot> {
		if (this.historyDeleted) throw new Error('Run history has expired');
		const existing = this.readSnapshot();
		if (existing) return existing;

		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec('INSERT OR IGNORE INTO run_state (id, payload) VALUES (1, ?)', JSON.stringify(snapshot));
			this.ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO run_events
					(event_key, timestamp, type, level, stage, message)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				'run:created',
				snapshot.createdAt,
				'run.created',
				'info',
				null,
				'Compatibility run queued',
			);
		});

		return this.requireSnapshot();
	}

	async getSnapshot(): Promise<RunSnapshot | null> {
		return this.readSnapshot();
	}

	async getEvents(after = 0): Promise<RunEventPage> {
		const safeAfter = Math.max(0, Math.floor(after));
		if (this.historyDeleted) return { events: [], nextAfter: safeAfter, hasMore: false };
		const rows = this.ctx.storage.sql
			.exec<EventRow>(
				`SELECT seq, event_key, timestamp, type, level, stage, message
				 FROM run_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
				safeAfter,
				EVENT_PAGE_SIZE + 1,
			)
			.toArray();
		const events = rows.slice(0, EVENT_PAGE_SIZE).map(toRunEvent);
		return {
			events,
			nextAfter: events.at(-1)?.seq ?? safeAfter,
			hasMore: rows.length > EVENT_PAGE_SIZE,
		};
	}

	async cancel(timestamp: string): Promise<RunSnapshot> {
		const snapshot = this.requireSnapshot();
		if (snapshot.status === 'cancelled' || snapshot.status === 'failed') return snapshot;

		const activeStage = Object.values(snapshot.stages).find((stage) => stage.status === 'running' || stage.status === 'retrying');
		const patch: RunPatch = {
			status: 'cancelled',
			previewPath: null,
			previewProcessId: null,
			previewPort: null,
		};
		if (activeStage) {
			patch.stage = {
				name: activeStage.name,
				status: 'cancelled',
				completedAt: timestamp,
				summary: 'Cancelled by user',
			};
		} else if (snapshot.stages.publish.status === 'passed') {
			patch.stage = { name: 'publish', summary: 'Live preview was stopped' };
		}

		return (
			await this.record(
				{
					key: 'run:cancelled',
					timestamp,
					type: 'run.cancelled',
					level: 'warning',
					stage: null,
					message: 'Cancellation requested; releasing Sandbox resources',
				},
				patch,
			)
		).snapshot;
	}

	async markSandboxDestroyed(timestamp: string, reason: string): Promise<RunSnapshot> {
		const snapshot = this.requireSnapshot();
		if (snapshot.sandboxDestroyedAt) return snapshot;

		return (
			await this.record(
				{
					key: `sandbox:destroyed:${reason}`,
					timestamp,
					type: 'sandbox.destroyed',
					level: 'info',
					stage: null,
					message: 'Sandbox resources released',
				},
				{ sandboxDestroyedAt: timestamp },
			)
		).snapshot;
	}

	/** Called by the demo coordinator before it releases a Sandbox reservation.
	 * Keep run history briefly for the visitor, but never expire a live Sandbox record.
	 */
	async expireAfterTeardown(): Promise<boolean> {
		const snapshot = this.readSnapshot();
		if (snapshot && !snapshot.sandboxDestroyedAt) return false;
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + RUN_HISTORY_RETENTION_MS);
		}
		return true;
	}

	async alarm(): Promise<void> {
		const snapshot = this.readSnapshot();
		if (snapshot && !snapshot.sandboxDestroyedAt) {
			// An unexpected state must not discard evidence needed by cleanup.
			await this.ctx.storage.setAlarm(Date.now() + RETENTION_RETRY_MS);
			return;
		}
		for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'Run history expired');
		await this.ctx.storage.deleteAll();
		this.historyDeleted = true;
	}

	async record(eventInput: RunEventInput, patch: RunPatch = {}): Promise<{ snapshot: RunSnapshot; event: RunEvent | null }> {
		let event: RunEvent | null = null;
		let snapshot = this.requireSnapshot();
		const hasPatch = Object.keys(patch).length > 0;

		this.ctx.storage.transactionSync(() => {
			if (
				(snapshot.status === 'succeeded' || snapshot.status === 'failed') &&
				!['run.cancelled', 'preview.expired', 'sandbox.destroyed'].includes(eventInput.type)
			) {
				return;
			}
			if (snapshot.status === 'cancelled' && !['run.cancelled', 'sandbox.destroyed'].includes(eventInput.type)) return;

			const insertedRows = this.ctx.storage.sql
				.exec<{ [key: string]: SqlStorageValue; seq: number }>(
					`INSERT INTO run_events
					(event_key, timestamp, type, level, stage, message)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(event_key) DO NOTHING
				 RETURNING seq`,
					eventInput.key,
					eventInput.timestamp,
					eventInput.type,
					eventInput.level,
					eventInput.stage,
					eventInput.message,
				)
				.toArray();

			if (insertedRows.length === 0) return;

			event = { seq: insertedRows[0].seq, ...eventInput };
			if (hasPatch) {
				snapshot = applyRunPatch(snapshot, patch, eventInput.timestamp);
				this.ctx.storage.sql.exec('UPDATE run_state SET payload = ? WHERE id = 1', JSON.stringify(snapshot));
			}
		});

		if (event) {
			this.broadcast({
				type: 'event',
				event,
				snapshot,
				...(hasPatch ? { comparison: buildRunComparison(snapshot) } : {}),
			});
		}
		return { snapshot, event };
	}

	async fetch(request: Request): Promise<Response> {
		const snapshot = this.readSnapshot();
		if (!snapshot || request.headers.get('X-Compatibility-Run-Owner') !== snapshot.ownerPrincipalId) {
			return new Response('Run not found', { status: 404 });
		}
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		const page = await this.getEvents();
		server.send(
			JSON.stringify({ type: 'snapshot', snapshot: publicRunSnapshot(snapshot), comparison: buildRunComparison(snapshot), ...page }),
		);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (message === 'ping') ws.send('pong');
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
		ws.close(code, reason);
	}

	async webSocketError(ws: WebSocket) {
		ws.close(1011, 'Run event stream failed');
	}

	private readSnapshot(): RunSnapshot | null {
		if (this.historyDeleted) return null;
		const row = this.ctx.storage.sql.exec<SnapshotRow>('SELECT payload FROM run_state WHERE id = 1').toArray()[0];
		return row ? (JSON.parse(row.payload) as RunSnapshot) : null;
	}

	private requireSnapshot(): RunSnapshot {
		const snapshot = this.readSnapshot();
		if (!snapshot) throw new Error('Run has not been initialized');
		return snapshot;
	}

	private broadcast(payload: unknown) {
		const message = JSON.stringify(sanitizeBroadcastPayload(payload));
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch (error) {
				console.warn(JSON.stringify({ event: 'run.websocket.send_failed', error }));
			}
		}
	}
}

function sanitizeBroadcastPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) return payload;
	const value = payload as { snapshot?: RunSnapshot | null } & Record<string, unknown>;
	return value.snapshot ? { ...value, snapshot: publicRunSnapshot(value.snapshot) } : value;
}

function toRunEvent(row: EventRow): RunEvent {
	return {
		seq: row.seq,
		key: row.event_key,
		timestamp: row.timestamp,
		type: row.type,
		level: row.level,
		stage: row.stage,
		message: row.message,
	};
}
