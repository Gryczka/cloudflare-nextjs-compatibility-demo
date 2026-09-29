/** Durable state machine for the disabled arbitrary-upload prototype. */
import { DurableObject } from 'cloudflare:workers';
import {
	UPLOAD_CANDIDATES,
	UploadRunDomainError,
	allUploadCandidatesTerminal,
	applyBeginFinalization,
	applyCompleteCleanup,
	applyCompleteDeployment,
	applyMarkCandidateStarted,
	applyMarkDeploying,
	applyMarkPrepared,
	applyRecordPromotionFailure,
	applyRegisterResource,
	applyReleaseResource,
	applyReportCandidate,
	applyRequestCancellation,
	applyStartPreparing,
	normalizeInitialUploadRun,
	publicUploadRunEvent,
	publicUploadRunSnapshot,
	sameUploadRunIdentity,
	validateBeginFinalizationInput,
	validateCompleteCleanupInput,
	validateCompleteDeploymentInput,
	validateMarkCandidateStartedInput,
	validateMarkDeployingInput,
	validateMarkPreparedInput,
	validateMarkResourceReleasedInput,
	validateRecordPromotionFailureInput,
	validateRegisterResourceInput,
	validateReportCandidateInput,
	validateUploadMutationInput,
	type BeginFinalizationInput,
	type CandidateReportTransition,
	type CompleteCleanupInput,
	type CompleteDeploymentInput,
	type FinalizationTransition,
	type MarkCandidateStartedInput,
	type MarkDeployingInput,
	type MarkPreparedInput,
	type MarkResourceReleasedInput,
	type PromotionFailureTransition,
	type PublicUploadRunEvent,
	type PublicUploadRunSnapshot,
	type RecordPromotionFailureInput,
	type RegisterResourceInput,
	type ReportCandidateInput,
	type RequestCancellationInput,
	type ResourceTransition,
	type SnapshotTransition,
	type StartPreparingInput,
	type UploadRunEvent,
	type UploadRunEventLevel,
	type UploadRunEventPage,
	type UploadRunInitialization,
	type UploadRunResourceKind,
	type UploadRunResourceRecord,
	type UploadRunSnapshot,
} from './upload-domain';
import type { DeploymentTarget } from './domain';

export const UPLOAD_RUN_EVENT_PAGE_SIZE = 200;

export interface ReportCandidateResponse {
	snapshot: UploadRunSnapshot;
	accepted: boolean;
	provisionalChosen: boolean;
	provisionalTarget: DeploymentTarget | null;
	allCandidatesTerminal: boolean;
}

export interface BeginFinalizationResponse {
	snapshot: UploadRunSnapshot;
	changed: boolean;
	selectedTarget: DeploymentTarget | null;
	timedOutCandidates: DeploymentTarget[];
}

export interface PromotionFailureResponse {
	snapshot: UploadRunSnapshot;
	changed: boolean;
	nextTarget: DeploymentTarget | null;
}

export interface ResourceMutationResponse {
	snapshot: UploadRunSnapshot;
	changed: boolean;
	resource: UploadRunResourceRecord | null;
}

export interface PublicUploadRunEventPage {
	events: PublicUploadRunEvent[];
	nextAfter: number;
	hasMore: boolean;
}

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
	level: UploadRunEventLevel;
	candidate: DeploymentTarget | null;
	message: string;
}

interface ResourceRow {
	[key: string]: SqlStorageValue;
	resource_id: string;
	kind: UploadRunResourceKind;
	candidate: DeploymentTarget | null;
	generation: number;
	source_hash: string | null;
	registered_at: string;
	released_at: string | null;
	release_reason: string | null;
	details: string;
}

type PendingEvent = Omit<UploadRunEvent, 'seq'>;
type MutationResult<T extends SnapshotTransition> = { transition: T; events: UploadRunEvent[] };

export class UploadRunDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS upload_run_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				payload TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS upload_run_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				event_key TEXT NOT NULL UNIQUE,
				timestamp TEXT NOT NULL,
				type TEXT NOT NULL,
				level TEXT NOT NULL,
				candidate TEXT,
				message TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS upload_run_events_by_candidate
				ON upload_run_events (candidate, seq);
			CREATE TABLE IF NOT EXISTS upload_run_resources (
				resource_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				candidate TEXT,
				generation INTEGER NOT NULL,
				source_hash TEXT,
				registered_at TEXT NOT NULL,
				released_at TEXT,
				release_reason TEXT,
				details TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS upload_run_resources_by_release
				ON upload_run_resources (released_at, registered_at);
		`);
	}

	async initialize(input: UploadRunInitialization | UploadRunSnapshot): Promise<UploadRunSnapshot> {
		const initial = normalizeInitialUploadRun(input);
		let snapshot = initial;
		let event: UploadRunEvent | null = null;

		this.ctx.storage.transactionSync(() => {
			const existing = this.readSnapshot();
			if (existing) {
				if (!sameUploadRunIdentity(existing, initial)) {
					throw new UploadRunDomainError('CONFLICT', 'upload run was already initialized with different immutable fields');
				}
				snapshot = existing;
				return;
			}

			this.ctx.storage.sql.exec('INSERT INTO upload_run_state (id, payload) VALUES (1, ?)', JSON.stringify(initial));
			event = this.insertEvent({
				key: 'run:created',
				timestamp: initial.createdAt,
				type: 'run.created',
				level: 'info',
				candidate: null,
				message: 'Upload run queued',
			});
		});

		if (event) this.broadcast(snapshot, [event]);
		return snapshot;
	}

	async getSnapshot(): Promise<UploadRunSnapshot | null> {
		return this.readSnapshot();
	}

	async getPublicSnapshot(ownerPrincipalId: string): Promise<PublicUploadRunSnapshot | null> {
		const snapshot = this.readSnapshot();
		return snapshot && ownerMatches(snapshot, ownerPrincipalId) ? publicUploadRunSnapshot(snapshot) : null;
	}

	async getEvents(after = 0): Promise<UploadRunEventPage> {
		if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a nonnegative safe integer');
		return this.readEvents(after);
	}

	async getPublicEvents(ownerPrincipalId: string, after = 0): Promise<PublicUploadRunEventPage | null> {
		if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a nonnegative safe integer');
		const snapshot = this.readSnapshot();
		if (!snapshot || !ownerMatches(snapshot, ownerPrincipalId)) return null;
		const page = this.readEvents(after);
		return { ...page, events: page.events.map(publicUploadRunEvent) };
	}

	async startPreparing(input: StartPreparingInput): Promise<UploadRunSnapshot> {
		const request = validateUploadMutationInput(input);
		return this.mutate(
			request.idempotencyKey,
			(snapshot) => applyStartPreparing(snapshot, request),
			(snapshot) => ({ snapshot, changed: false }),
			() => [event(request.idempotencyKey, request.timestamp, 'run.preparing', 'info', null, 'Preparing uploaded source')],
		).transition.snapshot;
	}

	async markPrepared(input: MarkPreparedInput): Promise<UploadRunSnapshot> {
		const request = validateMarkPreparedInput(input);
		return this.mutate(
			request.idempotencyKey,
			(snapshot) => applyMarkPrepared(snapshot, request),
			(snapshot) => ({ snapshot, changed: false }),
			() => [
				event(request.idempotencyKey, request.timestamp, 'run.prepared', 'info', null, 'Uploaded source prepared'),
				...UPLOAD_CANDIDATES.map((target) =>
					event(
						`${request.idempotencyKey}:candidate:${target}`,
						request.timestamp,
						'candidate.queued',
						'info',
						target,
						`${target} candidate queued`,
					),
				),
			],
		).transition.snapshot;
	}

	async markCandidateStarted(input: MarkCandidateStartedInput): Promise<UploadRunSnapshot> {
		const request = validateMarkCandidateStartedInput(input);
		return this.mutate(
			request.idempotencyKey,
			(snapshot) => applyMarkCandidateStarted(snapshot, request),
			(snapshot) => ({ snapshot, changed: false }),
			() => [
				event(
					request.idempotencyKey,
					request.timestamp,
					`candidate.${request.status}`,
					'info',
					request.target,
					`${request.target} ${request.status} attempt ${request.attempt}`,
				),
			],
		).transition.snapshot;
	}

	async reportCandidate(input: ReportCandidateInput): Promise<ReportCandidateResponse> {
		const request = validateReportCandidateInput(input);
		const result = this.mutate<CandidateReportTransition>(
			request.idempotencyKey,
			(snapshot) => applyReportCandidate(snapshot, request),
			(snapshot) => ({
				snapshot,
				changed: false,
				provisionalChosen: false,
				allCandidatesTerminal: allUploadCandidatesTerminal(snapshot),
			}),
			(transition) => [
				event(
					request.idempotencyKey,
					request.timestamp,
					`candidate.${request.result.status}`,
					candidateResultLevel(request.result.status),
					request.target,
					request.result.summary,
				),
				...(transition.provisionalChosen
					? [
							event(
								`${request.idempotencyKey}:provisional`,
								request.timestamp,
								'provisional.live',
								'success',
								request.target,
								`${request.target} became the first live provisional candidate`,
							),
						]
					: []),
			],
		);
		return {
			snapshot: result.transition.snapshot,
			accepted: result.transition.changed,
			provisionalChosen: result.transition.provisionalChosen,
			provisionalTarget: result.transition.snapshot.provisional.target,
			allCandidatesTerminal: result.transition.allCandidatesTerminal,
		};
	}

	async beginFinalization(input: BeginFinalizationInput): Promise<BeginFinalizationResponse> {
		const request = validateBeginFinalizationInput(input);
		const result = this.mutate<FinalizationTransition>(
			request.idempotencyKey,
			(snapshot) => applyBeginFinalization(snapshot, request),
			(snapshot) => ({
				snapshot,
				changed: false,
				selectedTarget: snapshot.selection.selectedTarget,
				timedOutCandidates: [],
			}),
			(transition) => [
				event(
					request.idempotencyKey,
					request.timestamp,
					transition.selectedTarget ? 'selection.completed' : 'selection.exhausted',
					transition.selectedTarget ? 'success' : 'error',
					null,
					transition.selectedTarget
						? `${transition.selectedTarget} selected for final deployment`
						: 'No candidate is eligible for deployment',
				),
				...transition.timedOutCandidates.map((target) =>
					event(
						`${request.idempotencyKey}:timed-out:${target}`,
						request.timestamp,
						'candidate.timed_out',
						'warning',
						target,
						`${target} timed out during forced finalization`,
					),
				),
			],
		);
		return {
			snapshot: result.transition.snapshot,
			changed: result.transition.changed,
			selectedTarget: result.transition.selectedTarget,
			timedOutCandidates: result.transition.timedOutCandidates,
		};
	}

	async markDeploying(input: MarkDeployingInput): Promise<UploadRunSnapshot> {
		const request = validateMarkDeployingInput(input);
		return this.mutate(
			request.idempotencyKey,
			(snapshot) => applyMarkDeploying(snapshot, request),
			(snapshot) => ({ snapshot, changed: false }),
			() => [
				event(
					request.idempotencyKey,
					request.timestamp,
					'deployment.started',
					'info',
					request.target,
					`${request.target} final deployment started`,
				),
			],
		).transition.snapshot;
	}

	async completeDeployment(input: CompleteDeploymentInput): Promise<UploadRunSnapshot> {
		const request = validateCompleteDeploymentInput(input);
		return this.mutate(
			request.idempotencyKey,
			(snapshot) => applyCompleteDeployment(snapshot, request),
			(snapshot) => ({ snapshot, changed: false }),
			() => [
				event(
					request.idempotencyKey,
					request.timestamp,
					'deployment.succeeded',
					'success',
					request.target,
					`${request.target} final deployment completed`,
				),
			],
		).transition.snapshot;
	}

	async recordPromotionFailure(input: RecordPromotionFailureInput): Promise<PromotionFailureResponse> {
		const request = validateRecordPromotionFailureInput(input);
		const result = this.mutate<PromotionFailureTransition>(
			request.idempotencyKey,
			(snapshot) => applyRecordPromotionFailure(snapshot, request),
			(snapshot) => ({ snapshot, changed: false, nextTarget: snapshot.selection.selectedTarget }),
			(transition) => [
				event(
					request.idempotencyKey,
					request.timestamp,
					'deployment.failed',
					'error',
					request.target,
					transition.nextTarget ? `${request.target} promotion failed; ${transition.nextTarget} will be tried next` : request.reason,
				),
			],
		);
		return {
			snapshot: result.transition.snapshot,
			changed: result.transition.changed,
			nextTarget: result.transition.nextTarget,
		};
	}

	async requestCancellation(input: RequestCancellationInput): Promise<UploadRunSnapshot> {
		const request = validateUploadMutationInput(input);
		return this.mutate(
			request.idempotencyKey,
			(snapshot) => applyRequestCancellation(snapshot, request),
			(snapshot) => ({ snapshot, changed: false, cancelledCandidates: [] }),
			(transition) => [
				event(request.idempotencyKey, request.timestamp, 'run.cancelling', 'warning', null, 'Run cancellation requested'),
				...transition.cancelledCandidates.map((target) =>
					event(
						`${request.idempotencyKey}:candidate:${target}`,
						request.timestamp,
						'candidate.cancelled',
						'warning',
						target,
						`${target} cancelled`,
					),
				),
			],
		).transition.snapshot;
	}

	async completeCleanup(input: CompleteCleanupInput): Promise<UploadRunSnapshot> {
		const request = validateCompleteCleanupInput(input);
		return this.mutate(
			request.idempotencyKey,
			(snapshot) => applyCompleteCleanup(snapshot, request),
			(snapshot) => ({ snapshot, changed: false }),
			() => [event(request.idempotencyKey, request.timestamp, 'cleanup.completed', 'info', null, 'Run resources released')],
		).transition.snapshot;
	}

	async registerResource(input: RegisterResourceInput): Promise<ResourceMutationResponse> {
		const request = validateRegisterResourceInput(input);
		const outcome: { transition: ResourceTransition | null; events: UploadRunEvent[] } = { transition: null, events: [] };

		this.ctx.storage.transactionSync(() => {
			const snapshot = this.requireSnapshot();
			const existing = this.readResource(request.resourceId);
			if (this.hasEvent(request.idempotencyKey)) {
				outcome.transition = existing ? { snapshot, changed: false, resource: existing } : null;
				return;
			}
			const transition = applyRegisterResource(snapshot, existing, request);
			outcome.transition = transition;
			if (!transition.changed) return;
			this.ctx.storage.sql.exec(
				`INSERT INTO upload_run_resources
					(resource_id, kind, candidate, generation, source_hash, registered_at, released_at, release_reason, details)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				transition.resource.resourceId,
				transition.resource.kind,
				transition.resource.candidate,
				transition.resource.generation,
				transition.resource.sourceHash,
				transition.resource.registeredAt,
				transition.resource.releasedAt,
				transition.resource.releaseReason,
				JSON.stringify(transition.resource.details),
			);
			this.writeSnapshot(transition.snapshot);
			outcome.events = [
				this.insertEvent(
					event(
						request.idempotencyKey,
						request.timestamp,
						'resource.registered',
						'info',
						transition.resource.candidate,
						`${transition.resource.kind} resource registered`,
					),
				),
			];
		});

		const transition = outcome.transition;
		const snapshot = transition?.snapshot ?? this.requireSnapshot();
		if (transition?.changed) this.broadcast(snapshot, outcome.events);
		return { snapshot, changed: transition?.changed ?? false, resource: transition?.resource ?? this.readResource(request.resourceId) };
	}

	async markResourceReleased(input: MarkResourceReleasedInput): Promise<ResourceMutationResponse> {
		const request = validateMarkResourceReleasedInput(input);
		const outcome: { transition: ResourceTransition | null; events: UploadRunEvent[] } = { transition: null, events: [] };

		this.ctx.storage.transactionSync(() => {
			const snapshot = this.requireSnapshot();
			const existing = this.readResource(request.resourceId);
			if (this.hasEvent(request.idempotencyKey)) {
				outcome.transition = existing ? { snapshot, changed: false, resource: existing } : null;
				return;
			}
			if (!existing) throw new UploadRunDomainError('INVALID_INPUT', `resource ${request.resourceId} is not registered`);
			const transition = applyReleaseResource(snapshot, existing, request);
			outcome.transition = transition;
			if (!transition.changed) return;
			this.ctx.storage.sql.exec(
				`UPDATE upload_run_resources
				 SET released_at = ?, release_reason = ?
				 WHERE resource_id = ?`,
				transition.resource.releasedAt,
				transition.resource.releaseReason,
				transition.resource.resourceId,
			);
			this.writeSnapshot(transition.snapshot);
			outcome.events = [
				this.insertEvent(
					event(
						request.idempotencyKey,
						request.timestamp,
						'resource.released',
						'info',
						transition.resource.candidate,
						`${transition.resource.kind} resource released`,
					),
				),
			];
		});

		const transition = outcome.transition;
		const snapshot = transition?.snapshot ?? this.requireSnapshot();
		if (transition?.changed) this.broadcast(snapshot, outcome.events);
		return { snapshot, changed: transition?.changed ?? false, resource: transition?.resource ?? this.readResource(request.resourceId) };
	}

	async fetch(request: Request): Promise<Response> {
		const snapshot = this.readSnapshot();
		const rejection = uploadRunWebSocketRejection(request, snapshot);
		if (rejection) return rejection;
		if (!snapshot) return new Response('Run not found', { status: 404 });

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		const page = this.readEvents(0);
		server.send(
			JSON.stringify({
				type: 'snapshot',
				snapshot: publicUploadRunSnapshot(snapshot),
				events: page.events.map(publicUploadRunEvent),
				nextAfter: page.nextAfter,
				hasMore: page.hasMore,
			}),
		);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (message === 'ping') socket.send('pong');
	}

	async webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
		socket.close(code, reason);
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		socket.close(1011, 'Upload run event stream failed');
	}

	private mutate<T extends SnapshotTransition>(
		idempotencyKey: string,
		apply: (snapshot: UploadRunSnapshot) => T,
		duplicate: (snapshot: UploadRunSnapshot) => T,
		eventsFor: (transition: T) => PendingEvent[],
	): MutationResult<T> {
		const outcome: { transition: T | null; events: UploadRunEvent[] } = { transition: null, events: [] };

		this.ctx.storage.transactionSync(() => {
			const snapshot = this.requireSnapshot();
			if (this.hasEvent(idempotencyKey)) {
				outcome.transition = duplicate(snapshot);
				return;
			}
			const transition = apply(snapshot);
			outcome.transition = transition;
			if (!transition.changed) return;
			const pendingEvents = eventsFor(transition);
			if (pendingEvents.length === 0 || pendingEvents[0].key !== idempotencyKey) {
				throw new Error('A state mutation must record its idempotency event first');
			}
			this.writeSnapshot(transition.snapshot);
			outcome.events = pendingEvents.map((pending) => this.insertEvent(pending));
		});

		const transition = outcome.transition;
		if (!transition) throw new Error('Upload run mutation did not produce a result');
		if (transition.changed) this.broadcast(transition.snapshot, outcome.events);
		return { transition, events: outcome.events };
	}

	private readSnapshot(): UploadRunSnapshot | null {
		const row = this.ctx.storage.sql.exec<SnapshotRow>('SELECT payload FROM upload_run_state WHERE id = 1').toArray()[0];
		return row ? (JSON.parse(row.payload) as UploadRunSnapshot) : null;
	}

	private requireSnapshot(): UploadRunSnapshot {
		const snapshot = this.readSnapshot();
		if (!snapshot) throw new UploadRunDomainError('INVALID_TRANSITION', 'upload run has not been initialized');
		return snapshot;
	}

	private writeSnapshot(snapshot: UploadRunSnapshot): void {
		this.ctx.storage.sql.exec('UPDATE upload_run_state SET payload = ? WHERE id = 1', JSON.stringify(snapshot));
	}

	private hasEvent(key: string): boolean {
		return this.ctx.storage.sql.exec('SELECT 1 FROM upload_run_events WHERE event_key = ?', key).toArray().length !== 0;
	}

	private insertEvent(input: PendingEvent): UploadRunEvent {
		const row = this.ctx.storage.sql
			.exec<{ [key: string]: SqlStorageValue; seq: number }>(
				`INSERT INTO upload_run_events
					(event_key, timestamp, type, level, candidate, message)
				 VALUES (?, ?, ?, ?, ?, ?)
				 RETURNING seq`,
				input.key,
				input.timestamp,
				input.type,
				input.level,
				input.candidate,
				input.message,
			)
			.one();
		return { seq: row.seq, ...input };
	}

	private readEvents(after: number): UploadRunEventPage {
		const rows = this.ctx.storage.sql
			.exec<EventRow>(
				`SELECT seq, event_key, timestamp, type, level, candidate, message
				 FROM upload_run_events
				 WHERE seq > ?
				 ORDER BY seq ASC
				 LIMIT ?`,
				after,
				UPLOAD_RUN_EVENT_PAGE_SIZE + 1,
			)
			.toArray();
		const events = rows.slice(0, UPLOAD_RUN_EVENT_PAGE_SIZE).map(toEvent);
		return {
			events,
			nextAfter: events.at(-1)?.seq ?? after,
			hasMore: rows.length > UPLOAD_RUN_EVENT_PAGE_SIZE,
		};
	}

	private readResource(resourceId: string): UploadRunResourceRecord | null {
		const row = this.ctx.storage.sql.exec<ResourceRow>('SELECT * FROM upload_run_resources WHERE resource_id = ?', resourceId).toArray()[0];
		return row ? toResource(row) : null;
	}

	private broadcast(snapshot: UploadRunSnapshot, events: readonly UploadRunEvent[]): void {
		const message = JSON.stringify({
			type: 'state',
			snapshot: publicUploadRunSnapshot(snapshot),
			events: events.map(publicUploadRunEvent),
		});
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch (error) {
				console.warn(
					JSON.stringify({ event: 'upload_run.websocket.send_failed', error: error instanceof Error ? error.message : String(error) }),
				);
			}
		}
	}
}

export function uploadRunWebSocketRejection(request: Request, snapshot: UploadRunSnapshot | null): Response | null {
	if (!snapshot || request.headers.get('X-Compatibility-Run-Owner') !== snapshot.ownerPrincipalId) {
		return new Response('Run not found', { status: 404 });
	}
	if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return new Response('Expected a WebSocket upgrade', { status: 426 });
	}
	return null;
}

function event(
	key: string,
	timestamp: string,
	type: string,
	level: UploadRunEventLevel,
	candidate: DeploymentTarget | null,
	message: string,
): PendingEvent {
	return { key, timestamp, type, level, candidate, message };
}

function candidateResultLevel(status: ReportCandidateInput['result']['status']): UploadRunEventLevel {
	if (status === 'passed') return 'success';
	if (status === 'incompatible' || status === 'timed_out' || status === 'cancelled') return 'warning';
	return 'error';
}

function ownerMatches(snapshot: UploadRunSnapshot, ownerPrincipalId: string): boolean {
	return typeof ownerPrincipalId === 'string' && ownerPrincipalId.trim() !== '' && snapshot.ownerPrincipalId === ownerPrincipalId.trim();
}

function toEvent(row: EventRow): UploadRunEvent {
	return {
		seq: row.seq,
		key: row.event_key,
		timestamp: row.timestamp,
		type: row.type,
		level: row.level,
		candidate: row.candidate,
		message: row.message,
	};
}

function toResource(row: ResourceRow): UploadRunResourceRecord {
	return {
		resourceId: row.resource_id,
		kind: row.kind,
		candidate: row.candidate,
		generation: row.generation,
		sourceHash: row.source_hash,
		registeredAt: row.registered_at,
		releasedAt: row.released_at,
		releaseReason: row.release_reason,
		details: JSON.parse(row.details) as UploadRunResourceRecord['details'],
	};
}
