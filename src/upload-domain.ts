/** State-machine transitions for a future upload flow, intentionally not wired
 * to public HTTP routes or to the fixed-template Workers for Platforms publisher.
 */
import type { DeploymentTarget } from './domain';
import { selectFinalTarget, type FinalTargetSelection } from './selection';
import type { SourceManifest } from './source-archive';

export const UPLOAD_RUN_SCHEMA_VERSION = 1 as const;
export const UPLOAD_CANDIDATES = ['vinext', 'opennext', 'container'] as const satisfies readonly DeploymentTarget[];
export const UPLOAD_CANDIDATE_STATUSES = [
	'pending',
	'queued',
	'building',
	'verifying',
	'passed',
	'incompatible',
	'failed',
	'timed_out',
	'cancelled',
] as const;
export const UPLOAD_RUN_STATUSES = [
	'queued',
	'preparing',
	'running',
	'selecting',
	'deploying',
	'succeeded',
	'failed',
	'cancelling',
	'cancelled',
] as const;
export const MAX_UPLOAD_CANDIDATE_CHECKS = 64;
export const MAX_UPLOAD_CANDIDATE_ATTEMPTS = 20;

export type UploadCandidateStatus = (typeof UPLOAD_CANDIDATE_STATUSES)[number];
export type UploadCandidateTerminalStatus = Extract<
	UploadCandidateStatus,
	'passed' | 'incompatible' | 'failed' | 'timed_out' | 'cancelled'
>;
export type UploadRunStatus = (typeof UPLOAD_RUN_STATUSES)[number];
export type UploadCandidateProgressStatus = 'building' | 'verifying';
export type UploadRunEventLevel = 'info' | 'success' | 'warning' | 'error';
export type UploadRunResourceKind = 'source' | 'sandbox' | 'process' | 'port' | 'artifact' | 'deployment' | 'other';

export type UploadRunDomainErrorCode =
	| 'INVALID_INPUT'
	| 'INVALID_TRANSITION'
	| 'STALE_GENERATION'
	| 'SOURCE_HASH_MISMATCH'
	| 'ARTIFACT_DIGEST_MISMATCH'
	| 'CONFLICT'
	| 'CANDIDATES_ACTIVE'
	| 'RESOURCES_ACTIVE';

export class UploadRunDomainError extends Error {
	constructor(
		readonly code: UploadRunDomainErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'UploadRunDomainError';
	}
}

export interface UploadRunInitialization {
	runId: string;
	ownerPrincipalId: string;
	requestedBy: string;
	siteId: string;
	siteHostname: string;
	generation: number;
	sourceR2Key: string;
	createdAt: string;
}

export interface UploadCandidateCheck {
	name: string;
	status: 'passed' | 'failed' | 'advisory';
	detail: string;
	durationMs: number;
}

export interface UploadCandidateSnapshot {
	target: DeploymentTarget;
	status: UploadCandidateStatus;
	attempts: number;
	queuedAt: string | null;
	startedAt: string | null;
	verifyingAt: string | null;
	completedAt: string | null;
	updatedAt: string;
	durationMs: number | null;
	summary: string | null;
	sandboxId: string | null;
	processId: string | null;
	port: number | null;
	artifactR2Key: string | null;
	artifactDigest: string | null;
	artifactBytes: number | null;
	finalDeployEligible: boolean;
	exclusionReason: string | null;
	checks: UploadCandidateCheck[];
	reportOrder: number | null;
}

export interface UploadProvisionalSnapshot {
	status: 'pending' | 'live' | 'cancelled';
	target: DeploymentTarget | null;
	selectedAt: string | null;
	reportOrder: number | null;
}

export interface UploadPromotionFailure {
	target: DeploymentTarget;
	timestamp: string;
	reason: string;
}

export interface UploadSelectionSnapshot {
	status: 'pending' | 'selected' | 'exhausted';
	forced: boolean;
	startedAt: string | null;
	completedAt: string | null;
	selectedTarget: DeploymentTarget | null;
	rationale: FinalTargetSelection['rationale'] | null;
	attemptedTargets: DeploymentTarget[];
	promotionFailures: UploadPromotionFailure[];
}

export interface UploadDeploymentAttempt {
	number: number;
	target: DeploymentTarget;
	artifactDigest: string;
	status: 'deploying' | 'succeeded' | 'failed' | 'cancelled';
	startedAt: string;
	completedAt: string | null;
	deploymentId: string | null;
	url: string | null;
	failureReason: string | null;
}

export interface UploadDeploymentSnapshot {
	status: 'pending' | 'deploying' | 'succeeded' | 'failed' | 'cancelled';
	target: DeploymentTarget | null;
	startedAt: string | null;
	completedAt: string | null;
	deploymentId: string | null;
	url: string | null;
	failureReason: string | null;
	attempts: UploadDeploymentAttempt[];
}

export interface UploadCleanupSnapshot {
	status: 'pending' | 'running' | 'completed';
	startedAt: string | null;
	completedAt: string | null;
	reason: string | null;
	registeredResources: number;
	releasedResources: number;
}

export interface UploadRunSnapshot {
	schemaVersion: typeof UPLOAD_RUN_SCHEMA_VERSION;
	kind: 'upload';
	revision: number;
	runId: string;
	ownerPrincipalId: string;
	requestedBy: string;
	siteId: string;
	siteHostname: string;
	generation: number;
	sourceR2Key: string;
	sourceManifest: SourceManifest | null;
	status: UploadRunStatus;
	createdAt: string;
	updatedAt: string;
	preparedAt: string | null;
	terminalAt: string | null;
	candidates: Record<DeploymentTarget, UploadCandidateSnapshot>;
	provisional: UploadProvisionalSnapshot;
	selection: UploadSelectionSnapshot;
	deployment: UploadDeploymentSnapshot;
	cleanup: UploadCleanupSnapshot;
	timeToFirstLive: number | null;
	timeToFinal: number | null;
}

export type PublicUploadCandidateSnapshot = Omit<
	UploadCandidateSnapshot,
	'sandboxId' | 'processId' | 'port' | 'artifactR2Key' | 'artifactDigest'
>;

export type PublicUploadDeploymentAttempt = Omit<UploadDeploymentAttempt, 'artifactDigest' | 'deploymentId'>;

export type PublicUploadRunSnapshot = Omit<
	UploadRunSnapshot,
	'ownerPrincipalId' | 'sourceR2Key' | 'sourceManifest' | 'candidates' | 'deployment'
> & {
	source: {
		prepared: boolean;
		manifest: Omit<SourceManifest, 'sourceHash' | 'lockHash'> | null;
	};
	candidates: Record<DeploymentTarget, PublicUploadCandidateSnapshot>;
	deployment: Omit<UploadDeploymentSnapshot, 'deploymentId' | 'attempts'> & { attempts: PublicUploadDeploymentAttempt[] };
};

export interface UploadRunEvent {
	seq: number;
	key: string;
	timestamp: string;
	type: string;
	level: UploadRunEventLevel;
	candidate: DeploymentTarget | null;
	message: string;
}

export type PublicUploadRunEvent = Omit<UploadRunEvent, 'key'>;

export interface UploadRunEventPage {
	events: UploadRunEvent[];
	nextAfter: number;
	hasMore: boolean;
}

export interface UploadMutationInput {
	idempotencyKey: string;
	generation: number;
	timestamp: string;
}

export interface SourceFencedUploadMutationInput extends UploadMutationInput {
	sourceHash: string;
}

export type StartPreparingInput = UploadMutationInput;

export interface MarkPreparedInput extends UploadMutationInput {
	manifest: SourceManifest;
}

export interface MarkCandidateStartedInput extends SourceFencedUploadMutationInput {
	target: DeploymentTarget;
	attempt: number;
	status: UploadCandidateProgressStatus;
	sandboxId?: string | null;
	processId?: string | null;
	port?: number | null;
}

export interface UploadCandidateTerminalResult {
	status: UploadCandidateTerminalStatus;
	durationMs: number;
	summary: string;
	sandboxId?: string | null;
	processId?: string | null;
	port?: number | null;
	artifactR2Key: string | null;
	artifactDigest: string | null;
	artifactBytes: number | null;
	finalDeployEligible: boolean;
	exclusionReason?: string | null;
	checks: UploadCandidateCheck[];
}

export interface ReportCandidateInput extends SourceFencedUploadMutationInput {
	target: DeploymentTarget;
	attempt: number;
	result: UploadCandidateTerminalResult;
}

export interface BeginFinalizationInput extends SourceFencedUploadMutationInput {
	force: boolean;
}

export interface MarkDeployingInput extends SourceFencedUploadMutationInput {
	target: DeploymentTarget;
	artifactDigest: string;
}

export interface CompleteDeploymentInput extends MarkDeployingInput {
	deploymentId?: string | null;
	url?: string | null;
}

export interface RecordPromotionFailureInput extends MarkDeployingInput {
	reason: string;
}

export type RequestCancellationInput = UploadMutationInput;

export interface CompleteCleanupInput extends UploadMutationInput {
	reason?: string | null;
}

export type UploadRunResourceDetails = Record<string, string | number | boolean | null>;

export interface UploadRunResourceRecord {
	resourceId: string;
	kind: UploadRunResourceKind;
	candidate: DeploymentTarget | null;
	generation: number;
	sourceHash: string | null;
	registeredAt: string;
	releasedAt: string | null;
	releaseReason: string | null;
	details: UploadRunResourceDetails;
}

export interface RegisterResourceInput extends UploadMutationInput {
	sourceHash?: string;
	resourceId: string;
	kind: UploadRunResourceKind;
	candidate?: DeploymentTarget | null;
	details?: UploadRunResourceDetails;
}

export interface MarkResourceReleasedInput extends UploadMutationInput {
	sourceHash?: string;
	resourceId: string;
	reason: string;
}

export interface SnapshotTransition {
	snapshot: UploadRunSnapshot;
	changed: boolean;
}

export interface CandidateReportTransition extends SnapshotTransition {
	provisionalChosen: boolean;
	allCandidatesTerminal: boolean;
}

export interface FinalizationTransition extends SnapshotTransition {
	selectedTarget: DeploymentTarget | null;
	timedOutCandidates: DeploymentTarget[];
}

export interface PromotionFailureTransition extends SnapshotTransition {
	nextTarget: DeploymentTarget | null;
}

export interface CancellationTransition extends SnapshotTransition {
	cancelledCandidates: DeploymentTarget[];
}

export interface ResourceTransition extends SnapshotTransition {
	resource: UploadRunResourceRecord;
}

export function createInitialUploadRun(input: UploadRunInitialization): UploadRunSnapshot {
	const initialization = validateUploadRunInitialization(input);
	const candidates = Object.fromEntries(
		UPLOAD_CANDIDATES.map((target) => [target, createCandidate(target, initialization.createdAt)]),
	) as Record<DeploymentTarget, UploadCandidateSnapshot>;

	return {
		schemaVersion: UPLOAD_RUN_SCHEMA_VERSION,
		kind: 'upload',
		revision: 0,
		runId: initialization.runId,
		ownerPrincipalId: initialization.ownerPrincipalId,
		requestedBy: initialization.requestedBy,
		siteId: initialization.siteId,
		siteHostname: initialization.siteHostname,
		generation: initialization.generation,
		sourceR2Key: initialization.sourceR2Key,
		sourceManifest: null,
		status: 'queued',
		createdAt: initialization.createdAt,
		updatedAt: initialization.createdAt,
		preparedAt: null,
		terminalAt: null,
		candidates,
		provisional: { status: 'pending', target: null, selectedAt: null, reportOrder: null },
		selection: {
			status: 'pending',
			forced: false,
			startedAt: null,
			completedAt: null,
			selectedTarget: null,
			rationale: null,
			attemptedTargets: [],
			promotionFailures: [],
		},
		deployment: {
			status: 'pending',
			target: null,
			startedAt: null,
			completedAt: null,
			deploymentId: null,
			url: null,
			failureReason: null,
			attempts: [],
		},
		cleanup: {
			status: 'pending',
			startedAt: null,
			completedAt: null,
			reason: null,
			registeredResources: 0,
			releasedResources: 0,
		},
		timeToFirstLive: null,
		timeToFinal: null,
	};
}

export function normalizeInitialUploadRun(input: unknown): UploadRunSnapshot {
	const value = objectValue(input, 'initial upload run');
	if (value.schemaVersion === undefined) return createInitialUploadRun(value as unknown as UploadRunInitialization);
	if (value.schemaVersion !== UPLOAD_RUN_SCHEMA_VERSION) fail('INVALID_INPUT', 'schemaVersion must be 1');
	if (value.kind !== 'upload') fail('INVALID_INPUT', 'kind must be upload');

	const canonical = createInitialUploadRun({
		runId: value.runId as string,
		ownerPrincipalId: value.ownerPrincipalId as string,
		requestedBy: value.requestedBy as string,
		siteId: value.siteId as string,
		siteHostname: value.siteHostname as string,
		generation: value.generation as number,
		sourceR2Key: value.sourceR2Key as string,
		createdAt: value.createdAt as string,
	});
	if (
		value.revision !== 0 ||
		value.status !== 'queued' ||
		value.sourceManifest != null ||
		value.preparedAt != null ||
		value.terminalAt != null
	) {
		fail('INVALID_INPUT', 'initialize accepts only an initial queued snapshot');
	}
	return canonical;
}

export function publicUploadRunSnapshot(snapshot: UploadRunSnapshot): PublicUploadRunSnapshot {
	const { ownerPrincipalId: _, sourceR2Key: __, sourceManifest, candidates, deployment, ...publicFields } = snapshot;
	const publicCandidates = Object.fromEntries(
		UPLOAD_CANDIDATES.map((target) => {
			const {
				sandboxId: _sandboxId,
				processId: _processId,
				port: _port,
				artifactR2Key: _artifactR2Key,
				artifactDigest: _artifactDigest,
				...candidate
			} = candidates[target];
			return [target, { ...candidate, checks: candidate.checks.map((check) => ({ ...check })) }];
		}),
	) as Record<DeploymentTarget, PublicUploadCandidateSnapshot>;
	const { deploymentId: _deploymentId, attempts, ...publicDeployment } = deployment;

	return {
		...publicFields,
		source: {
			prepared: sourceManifest !== null,
			manifest: sourceManifest ? publicSourceManifest(sourceManifest) : null,
		},
		candidates: publicCandidates,
		deployment: {
			...publicDeployment,
			attempts: attempts.map(({ artifactDigest: _artifactDigest, deploymentId: _attemptDeploymentId, ...attempt }) => ({ ...attempt })),
		},
		selection: copySelection(snapshot.selection),
	};
}

export function publicUploadRunEvent(event: UploadRunEvent): PublicUploadRunEvent {
	const { key: _, ...publicEvent } = event;
	return publicEvent;
}

export function applyStartPreparing(snapshot: UploadRunSnapshot, rawInput: StartPreparingInput): SnapshotTransition {
	const input = validateUploadMutationInput(rawInput);
	assertGeneration(snapshot, input.generation);
	if (snapshot.status === 'preparing') return unchanged(snapshot);
	assertStatus(snapshot, ['queued'], 'start preparing');
	return changed(snapshot, input.timestamp, { status: 'preparing' });
}

export function applyMarkPrepared(snapshot: UploadRunSnapshot, rawInput: MarkPreparedInput): SnapshotTransition {
	const input = validateMarkPreparedInput(rawInput);
	assertGeneration(snapshot, input.generation);
	if (snapshot.sourceManifest) {
		if (snapshot.sourceManifest.sourceHash !== input.manifest.sourceHash) {
			fail('SOURCE_HASH_MISMATCH', 'source manifest does not match the prepared source hash');
		}
		if (!sameJson(snapshot.sourceManifest, input.manifest))
			fail('CONFLICT', 'source manifest was already recorded with different metadata');
		return unchanged(snapshot);
	}
	assertStatus(snapshot, ['preparing'], 'mark source prepared');
	const candidates = mapCandidates(snapshot, (candidate) => ({
		...candidate,
		status: 'queued',
		queuedAt: input.timestamp,
		updatedAt: input.timestamp,
	}));
	return changed(snapshot, input.timestamp, {
		status: 'running',
		preparedAt: input.timestamp,
		sourceManifest: copySourceManifest(input.manifest),
		candidates,
	});
}

export function applyMarkCandidateStarted(snapshot: UploadRunSnapshot, rawInput: MarkCandidateStartedInput): SnapshotTransition {
	const input = validateMarkCandidateStartedInput(rawInput);
	assertSourceFence(snapshot, input.generation, input.sourceHash);
	assertStatus(snapshot, ['running'], `mark ${input.target} ${input.status}`);
	const current = snapshot.candidates[input.target];
	if (isUploadCandidateTerminal(current.status)) fail('INVALID_TRANSITION', `${input.target} is already terminal`);

	const sameResources =
		(input.sandboxId === undefined || input.sandboxId === current.sandboxId) &&
		(input.processId === undefined || input.processId === current.processId) &&
		(input.port === undefined || input.port === current.port);
	if (current.status === input.status && current.attempts === input.attempt && sameResources) return unchanged(snapshot);

	if (input.status === 'building') {
		if (current.status === 'verifying' && input.attempt === current.attempts) {
			fail('INVALID_TRANSITION', `${input.target} cannot move backward from verifying to building`);
		}
		const expectedAttempt = current.status === 'queued' ? 1 : current.attempts + 1;
		if (input.attempt !== expectedAttempt) fail('INVALID_TRANSITION', `${input.target} expected build attempt ${expectedAttempt}`);
	} else {
		if (current.status !== 'building' && current.status !== 'verifying') {
			fail('INVALID_TRANSITION', `${input.target} must be building before verification`);
		}
		if (input.attempt !== current.attempts) fail('INVALID_TRANSITION', `${input.target} verification attempt is stale`);
	}

	const candidate: UploadCandidateSnapshot = {
		...current,
		status: input.status,
		attempts: input.attempt,
		startedAt: current.startedAt ?? input.timestamp,
		verifyingAt: input.status === 'verifying' ? input.timestamp : input.attempt > current.attempts ? null : current.verifyingAt,
		updatedAt: input.timestamp,
		sandboxId: input.sandboxId === undefined ? current.sandboxId : input.sandboxId,
		processId: input.processId === undefined ? current.processId : input.processId,
		port: input.port === undefined ? current.port : input.port,
	};
	return changed(snapshot, input.timestamp, { candidates: replaceCandidate(snapshot, candidate) });
}

export function applyReportCandidate(snapshot: UploadRunSnapshot, rawInput: ReportCandidateInput): CandidateReportTransition {
	const input = validateReportCandidateInput(rawInput);
	assertSourceFence(snapshot, input.generation, input.sourceHash);
	const current = snapshot.candidates[input.target];
	if (isUploadCandidateTerminal(current.status)) {
		if (input.attempt === current.attempts && terminalReportMatches(current, input.result)) {
			return { ...unchanged(snapshot), provisionalChosen: false, allCandidatesTerminal: allUploadCandidatesTerminal(snapshot) };
		}
		fail('CONFLICT', `${input.target} already has a different terminal report`);
	}
	assertStatus(snapshot, ['running'], `report ${input.target}`);
	if (current.status !== 'building' && current.status !== 'verifying') {
		fail('INVALID_TRANSITION', `${input.target} has not started`);
	}
	if (input.attempt !== current.attempts) fail('INVALID_TRANSITION', `${input.target} report attempt is stale`);

	const reportOrder = nextReportOrder(snapshot);
	const candidate = terminalCandidate(current, input.result, input.timestamp, reportOrder);
	const candidates = replaceCandidate(snapshot, candidate);
	const provisionalChosen = snapshot.provisional.target === null && input.result.status === 'passed';
	const provisional: UploadProvisionalSnapshot = provisionalChosen
		? { status: 'live', target: input.target, selectedAt: input.timestamp, reportOrder }
		: snapshot.provisional;
	const nextSnapshot = changed(snapshot, input.timestamp, {
		candidates,
		provisional,
		timeToFirstLive: provisionalChosen ? elapsedMs(snapshot.createdAt, input.timestamp) : snapshot.timeToFirstLive,
	}).snapshot;
	return {
		snapshot: nextSnapshot,
		changed: true,
		provisionalChosen,
		allCandidatesTerminal: allUploadCandidatesTerminal(nextSnapshot),
	};
}

export function applyBeginFinalization(snapshot: UploadRunSnapshot, rawInput: BeginFinalizationInput): FinalizationTransition {
	const input = validateBeginFinalizationInput(rawInput);
	assertSourceFence(snapshot, input.generation, input.sourceHash);
	if (snapshot.selection.status !== 'pending') {
		return { ...unchanged(snapshot), selectedTarget: snapshot.selection.selectedTarget, timedOutCandidates: [] };
	}
	assertStatus(snapshot, ['running'], 'begin finalization');
	if (!input.force && !allUploadCandidatesTerminal(snapshot))
		fail('CANDIDATES_ACTIVE', 'all candidates must be terminal before finalization');

	let reportOrder = nextReportOrder(snapshot);
	const timedOutCandidates: DeploymentTarget[] = [];
	const candidates = mapCandidates(snapshot, (candidate) => {
		if (isUploadCandidateTerminal(candidate.status)) return candidate;
		timedOutCandidates.push(candidate.target);
		const timedOut: UploadCandidateSnapshot = {
			...candidate,
			status: 'timed_out',
			completedAt: input.timestamp,
			updatedAt: input.timestamp,
			durationMs: elapsedMs(candidate.startedAt ?? candidate.queuedAt ?? snapshot.createdAt, input.timestamp),
			summary: 'Timed out during forced finalization',
			finalDeployEligible: false,
			exclusionReason: 'Candidate did not finish before finalization',
			checks: [],
			reportOrder,
		};
		reportOrder += 1;
		return timedOut;
	});
	const decision = selectUploadFinalTarget(candidates, []);
	const hasTarget = decision.selectedTarget !== null;
	const selection: UploadSelectionSnapshot = {
		status: hasTarget ? 'selected' : 'exhausted',
		forced: input.force,
		startedAt: input.timestamp,
		completedAt: input.timestamp,
		selectedTarget: decision.selectedTarget,
		rationale: decision.rationale,
		attemptedTargets: [],
		promotionFailures: [],
	};
	const deployment: UploadDeploymentSnapshot = hasTarget
		? { ...snapshot.deployment, status: 'pending', target: decision.selectedTarget }
		: {
				...snapshot.deployment,
				status: 'failed',
				target: null,
				completedAt: input.timestamp,
				failureReason: 'No candidate is eligible for final deployment',
			};
	const next = changed(snapshot, input.timestamp, {
		candidates,
		selection,
		deployment,
		status: hasTarget ? 'selecting' : 'failed',
		terminalAt: hasTarget ? snapshot.terminalAt : input.timestamp,
		timeToFinal: hasTarget ? snapshot.timeToFinal : elapsedMs(snapshot.createdAt, input.timestamp),
	}).snapshot;
	return { snapshot: next, changed: true, selectedTarget: decision.selectedTarget, timedOutCandidates };
}

export function applyMarkDeploying(snapshot: UploadRunSnapshot, rawInput: MarkDeployingInput): SnapshotTransition {
	const input = validateMarkDeployingInput(rawInput);
	assertSourceFence(snapshot, input.generation, input.sourceHash);
	assertArtifactFence(snapshot, input.target, input.artifactDigest);
	const activeAttempt = snapshot.deployment.attempts.at(-1);
	if (
		snapshot.status === 'deploying' &&
		snapshot.deployment.target === input.target &&
		activeAttempt?.status === 'deploying' &&
		activeAttempt.artifactDigest === input.artifactDigest
	) {
		return unchanged(snapshot);
	}
	assertStatus(snapshot, ['selecting'], `deploy ${input.target}`);
	if (snapshot.selection.selectedTarget !== input.target) fail('INVALID_TRANSITION', `${input.target} is not the selected final target`);

	const attempt: UploadDeploymentAttempt = {
		number: snapshot.deployment.attempts.length + 1,
		target: input.target,
		artifactDigest: input.artifactDigest,
		status: 'deploying',
		startedAt: input.timestamp,
		completedAt: null,
		deploymentId: null,
		url: null,
		failureReason: null,
	};
	const attemptedTargets = snapshot.selection.attemptedTargets.includes(input.target)
		? snapshot.selection.attemptedTargets
		: [...snapshot.selection.attemptedTargets, input.target];
	return changed(snapshot, input.timestamp, {
		status: 'deploying',
		selection: { ...snapshot.selection, attemptedTargets },
		deployment: {
			...snapshot.deployment,
			status: 'deploying',
			target: input.target,
			startedAt: input.timestamp,
			completedAt: null,
			deploymentId: null,
			url: null,
			failureReason: null,
			attempts: [...snapshot.deployment.attempts, attempt],
		},
	});
}

export function applyCompleteDeployment(snapshot: UploadRunSnapshot, rawInput: CompleteDeploymentInput): SnapshotTransition {
	const input = validateCompleteDeploymentInput(rawInput);
	assertSourceFence(snapshot, input.generation, input.sourceHash);
	assertArtifactFence(snapshot, input.target, input.artifactDigest);
	const activeAttempt = snapshot.deployment.attempts.at(-1);
	if (
		snapshot.status === 'succeeded' &&
		activeAttempt?.target === input.target &&
		activeAttempt.artifactDigest === input.artifactDigest &&
		activeAttempt.status === 'succeeded'
	) {
		return unchanged(snapshot);
	}
	assertStatus(snapshot, ['deploying'], `complete ${input.target} deployment`);
	if (
		snapshot.deployment.target !== input.target ||
		activeAttempt?.target !== input.target ||
		activeAttempt.artifactDigest !== input.artifactDigest ||
		activeAttempt.status !== 'deploying'
	) {
		fail('INVALID_TRANSITION', 'deployment callback does not match the active attempt');
	}

	const completedAttempt: UploadDeploymentAttempt = {
		...activeAttempt,
		status: 'succeeded',
		completedAt: input.timestamp,
		deploymentId: input.deploymentId ?? null,
		url: input.url ?? null,
	};
	const attempts = [...snapshot.deployment.attempts.slice(0, -1), completedAttempt];
	return changed(snapshot, input.timestamp, {
		status: 'succeeded',
		terminalAt: input.timestamp,
		timeToFirstLive: snapshot.timeToFirstLive ?? elapsedMs(snapshot.createdAt, input.timestamp),
		timeToFinal: elapsedMs(snapshot.createdAt, input.timestamp),
		deployment: {
			...snapshot.deployment,
			status: 'succeeded',
			completedAt: input.timestamp,
			deploymentId: input.deploymentId ?? null,
			url: input.url ?? null,
			failureReason: null,
			attempts,
		},
	});
}

export function applyRecordPromotionFailure(
	snapshot: UploadRunSnapshot,
	rawInput: RecordPromotionFailureInput,
): PromotionFailureTransition {
	const input = validateRecordPromotionFailureInput(rawInput);
	assertSourceFence(snapshot, input.generation, input.sourceHash);
	assertArtifactFence(snapshot, input.target, input.artifactDigest);
	const priorFailure = snapshot.deployment.attempts.some(
		(attempt) => attempt.target === input.target && attempt.artifactDigest === input.artifactDigest && attempt.status === 'failed',
	);
	if (priorFailure) return { ...unchanged(snapshot), nextTarget: snapshot.selection.selectedTarget };
	assertStatus(snapshot, ['deploying'], `record ${input.target} promotion failure`);
	const activeAttempt = snapshot.deployment.attempts.at(-1);
	if (
		snapshot.deployment.target !== input.target ||
		activeAttempt?.target !== input.target ||
		activeAttempt.artifactDigest !== input.artifactDigest ||
		activeAttempt.status !== 'deploying'
	) {
		fail('INVALID_TRANSITION', 'promotion failure does not match the active deployment attempt');
	}

	const failedAttempt: UploadDeploymentAttempt = {
		...activeAttempt,
		status: 'failed',
		completedAt: input.timestamp,
		failureReason: input.reason,
	};
	const attempts = [...snapshot.deployment.attempts.slice(0, -1), failedAttempt];
	const failure: UploadPromotionFailure = { target: input.target, timestamp: input.timestamp, reason: input.reason };
	const promotionFailures = [...snapshot.selection.promotionFailures, failure];
	const decision = selectUploadFinalTarget(snapshot.candidates, promotionFailures);
	const nextTarget = decision.selectedTarget;
	const exhausted = nextTarget === null;
	const next = changed(snapshot, input.timestamp, {
		status: exhausted ? 'failed' : 'selecting',
		terminalAt: exhausted ? input.timestamp : snapshot.terminalAt,
		timeToFinal: exhausted ? elapsedMs(snapshot.createdAt, input.timestamp) : snapshot.timeToFinal,
		selection: {
			...snapshot.selection,
			status: exhausted ? 'exhausted' : 'selected',
			selectedTarget: nextTarget,
			rationale: decision.rationale,
			promotionFailures,
		},
		deployment: {
			...snapshot.deployment,
			status: exhausted ? 'failed' : 'pending',
			target: exhausted ? input.target : nextTarget,
			startedAt: exhausted ? snapshot.deployment.startedAt : null,
			completedAt: exhausted ? input.timestamp : null,
			deploymentId: null,
			url: null,
			failureReason: exhausted ? input.reason : null,
			attempts,
		},
	}).snapshot;
	return { snapshot: next, changed: true, nextTarget };
}

export function applyRequestCancellation(snapshot: UploadRunSnapshot, rawInput: RequestCancellationInput): CancellationTransition {
	const input = validateUploadMutationInput(rawInput);
	assertGeneration(snapshot, input.generation);
	if (
		snapshot.status === 'cancelling' ||
		snapshot.status === 'cancelled' ||
		snapshot.status === 'succeeded' ||
		snapshot.status === 'failed'
	) {
		return { ...unchanged(snapshot), cancelledCandidates: [] };
	}

	let reportOrder = nextReportOrder(snapshot);
	const cancelledCandidates: DeploymentTarget[] = [];
	const candidates = mapCandidates(snapshot, (candidate) => {
		if (isUploadCandidateTerminal(candidate.status)) return candidate;
		cancelledCandidates.push(candidate.target);
		const cancelled: UploadCandidateSnapshot = {
			...candidate,
			status: 'cancelled',
			completedAt: input.timestamp,
			updatedAt: input.timestamp,
			durationMs: elapsedMs(candidate.startedAt ?? candidate.queuedAt ?? snapshot.createdAt, input.timestamp),
			summary: 'Cancelled by request',
			finalDeployEligible: false,
			exclusionReason: 'Run was cancelled',
			checks: [],
			reportOrder,
		};
		reportOrder += 1;
		return cancelled;
	});
	const attempts = snapshot.deployment.attempts.map((attempt, index, all) =>
		index === all.length - 1 && attempt.status === 'deploying'
			? { ...attempt, status: 'cancelled' as const, completedAt: input.timestamp, failureReason: 'Run was cancelled' }
			: attempt,
	);
	const deploymentWasActive =
		snapshot.deployment.target !== null && (snapshot.deployment.status === 'pending' || snapshot.deployment.status === 'deploying');
	const next = changed(snapshot, input.timestamp, {
		generation: snapshot.generation + 1,
		status: 'cancelling',
		candidates,
		provisional: snapshot.provisional.target ? { ...snapshot.provisional, status: 'cancelled' } : snapshot.provisional,
		deployment: deploymentWasActive
			? {
					...snapshot.deployment,
					status: 'cancelled',
					completedAt: input.timestamp,
					failureReason: 'Run was cancelled',
					attempts,
				}
			: snapshot.deployment,
		cleanup: {
			...snapshot.cleanup,
			status: 'running',
			startedAt: snapshot.cleanup.startedAt ?? input.timestamp,
			reason: 'Run cancellation',
		},
	}).snapshot;
	return { snapshot: next, changed: true, cancelledCandidates };
}

export function applyCompleteCleanup(snapshot: UploadRunSnapshot, rawInput: CompleteCleanupInput): SnapshotTransition {
	const input = validateCompleteCleanupInput(rawInput);
	assertGeneration(snapshot, input.generation);
	if (snapshot.cleanup.status === 'completed') return unchanged(snapshot);
	if (snapshot.cleanup.releasedResources !== snapshot.cleanup.registeredResources) {
		fail('RESOURCES_ACTIVE', 'all registered resources must be released before cleanup completes');
	}
	if (!['succeeded', 'failed', 'cancelling', 'cancelled'].includes(snapshot.status)) {
		fail('INVALID_TRANSITION', `cleanup cannot complete while run is ${snapshot.status}`);
	}
	const cancelled = snapshot.status === 'cancelling' || snapshot.status === 'cancelled';
	return changed(snapshot, input.timestamp, {
		status: cancelled ? 'cancelled' : snapshot.status,
		terminalAt: cancelled ? (snapshot.terminalAt ?? input.timestamp) : snapshot.terminalAt,
		timeToFinal: cancelled ? (snapshot.timeToFinal ?? elapsedMs(snapshot.createdAt, input.timestamp)) : snapshot.timeToFinal,
		cleanup: {
			...snapshot.cleanup,
			status: 'completed',
			startedAt: snapshot.cleanup.startedAt ?? input.timestamp,
			completedAt: input.timestamp,
			reason: input.reason ?? snapshot.cleanup.reason,
		},
	});
}

export function applyRegisterResource(
	snapshot: UploadRunSnapshot,
	existing: UploadRunResourceRecord | null,
	rawInput: RegisterResourceInput,
): ResourceTransition {
	const input = validateRegisterResourceInput(rawInput);
	assertOptionalSourceFence(snapshot, input.generation, input.sourceHash);
	const resource: UploadRunResourceRecord = {
		resourceId: input.resourceId,
		kind: input.kind,
		candidate: input.candidate ?? null,
		generation: input.generation,
		sourceHash: input.sourceHash ?? null,
		registeredAt: input.timestamp,
		releasedAt: null,
		releaseReason: null,
		details: input.details ?? {},
	};
	if (existing) {
		if (sameResourceRegistration(existing, resource)) return { ...unchanged(snapshot), resource: existing };
		fail('CONFLICT', `resource ${input.resourceId} is already registered differently`);
	}
	if (snapshot.cleanup.status === 'completed') fail('INVALID_TRANSITION', 'cannot register resources after cleanup');
	const transition = changed(snapshot, input.timestamp, {
		cleanup: { ...snapshot.cleanup, registeredResources: snapshot.cleanup.registeredResources + 1 },
	});
	return { ...transition, resource };
}

export function applyReleaseResource(
	snapshot: UploadRunSnapshot,
	existing: UploadRunResourceRecord,
	rawInput: MarkResourceReleasedInput,
): ResourceTransition {
	const input = validateMarkResourceReleasedInput(rawInput);
	assertOptionalSourceFence(snapshot, input.generation, input.sourceHash);
	if (existing.resourceId !== input.resourceId) fail('CONFLICT', 'resource release does not match the stored resource');
	if (existing.releasedAt) return { ...unchanged(snapshot), resource: existing };
	const resource = { ...existing, releasedAt: input.timestamp, releaseReason: input.reason };
	if (snapshot.cleanup.releasedResources >= snapshot.cleanup.registeredResources) fail('CONFLICT', 'resource counters are inconsistent');
	const transition = changed(snapshot, input.timestamp, {
		cleanup: { ...snapshot.cleanup, releasedResources: snapshot.cleanup.releasedResources + 1 },
	});
	return { ...transition, resource };
}

export function allUploadCandidatesTerminal(snapshot: Pick<UploadRunSnapshot, 'candidates'>): boolean {
	return UPLOAD_CANDIDATES.every((target) => isUploadCandidateTerminal(snapshot.candidates[target].status));
}

export function isUploadCandidateTerminal(status: UploadCandidateStatus): status is UploadCandidateTerminalStatus {
	return status === 'passed' || status === 'incompatible' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
}

export function sameUploadRunIdentity(existing: UploadRunSnapshot, initial: UploadRunSnapshot): boolean {
	return (
		existing.runId === initial.runId &&
		existing.ownerPrincipalId === initial.ownerPrincipalId &&
		existing.requestedBy === initial.requestedBy &&
		existing.siteId === initial.siteId &&
		existing.siteHostname === initial.siteHostname &&
		existing.sourceR2Key === initial.sourceR2Key &&
		initial.generation <= existing.generation
	);
}

export function validateUploadRunInitialization(input: unknown): UploadRunInitialization {
	const value = objectValue(input, 'upload run initialization');
	return {
		runId: boundedString(value.runId, 'runId', 128),
		ownerPrincipalId: boundedString(value.ownerPrincipalId, 'ownerPrincipalId', 512),
		requestedBy: boundedString(value.requestedBy, 'requestedBy', 512),
		siteId: boundedString(value.siteId, 'siteId', 256),
		siteHostname: hostname(value.siteHostname),
		generation: positiveInteger(value.generation, 'generation'),
		sourceR2Key: opaqueString(value.sourceR2Key, 'sourceR2Key', 1024),
		createdAt: timestamp(value.createdAt, 'createdAt'),
	};
}

export function validateUploadMutationInput(input: unknown): UploadMutationInput {
	const value = objectValue(input, 'upload run mutation');
	return {
		idempotencyKey: opaqueString(value.idempotencyKey, 'idempotencyKey', 512),
		generation: positiveInteger(value.generation, 'generation'),
		timestamp: timestamp(value.timestamp, 'timestamp'),
	};
}

export function validateMarkPreparedInput(input: unknown): MarkPreparedInput {
	const value = objectValue(input, 'mark prepared input');
	return { ...validateUploadMutationInput(value), manifest: validateUploadSourceManifest(value.manifest) };
}

export function validateMarkCandidateStartedInput(input: unknown): MarkCandidateStartedInput {
	const value = objectValue(input, 'candidate start input');
	const status = value.status;
	if (status !== 'building' && status !== 'verifying') fail('INVALID_INPUT', 'candidate status must be building or verifying');
	return {
		...validateSourceFencedMutation(value),
		target: deploymentTarget(value.target),
		attempt: boundedPositiveInteger(value.attempt, 'attempt', MAX_UPLOAD_CANDIDATE_ATTEMPTS),
		status,
		...optionalResourceFields(value),
	};
}

export function validateReportCandidateInput(input: unknown): ReportCandidateInput {
	const value = objectValue(input, 'candidate report input');
	return {
		...validateSourceFencedMutation(value),
		target: deploymentTarget(value.target),
		attempt: boundedPositiveInteger(value.attempt, 'attempt', MAX_UPLOAD_CANDIDATE_ATTEMPTS),
		result: validateTerminalResult(value.result),
	};
}

export function validateBeginFinalizationInput(input: unknown): BeginFinalizationInput {
	const value = objectValue(input, 'begin finalization input');
	if (typeof value.force !== 'boolean') fail('INVALID_INPUT', 'force must be a boolean');
	return { ...validateSourceFencedMutation(value), force: value.force };
}

export function validateMarkDeployingInput(input: unknown): MarkDeployingInput {
	const value = objectValue(input, 'mark deploying input');
	return {
		...validateSourceFencedMutation(value),
		target: deploymentTarget(value.target),
		artifactDigest: opaqueString(value.artifactDigest, 'artifactDigest', 512),
	};
}

export function validateCompleteDeploymentInput(input: unknown): CompleteDeploymentInput {
	const value = objectValue(input, 'complete deployment input');
	return {
		...validateMarkDeployingInput(value),
		deploymentId: optionalNullableOpaqueString(value.deploymentId, 'deploymentId', 512),
		url: optionalNullableUrl(value.url),
	};
}

export function validateRecordPromotionFailureInput(input: unknown): RecordPromotionFailureInput {
	const value = objectValue(input, 'promotion failure input');
	return { ...validateMarkDeployingInput(value), reason: boundedString(value.reason, 'reason', 4_000) };
}

export function validateCompleteCleanupInput(input: unknown): CompleteCleanupInput {
	const value = objectValue(input, 'complete cleanup input');
	return {
		...validateUploadMutationInput(value),
		reason: optionalNullableBoundedString(value.reason, 'reason', 4_000),
	};
}

export function validateRegisterResourceInput(input: unknown): RegisterResourceInput {
	const value = objectValue(input, 'resource registration input');
	const kind = value.kind;
	if (!['source', 'sandbox', 'process', 'port', 'artifact', 'deployment', 'other'].includes(String(kind))) {
		fail('INVALID_INPUT', 'resource kind is invalid');
	}
	return {
		...validateUploadMutationInput(value),
		sourceHash: optionalOpaqueString(value.sourceHash, 'sourceHash', 512),
		resourceId: opaqueString(value.resourceId, 'resourceId', 512),
		kind: kind as UploadRunResourceKind,
		candidate: value.candidate == null ? null : deploymentTarget(value.candidate),
		details: resourceDetails(value.details),
	};
}

export function validateMarkResourceReleasedInput(input: unknown): MarkResourceReleasedInput {
	const value = objectValue(input, 'resource release input');
	return {
		...validateUploadMutationInput(value),
		sourceHash: optionalOpaqueString(value.sourceHash, 'sourceHash', 512),
		resourceId: opaqueString(value.resourceId, 'resourceId', 512),
		reason: boundedString(value.reason, 'reason', 4_000),
	};
}

export function validateUploadSourceManifest(input: unknown): SourceManifest {
	const value = objectValue(input, 'source manifest');
	return {
		root: boundedString(value.root, 'manifest.root', 1_024, false),
		appName: boundedString(value.appName, 'manifest.appName', 512, false),
		sourceHash: opaqueString(value.sourceHash, 'manifest.sourceHash', 512),
		lockHash: opaqueString(value.lockHash, 'manifest.lockHash', 512),
		entryCount: nonnegativeInteger(value.entryCount, 'manifest.entryCount'),
		fileCount: nonnegativeInteger(value.fileCount, 'manifest.fileCount'),
		directoryCount: nonnegativeInteger(value.directoryCount, 'manifest.directoryCount'),
		compressedBytes: nonnegativeInteger(value.compressedBytes, 'manifest.compressedBytes'),
		uncompressedBytes: nonnegativeInteger(value.uncompressedBytes, 'manifest.uncompressedBytes'),
	};
}

function createCandidate(target: DeploymentTarget, timestampValue: string): UploadCandidateSnapshot {
	return {
		target,
		status: 'pending',
		attempts: 0,
		queuedAt: null,
		startedAt: null,
		verifyingAt: null,
		completedAt: null,
		updatedAt: timestampValue,
		durationMs: null,
		summary: null,
		sandboxId: null,
		processId: null,
		port: null,
		artifactR2Key: null,
		artifactDigest: null,
		artifactBytes: null,
		finalDeployEligible: false,
		exclusionReason: null,
		checks: [],
		reportOrder: null,
	};
}

function validateSourceFencedMutation(input: unknown): SourceFencedUploadMutationInput {
	const value = objectValue(input, 'source-fenced mutation');
	return { ...validateUploadMutationInput(value), sourceHash: opaqueString(value.sourceHash, 'sourceHash', 512) };
}

function validateTerminalResult(input: unknown): UploadCandidateTerminalResult {
	const value = objectValue(input, 'candidate terminal result');
	const status = value.status;
	if (!['passed', 'incompatible', 'failed', 'timed_out', 'cancelled'].includes(String(status))) {
		fail('INVALID_INPUT', 'candidate result status must be terminal');
	}
	if (typeof value.finalDeployEligible !== 'boolean') fail('INVALID_INPUT', 'finalDeployEligible must be a boolean');
	const artifactR2Key = nullableOpaqueString(value.artifactR2Key, 'artifactR2Key', 1_024);
	const artifactDigest = nullableOpaqueString(value.artifactDigest, 'artifactDigest', 512);
	const artifactBytes = nullableNonnegativeInteger(value.artifactBytes, 'artifactBytes');
	const hasAnyArtifact = artifactR2Key !== null || artifactDigest !== null || artifactBytes !== null;
	const hasCompleteArtifact = artifactR2Key !== null && artifactDigest !== null && artifactBytes !== null;
	if (hasAnyArtifact && !hasCompleteArtifact) fail('INVALID_INPUT', 'artifact key, digest, and bytes must be supplied together');
	if (value.finalDeployEligible && (status !== 'passed' || !hasCompleteArtifact)) {
		fail('INVALID_INPUT', 'only a passed candidate with a complete artifact can be final-deploy eligible');
	}
	const summary = boundedString(value.summary, 'summary', 4_000);
	const exclusionReason = optionalNullableBoundedString(value.exclusionReason, 'exclusionReason', 4_000);
	return {
		status: status as UploadCandidateTerminalStatus,
		durationMs: nonnegativeInteger(value.durationMs, 'durationMs'),
		summary,
		...optionalResourceFields(value),
		artifactR2Key,
		artifactDigest,
		artifactBytes,
		finalDeployEligible: value.finalDeployEligible,
		exclusionReason: value.finalDeployEligible ? null : (exclusionReason ?? summary),
		checks: candidateChecks(value.checks),
	};
}

function terminalCandidate(
	current: UploadCandidateSnapshot,
	result: UploadCandidateTerminalResult,
	completedAt: string,
	reportOrder: number,
): UploadCandidateSnapshot {
	return {
		...current,
		status: result.status,
		completedAt,
		updatedAt: completedAt,
		durationMs: result.durationMs,
		summary: result.summary,
		sandboxId: result.sandboxId === undefined ? current.sandboxId : result.sandboxId,
		processId: result.processId === undefined ? current.processId : result.processId,
		port: result.port === undefined ? current.port : result.port,
		artifactR2Key: result.artifactR2Key,
		artifactDigest: result.artifactDigest,
		artifactBytes: result.artifactBytes,
		finalDeployEligible: result.finalDeployEligible,
		exclusionReason: result.exclusionReason ?? null,
		checks: result.checks.map((check) => ({ ...check })),
		reportOrder,
	};
}

function terminalReportMatches(candidate: UploadCandidateSnapshot, result: UploadCandidateTerminalResult): boolean {
	const effective = terminalCandidate(candidate, result, candidate.completedAt ?? candidate.updatedAt, candidate.reportOrder ?? 0);
	return (
		candidate.status === effective.status &&
		candidate.durationMs === effective.durationMs &&
		candidate.summary === effective.summary &&
		candidate.sandboxId === effective.sandboxId &&
		candidate.processId === effective.processId &&
		candidate.port === effective.port &&
		candidate.artifactR2Key === effective.artifactR2Key &&
		candidate.artifactDigest === effective.artifactDigest &&
		candidate.artifactBytes === effective.artifactBytes &&
		candidate.finalDeployEligible === effective.finalDeployEligible &&
		candidate.exclusionReason === effective.exclusionReason &&
		sameJson(candidate.checks, effective.checks)
	);
}

function selectUploadFinalTarget(
	candidates: Record<DeploymentTarget, UploadCandidateSnapshot>,
	promotionFailures: readonly UploadPromotionFailure[],
): FinalTargetSelection {
	const failureByTarget = new Map(promotionFailures.map((failure) => [failure.target, failure]));
	return selectFinalTarget(
		UPLOAD_CANDIDATES.map((target) => {
			const candidate = candidates[target];
			if (!isUploadCandidateTerminal(candidate.status) || !candidate.completedAt) {
				fail('CANDIDATES_ACTIVE', `${target} is not terminal`);
			}
			const failure = failureByTarget.get(target);
			return {
				target,
				outcome: candidate.status,
				finalDeployEligible: candidate.finalDeployEligible && !failure,
				...(failure
					? { exclusionReason: `Promotion failed: ${failure.reason}` }
					: candidate.exclusionReason
						? { exclusionReason: candidate.exclusionReason }
						: {}),
				artifactBytes: candidate.artifactBytes,
				completedAt: candidate.completedAt,
			};
		}),
	);
}

function assertGeneration(snapshot: UploadRunSnapshot, generation: number): void {
	if (generation !== snapshot.generation) {
		fail('STALE_GENERATION', `stale generation ${generation}; current generation is ${snapshot.generation}`);
	}
}

function assertSourceFence(snapshot: UploadRunSnapshot, generation: number, sourceHash: string): void {
	assertGeneration(snapshot, generation);
	if (!snapshot.sourceManifest) fail('INVALID_TRANSITION', 'source has not been prepared');
	if (snapshot.sourceManifest.sourceHash !== sourceHash) fail('SOURCE_HASH_MISMATCH', 'source hash does not match this run');
}

function assertOptionalSourceFence(snapshot: UploadRunSnapshot, generation: number, sourceHash: string | undefined): void {
	assertGeneration(snapshot, generation);
	if (snapshot.sourceManifest) {
		if (!sourceHash || snapshot.sourceManifest.sourceHash !== sourceHash)
			fail('SOURCE_HASH_MISMATCH', 'source hash does not match this run');
	} else if (sourceHash !== undefined) {
		fail('SOURCE_HASH_MISMATCH', 'source hash cannot be fenced before preparation');
	}
}

function assertArtifactFence(snapshot: UploadRunSnapshot, target: DeploymentTarget, artifactDigest: string): void {
	const candidate = snapshot.candidates[target];
	if (candidate.status !== 'passed' || !candidate.finalDeployEligible || !candidate.artifactDigest) {
		fail('INVALID_TRANSITION', `${target} has no final-deploy-eligible artifact`);
	}
	if (candidate.artifactDigest !== artifactDigest) fail('ARTIFACT_DIGEST_MISMATCH', `${target} artifact digest does not match`);
}

function assertStatus(snapshot: UploadRunSnapshot, allowed: readonly UploadRunStatus[], action: string): void {
	if (!allowed.includes(snapshot.status)) fail('INVALID_TRANSITION', `cannot ${action} while run is ${snapshot.status}`);
}

function changed(snapshot: UploadRunSnapshot, timestampValue: string, patch: Partial<UploadRunSnapshot>): SnapshotTransition {
	const next: UploadRunSnapshot = {
		...snapshot,
		...patch,
		schemaVersion: UPLOAD_RUN_SCHEMA_VERSION,
		runId: snapshot.runId,
		ownerPrincipalId: snapshot.ownerPrincipalId,
		requestedBy: snapshot.requestedBy,
		siteId: snapshot.siteId,
		siteHostname: snapshot.siteHostname,
		sourceR2Key: snapshot.sourceR2Key,
		revision: snapshot.revision + 1,
		updatedAt: laterTimestamp(snapshot.updatedAt, timestampValue),
	};
	return { snapshot: next, changed: true };
}

function unchanged(snapshot: UploadRunSnapshot): SnapshotTransition {
	return { snapshot, changed: false };
}

function replaceCandidate(
	snapshot: UploadRunSnapshot,
	candidate: UploadCandidateSnapshot,
): Record<DeploymentTarget, UploadCandidateSnapshot> {
	return { ...snapshot.candidates, [candidate.target]: candidate };
}

function mapCandidates(
	snapshot: UploadRunSnapshot,
	mapper: (candidate: UploadCandidateSnapshot) => UploadCandidateSnapshot,
): Record<DeploymentTarget, UploadCandidateSnapshot> {
	return Object.fromEntries(UPLOAD_CANDIDATES.map((target) => [target, mapper(snapshot.candidates[target])])) as Record<
		DeploymentTarget,
		UploadCandidateSnapshot
	>;
}

function nextReportOrder(snapshot: UploadRunSnapshot): number {
	return Math.max(0, ...UPLOAD_CANDIDATES.map((target) => snapshot.candidates[target].reportOrder ?? 0)) + 1;
}

function publicSourceManifest(manifest: SourceManifest): Omit<SourceManifest, 'sourceHash' | 'lockHash'> {
	const { sourceHash: _, lockHash: __, ...publicManifest } = manifest;
	return { ...publicManifest };
}

function copySourceManifest(manifest: SourceManifest): SourceManifest {
	return { ...manifest };
}

function copySelection(selection: UploadSelectionSnapshot): UploadSelectionSnapshot {
	return {
		...selection,
		attemptedTargets: [...selection.attemptedTargets],
		promotionFailures: selection.promotionFailures.map((failure) => ({ ...failure })),
		rationale: selection.rationale
			? {
					...selection.rationale,
					ranking: [...selection.rationale.ranking],
					eligiblePassedTargets: [...selection.rationale.eligiblePassedTargets],
					candidates: selection.rationale.candidates.map((candidate) => ({ ...candidate })),
				}
			: null,
	};
}

function sameResourceRegistration(left: UploadRunResourceRecord, right: UploadRunResourceRecord): boolean {
	return (
		left.resourceId === right.resourceId &&
		left.kind === right.kind &&
		left.candidate === right.candidate &&
		left.generation === right.generation &&
		left.sourceHash === right.sourceHash &&
		sameJson(left.details, right.details)
	);
}

function candidateChecks(input: unknown): UploadCandidateCheck[] {
	if (!Array.isArray(input)) fail('INVALID_INPUT', 'checks must be an array');
	if (input.length > MAX_UPLOAD_CANDIDATE_CHECKS) {
		fail('INVALID_INPUT', `checks cannot contain more than ${MAX_UPLOAD_CANDIDATE_CHECKS} entries`);
	}
	return input.map((rawCheck, index) => {
		const check = objectValue(rawCheck, `checks[${index}]`);
		if (check.status !== 'passed' && check.status !== 'failed' && check.status !== 'advisory') {
			fail('INVALID_INPUT', `checks[${index}].status is invalid`);
		}
		return {
			name: boundedString(check.name, `checks[${index}].name`, 256),
			status: check.status,
			detail: boundedString(check.detail, `checks[${index}].detail`, 2_000, false),
			durationMs: nonnegativeInteger(check.durationMs, `checks[${index}].durationMs`),
		};
	});
}

function optionalResourceFields(value: Record<string, unknown>): Pick<MarkCandidateStartedInput, 'sandboxId' | 'processId' | 'port'> {
	return {
		sandboxId: optionalNullableOpaqueString(value.sandboxId, 'sandboxId', 512),
		processId: optionalNullableOpaqueString(value.processId, 'processId', 512),
		port: optionalNullablePort(value.port),
	};
}

function resourceDetails(input: unknown): UploadRunResourceDetails {
	if (input === undefined) return {};
	const value = objectValue(input, 'resource details');
	const entries = Object.entries(value);
	if (entries.length > 32) fail('INVALID_INPUT', 'resource details cannot contain more than 32 entries');
	const normalized: UploadRunResourceDetails = {};
	for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
		const normalizedKey = boundedString(key, 'resource detail key', 128);
		if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
			fail('INVALID_INPUT', `resource detail ${normalizedKey} must be a scalar`);
		}
		if (typeof raw === 'number' && !Number.isFinite(raw)) fail('INVALID_INPUT', `resource detail ${normalizedKey} must be finite`);
		if (typeof raw === 'string' && raw.length > 2_000) fail('INVALID_INPUT', `resource detail ${normalizedKey} is too long`);
		normalized[normalizedKey] = raw as string | number | boolean | null;
	}
	return normalized;
}

function objectValue(input: unknown, name: string): Record<string, unknown> {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_INPUT', `${name} must be an object`);
	return input as Record<string, unknown>;
}

function deploymentTarget(input: unknown): DeploymentTarget {
	if (input !== 'vinext' && input !== 'opennext' && input !== 'container') fail('INVALID_INPUT', 'candidate target is invalid');
	return input;
}

function boundedString(input: unknown, name: string, maxLength: number, trim = true): string {
	if (typeof input !== 'string') fail('INVALID_INPUT', `${name} must be a string`);
	const value = trim ? input.trim() : input;
	if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
		fail('INVALID_INPUT', `${name} must be nonempty, at most ${maxLength} characters, and contain no control characters`);
	}
	return value;
}

function opaqueString(input: unknown, name: string, maxLength: number): string {
	const value = boundedString(input, name, maxLength, false);
	if (/\s/.test(value)) fail('INVALID_INPUT', `${name} must contain no whitespace`);
	return value;
}

function optionalOpaqueString(input: unknown, name: string, maxLength: number): string | undefined {
	return input === undefined ? undefined : opaqueString(input, name, maxLength);
}

function nullableOpaqueString(input: unknown, name: string, maxLength: number): string | null {
	return input === null ? null : opaqueString(input, name, maxLength);
}

function optionalNullableOpaqueString(input: unknown, name: string, maxLength: number): string | null | undefined {
	return input === undefined ? undefined : nullableOpaqueString(input, name, maxLength);
}

function optionalNullableBoundedString(input: unknown, name: string, maxLength: number): string | null | undefined {
	return input === undefined || input === null ? input : boundedString(input, name, maxLength);
}

function positiveInteger(input: unknown, name: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 1) fail('INVALID_INPUT', `${name} must be a positive safe integer`);
	return input as number;
}

function boundedPositiveInteger(input: unknown, name: string, max: number): number {
	const value = positiveInteger(input, name);
	if (value > max) fail('INVALID_INPUT', `${name} cannot exceed ${max}`);
	return value;
}

function nonnegativeInteger(input: unknown, name: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 0) fail('INVALID_INPUT', `${name} must be a nonnegative safe integer`);
	return input as number;
}

function nullableNonnegativeInteger(input: unknown, name: string): number | null {
	return input === null ? null : nonnegativeInteger(input, name);
}

function optionalNullablePort(input: unknown): number | null | undefined {
	if (input === undefined || input === null) return input;
	if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > 65_535) {
		fail('INVALID_INPUT', 'port must be an integer between 1 and 65535');
	}
	return input as number;
}

function timestamp(input: unknown, name: string): string {
	if (typeof input !== 'string') fail('INVALID_INPUT', `${name} must be an ISO timestamp`);
	const milliseconds = Date.parse(input);
	if (!Number.isFinite(milliseconds)) fail('INVALID_INPUT', `${name} must be an ISO timestamp`);
	return new Date(milliseconds).toISOString();
}

function hostname(input: unknown): string {
	const value = boundedString(input, 'siteHostname', 253).toLowerCase();
	if (value.includes('/') || value.includes(':') || value.includes('?') || value.includes('#')) {
		fail('INVALID_INPUT', 'siteHostname must contain only a hostname');
	}
	let parsed: URL;
	try {
		parsed = new URL(`https://${value}`);
	} catch {
		fail('INVALID_INPUT', 'siteHostname is invalid');
	}
	if (!parsed.hostname || parsed.hostname.length > 253 || parsed.hostname !== value) fail('INVALID_INPUT', 'siteHostname is invalid');
	return value;
}

function optionalNullableUrl(input: unknown): string | null | undefined {
	if (input === undefined || input === null) return input;
	if (typeof input !== 'string' || input.length > 2_048) fail('INVALID_INPUT', 'url must be an HTTPS URL');
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		fail('INVALID_INPUT', 'url must be an HTTPS URL');
	}
	if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
		fail('INVALID_INPUT', 'url must be an HTTPS URL without credentials');
	return parsed.toString();
}

function elapsedMs(start: string, end: string): number {
	return Math.max(0, Date.parse(end) - Date.parse(start));
}

function laterTimestamp(left: string, right: string): string {
	return Date.parse(right) >= Date.parse(left) ? right : left;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function fail(code: UploadRunDomainErrorCode, message: string): never {
	throw new UploadRunDomainError(code, message);
}
