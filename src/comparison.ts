/** Read-time measured timing and explicitly modeled pricing for the fixture ladder. */
import type { DeploymentTarget, RunSnapshot, StageStatus } from './domain';

export const COMPARISON_MODEL_VERSION = '2026-09-28.1';

const TARGETS: DeploymentTarget[] = ['vinext', 'opennext', 'container'];
const PREVIEW_HOLD_MS = 30 * 60 * 1_000;
const SANDBOX = {
	vcpu: 0.5,
	memoryGib: 4,
	diskGb: 8,
};
const RATES = {
	workerMonthlyBaseUsd: 5,
	workerIncludedRequests: 10_000_000,
	workerRequestUsdPerMillion: 0.3,
	workerIncludedCpuMs: 30_000_000,
	workerCpuUsdPerMillionMs: 0.02,
	containerIncludedMemoryGibHours: 25,
	containerMemoryUsdPerGibSecond: 0.0000025,
	containerIncludedCpuMinutes: 375,
	containerCpuUsdPerVcpuSecond: 0.00002,
	containerIncludedDiskGbHours: 200,
	containerDiskUsdPerGbSecond: 0.00000007,
	wfpMonthlyBaseUsd: 25,
	wfpIncludedRequests: 20_000_000,
	wfpIncludedCpuMs: 60_000_000,
	wfpIncludedScripts: 1_000,
	wfpScriptUsd: 0.02,
};

export interface TargetTiming {
	target: DeploymentTarget;
	label: string;
	status: StageStatus;
	evaluationMs: number | null;
	wallMs: number | null;
	cumulativeDecisionMs: number | null;
	measurementScope: string;
}

export interface RuntimeTargetCost {
	target: DeploymentTarget | 'wfp';
	label: string;
	monthlyUsd: number;
	basis: string;
	caveat: string;
}

export interface CostRange {
	lowerUsd: number;
	upperUsd: number;
}

export interface RunComparison {
	modelVersion: string;
	asOf: string;
	generatedAt: string;
	snapshotRevision: number | null;
	measurementNote: string;
	pricingNote: string;
	sources: Array<{ label: string; url: string }>;
	runtimeAssumptions: string[];
	runtimeTargets: RuntimeTargetCost[];
	timing: {
		queueToFirstStageMs: number | null;
		selectedDecisionMs: number | null;
		verifiedPreviewMs: number | null;
		targets: TargetTiming[];
	};
	pipelineCost: {
		basisDurationMs: number | null;
		toReady: CostRange | null;
		previewHold: CostRange;
		basis: string;
		assumptions: string[];
	};
	platformStory: {
		name: string;
		observation: string;
		flow: string[];
	};
}

/** Recompute prices from a versioned model while using only observed stage
 * timestamps for run timing; no pricing is persisted with a run.
 * @param snapshot - Stored run or null for an unstarted fixture list.
 * @param now - Clock value for in-flight resource windows.
 * @returns Separate measured timings and explicitly modeled monthly costs.
 */
export function buildRunComparison(snapshot: RunSnapshot | null, now: Date | string | number = Date.now()): RunComparison {
	const nowMs = timestampMs(now) ?? Date.now();
	const targetTimings = TARGETS.map((target) => targetTiming(snapshot, target, nowMs));
	const selectedTarget = snapshot?.selectedTarget ?? TARGETS.find((target) => snapshot?.stages[target].status === 'passed') ?? null;
	const selectedDecisionMs = selectedTarget
		? (targetTimings.find((timing) => timing.target === selectedTarget)?.cumulativeDecisionMs ?? null)
		: null;
	const verifiedPreviewMs =
		snapshot?.stages.publish.status === 'passed' ? elapsedMs(snapshot.createdAt, snapshot.stages.publish.completedAt) : null;
	const queueToFirstStageMs = snapshot ? elapsedMs(snapshot.createdAt, snapshot.stages.baseline.startedAt) : null;
	const pipelineDurationMs = pipelineWindowMs(snapshot, nowMs);

	return {
		modelVersion: COMPARISON_MODEL_VERSION,
		asOf: '2026-09-02',
		generatedAt: new Date(nowMs).toISOString(),
		snapshotRevision: typeof snapshot?.revision === 'number' ? snapshot.revision : null,
		measurementNote:
			'This run measures adapter evaluation and verified Sandbox preview readiness. It does not perform a production rollout.',
		pricingNote:
			'Costs are reference scenarios at public list prices. Included usage is account-wide, so the marginal invoice can be lower.',
		sources: [
			{ label: 'Workers pricing', url: 'https://developers.cloudflare.com/workers/platform/pricing/' },
			{ label: 'Containers pricing', url: 'https://developers.cloudflare.com/containers/platform/pricing/' },
			{ label: 'Sandbox pricing', url: 'https://developers.cloudflare.com/sandbox/platform/pricing/' },
			{
				label: 'Workers for Platforms pricing',
				url: 'https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/',
			},
		],
		runtimeAssumptions: [
			'10 million dynamic requests per month',
			'5 ms average CPU per request for Workers targets',
			'Container: standard-1, 100 active hours, 20% average CPU utilization',
			'Container front Worker: 1 ms average CPU per request',
			'Workers for Platforms: 100 isolated user Workers',
		],
		runtimeTargets: runtimeTargetCosts(),
		timing: {
			queueToFirstStageMs,
			selectedDecisionMs,
			verifiedPreviewMs,
			targets: targetTimings,
		},
		pipelineCost: {
			basisDurationMs: pipelineDurationMs,
			toReady: pipelineDurationMs === null ? null : sandboxCostRange(pipelineDurationMs),
			previewHold: sandboxCostRange(PREVIEW_HOLD_MS),
			basis:
				snapshot?.stages.publish.status === 'passed'
					? 'Sandbox window through verified preview'
					: snapshot?.sandboxDestroyedAt
						? 'Sandbox window through teardown'
						: 'Sandbox window observed so far',
			assumptions: [
				'standard-1 provisions 4 GiB memory and 8 GB disk with up to 0.5 vCPU',
				'CPU range spans 0% to 100% utilization because per-run CPU usage is unavailable',
				'Values use overage rates before monthly included usage',
				'Workflow, Durable Object, logs, network egress, and the optional 30-minute preview hold are excluded',
			],
		},
		platformStory: {
			name: 'Fixed-template publisher',
			observation: 'The WfP example measures each fixed-template upload separately; its runtime cost is a modeled scenario.',
			flow: [
				'Validate bounded manifest',
				'Reserve visitor capacity',
				'Upload platform-owned Worker',
				'Confirm tenant registry',
				'Route and dispatch',
			],
		},
	};
}

function targetTiming(snapshot: RunSnapshot | null, target: DeploymentTarget, nowMs: number): TargetTiming {
	const stage = snapshot?.stages[target];
	const wasActive = stage?.status === 'running' || stage?.status === 'retrying';
	const terminalRun = snapshot ? ['succeeded', 'failed', 'cancelled'].includes(snapshot.status) : false;
	const terminalEnd = snapshot?.terminalAt ?? snapshot?.updatedAt;
	const status =
		wasActive && snapshot?.status === 'cancelled'
			? 'cancelled'
			: wasActive && snapshot?.status === 'failed'
				? 'failed'
				: (stage?.status ?? 'pending');
	const completedDecision = Boolean(stage?.completedAt && ['passed', 'incompatible', 'failed'].includes(status));
	const settled = Boolean(stage?.completedAt && !['pending', 'running', 'retrying', 'skipped'].includes(status));
	const wallEnd = settled ? stage?.completedAt : wasActive ? (terminalRun ? terminalEnd : nowMs) : null;

	return {
		target,
		label: target === 'opennext' ? 'OpenNext' : target === 'vinext' ? 'Vinext' : 'Container',
		status,
		evaluationMs: nonNegative(stage?.durationMs),
		wallMs: stage?.startedAt && wallEnd !== null ? elapsedMs(stage.startedAt, wallEnd) : null,
		cumulativeDecisionMs: snapshot && completedDecision ? elapsedMs(snapshot.createdAt, stage?.completedAt) : null,
		measurementScope:
			target === 'vinext'
				? 'Vite build plus Vinext Node production preview'
				: target === 'opennext'
					? 'OpenNext build plus local workerd preview'
					: 'Standalone build plus local Docker runtime',
	};
}

function runtimeTargetCosts(): RuntimeTargetCost[] {
	const monthlyRequests = 10_000_000;
	const workerCpuMs = 5;
	const workerMonthlyUsd = workersMonthlyCost(monthlyRequests, workerCpuMs);
	const containerMonthlyUsd = containerMonthlyCost(monthlyRequests, 100, 0.2);
	const wfpMonthlyUsd = wfpMonthlyCost(monthlyRequests, workerCpuMs, 100);

	return [
		{
			target: 'vinext',
			label: 'Vinext on Workers',
			monthlyUsd: workerMonthlyUsd,
			basis: 'Workers Paid, 10M requests at 5 ms CPU',
			caveat: 'Same Workers rate card as other Worker-native adapters; production CPU determines the real total.',
		},
		{
			target: 'opennext',
			label: 'OpenNext on Workers',
			monthlyUsd: workerMonthlyUsd,
			basis: 'Workers Paid, 10M requests at 5 ms CPU',
			caveat: 'Build time does not predict request CPU; measure the deployed application before forecasting.',
		},
		{
			target: 'container',
			label: 'Container',
			monthlyUsd: containerMonthlyUsd,
			basis: 'Workers Paid plus standard-1 for 100 active hours at 20% CPU',
			caveat: 'Scale-to-zero workload; memory and disk use provisioned capacity while CPU uses active utilization.',
		},
		{
			target: 'wfp',
			label: 'Workers for Platforms',
			monthlyUsd: wfpMonthlyUsd,
			basis: 'WfP Paid, 100 scripts, 10M requests at 5 ms CPU',
			caveat: 'A platform plan for many isolated tenants, not a single-application hosting tier.',
		},
	];
}

function workersMonthlyCost(monthlyRequests: number, cpuMsPerRequest: number): number {
	const requestOverage = Math.max(0, monthlyRequests - RATES.workerIncludedRequests) / 1_000_000;
	const cpuOverage = Math.max(0, monthlyRequests * cpuMsPerRequest - RATES.workerIncludedCpuMs) / 1_000_000;
	return roundUsd(
		RATES.workerMonthlyBaseUsd + requestOverage * RATES.workerRequestUsdPerMillion + cpuOverage * RATES.workerCpuUsdPerMillionMs,
		4,
	);
}

function containerMonthlyCost(monthlyRequests: number, activeHours: number, cpuUtilization: number): number {
	const proxyCpuMsPerRequest = 1;
	const workerRequestOverage = Math.max(0, monthlyRequests - RATES.workerIncludedRequests) / 1_000_000;
	const workerCpuOverage = Math.max(0, monthlyRequests * proxyCpuMsPerRequest - RATES.workerIncludedCpuMs) / 1_000_000;
	const memoryOverageSeconds = Math.max(0, SANDBOX.memoryGib * activeHours - RATES.containerIncludedMemoryGibHours) * 3_600;
	const diskOverageSeconds = Math.max(0, SANDBOX.diskGb * activeHours - RATES.containerIncludedDiskGbHours) * 3_600;
	const cpuMinutes = SANDBOX.vcpu * cpuUtilization * activeHours * 60;
	const cpuOverageSeconds = Math.max(0, cpuMinutes - RATES.containerIncludedCpuMinutes) * 60;

	return roundUsd(
		RATES.workerMonthlyBaseUsd +
			workerRequestOverage * RATES.workerRequestUsdPerMillion +
			workerCpuOverage * RATES.workerCpuUsdPerMillionMs +
			memoryOverageSeconds * RATES.containerMemoryUsdPerGibSecond +
			cpuOverageSeconds * RATES.containerCpuUsdPerVcpuSecond +
			diskOverageSeconds * RATES.containerDiskUsdPerGbSecond,
		4,
	);
}

function wfpMonthlyCost(monthlyRequests: number, cpuMsPerRequest: number, scripts: number): number {
	const requestOverage = Math.max(0, monthlyRequests - RATES.wfpIncludedRequests) / 1_000_000;
	const cpuOverage = Math.max(0, monthlyRequests * cpuMsPerRequest - RATES.wfpIncludedCpuMs) / 1_000_000;
	const scriptOverage = Math.max(0, scripts - RATES.wfpIncludedScripts);
	return roundUsd(
		RATES.wfpMonthlyBaseUsd +
			requestOverage * RATES.workerRequestUsdPerMillion +
			cpuOverage * RATES.workerCpuUsdPerMillionMs +
			scriptOverage * RATES.wfpScriptUsd,
		4,
	);
}

function pipelineWindowMs(snapshot: RunSnapshot | null, nowMs: number): number | null {
	const startedAt = snapshot?.stages.baseline.startedAt;
	if (!snapshot || !startedAt) return null;
	const endedAt =
		snapshot.stages.publish.status === 'passed' && snapshot.stages.publish.completedAt
			? snapshot.stages.publish.completedAt
			: ['failed', 'cancelled'].includes(snapshot.status)
				? snapshot.sandboxDestroyedAt === undefined
					? snapshot.updatedAt
					: (snapshot.sandboxDestroyedAt ?? nowMs)
				: nowMs;
	return elapsedMs(startedAt, endedAt);
}

function sandboxCostRange(durationMs: number): CostRange {
	const seconds = durationMs / 1_000;
	// Sandbox SDK inherits the underlying Containers memory, disk, and active CPU meters.
	const memoryAndDisk =
		seconds * (SANDBOX.memoryGib * RATES.containerMemoryUsdPerGibSecond + SANDBOX.diskGb * RATES.containerDiskUsdPerGbSecond);
	const maximumCpu = seconds * SANDBOX.vcpu * RATES.containerCpuUsdPerVcpuSecond;
	return {
		lowerUsd: roundUsd(memoryAndDisk, 6),
		upperUsd: roundUsd(memoryAndDisk + maximumCpu, 6),
	};
}

function elapsedMs(start: Date | string | number | null | undefined, end: Date | string | number | null | undefined): number | null {
	const startMs = timestampMs(start);
	const endMs = timestampMs(end);
	return startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null;
}

function timestampMs(value: Date | string | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function nonNegative(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function roundUsd(value: number, digits: number): number {
	return Number(value.toFixed(digits));
}
