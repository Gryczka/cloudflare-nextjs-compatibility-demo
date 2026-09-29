/** Versioned run state and event patches shared by the Worker, Workflow, and UI. */
export const fixtureIds = ['vinext', 'opennext', 'container'] as const;
export type FixtureId = (typeof fixtureIds)[number];

export const stageNames = ['baseline', 'vinext', 'opennext', 'container', 'publish'] as const;
export type StageName = (typeof stageNames)[number];

export const compatibilityStages = ['baseline', 'vinext', 'opennext', 'container'] as const;
export type CompatibilityStage = (typeof compatibilityStages)[number];

export type DeploymentTarget = 'vinext' | 'opennext' | 'container';
export type RunKind = 'fixture';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'retrying' | 'passed' | 'incompatible' | 'failed' | 'skipped' | 'cancelled';

export interface StageCheck {
	name: string;
	status: 'passed' | 'failed' | 'advisory';
	detail: string;
	durationMs: number;
}

export interface StageExecutionResult {
	stage: CompatibilityStage;
	outcome: 'compatible' | 'incompatible' | 'invalid';
	summary: string;
	checks: StageCheck[];
	workspace: string;
	durationMs: number;
}

export interface StageSnapshot {
	name: StageName;
	label: string;
	status: StageStatus;
	summary: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	checks: StageCheck[];
}

/** Persisted run snapshot: ownerPrincipalId is private and must be stripped from
 * visitor-facing responses with publicRunSnapshot().
 */
export interface RunSnapshot {
	schemaVersion: 1;
	kind: RunKind;
	id: string;
	revision: number;
	fixtureId: FixtureId;
	ownerPrincipalId: string;
	requestedBy: string;
	status: RunStatus;
	createdAt: string;
	updatedAt: string;
	terminalAt: string | null;
	selectedTarget: DeploymentTarget | null;
	previewPath: string | null;
	previewProcessId: string | null;
	previewPort: number | null;
	sandboxDestroyedAt: string | null;
	stages: Record<StageName, StageSnapshot>;
}

export interface RunEvent {
	seq: number;
	key: string;
	timestamp: string;
	type: string;
	level: 'info' | 'success' | 'warning' | 'error';
	stage: StageName | null;
	message: string;
}

export type RunEventInput = Omit<RunEvent, 'seq'>;

export interface RunEventPage {
	events: RunEvent[];
	nextAfter: number;
	hasMore: boolean;
}

export interface RunPatch {
	status?: RunStatus;
	selectedTarget?: DeploymentTarget | null;
	previewPath?: string | null;
	previewProcessId?: string | null;
	previewPort?: number | null;
	sandboxDestroyedAt?: string;
	stage?: {
		name: StageName;
		status?: StageStatus;
		summary?: string | null;
		startedAt?: string | null;
		completedAt?: string | null;
		durationMs?: number | null;
		checks?: StageCheck[];
	};
}

export interface WorkflowParams {
	runId: string;
	fixtureId: FixtureId;
}

export interface FixtureDefinition {
	id: FixtureId;
	name: string;
	commit: string;
	description: string;
	change: string;
	expectedTarget: DeploymentTarget;
	marker: string;
}

export const stageLabels: Record<StageName, string> = {
	baseline: 'Next.js baseline',
	vinext: 'Vinext',
	opennext: 'OpenNext',
	container: 'Container',
	publish: 'Live preview',
};

/** Construct immutable initial run state; the private owner is persisted only in
 * the run Durable Object and is removed from public responses.
 * @param id - New UUID identifying the Workflow, DO, and Sandbox.
 * @param fixtureId - One of the three bundled fixtures.
 * @param ownerPrincipalId - Access or session-derived identity.
 * @param requestedBy - Display label for the owner.
 * @param now - ISO creation timestamp.
 * @returns New queued run snapshot with all stages pending.
 */
export function createInitialRun(
	id: string,
	fixtureId: FixtureId,
	ownerPrincipalId: string,
	requestedBy: string,
	now: string,
): RunSnapshot {
	const stages: Record<StageName, StageSnapshot> = {
		baseline: createStage('baseline'),
		vinext: createStage('vinext'),
		opennext: createStage('opennext'),
		container: createStage('container'),
		publish: createStage('publish'),
	};

	return {
		schemaVersion: 1,
		kind: 'fixture',
		id,
		revision: 0,
		fixtureId,
		ownerPrincipalId,
		requestedBy,
		status: 'queued',
		createdAt: now,
		updatedAt: now,
		terminalAt: null,
		selectedTarget: null,
		previewPath: null,
		previewProcessId: null,
		previewPort: null,
		sandboxDestroyedAt: null,
		stages,
	};
}

/** Strip the internal owner before sending snapshots to browsers/WebSockets.
 * @param snapshot - Private stored snapshot.
 * @returns Visitor-safe snapshot without the owner ID.
 */
export function publicRunSnapshot(snapshot: RunSnapshot): Omit<RunSnapshot, 'ownerPrincipalId'> {
	const { ownerPrincipalId: _, ...publicSnapshot } = snapshot;
	return publicSnapshot;
}

function createStage(name: StageName): StageSnapshot {
	return {
		name,
		label: stageLabels[name],
		status: 'pending',
		summary: null,
		startedAt: null,
		completedAt: null,
		durationMs: null,
		checks: [],
	};
}

export function applyRunPatch(snapshot: RunSnapshot, patch: RunPatch, timestamp: string): RunSnapshot {
	const next: RunSnapshot = {
		...snapshot,
		revision: (snapshot.revision ?? 0) + 1,
		updatedAt: timestamp,
		stages: { ...snapshot.stages },
	};

	if (patch.status !== undefined) {
		next.status = patch.status;
		if (['succeeded', 'failed', 'cancelled'].includes(patch.status) && !snapshot.terminalAt) next.terminalAt = timestamp;
	}
	if (patch.selectedTarget !== undefined) {
		next.selectedTarget = patch.selectedTarget;
	}
	if (patch.previewPath !== undefined) next.previewPath = patch.previewPath;
	if (patch.previewProcessId !== undefined) {
		next.previewProcessId = patch.previewProcessId;
	}
	if (patch.previewPort !== undefined) next.previewPort = patch.previewPort;
	if (patch.sandboxDestroyedAt !== undefined && !snapshot.sandboxDestroyedAt) {
		next.sandboxDestroyedAt = patch.sandboxDestroyedAt;
	}
	if (patch.stage) {
		const current = snapshot.stages[patch.stage.name];
		next.stages[patch.stage.name] = {
			...current,
			...patch.stage,
			name: patch.stage.name,
		};
	}

	return next;
}
