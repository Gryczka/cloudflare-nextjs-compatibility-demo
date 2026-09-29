/** Durable, retryable compatibility ladder and Sandbox preview lifecycle. */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
	stageLabels,
	type CompatibilityStage,
	type DeploymentTarget,
	type RunEventInput,
	type StageExecutionResult,
	type StageName,
	type WorkflowParams,
} from './domain';
import type { RunDurableObject } from './run-durable-object';
import { coordinator, isPublicDemo } from './public-demo';
import { destroyRunSandbox, ensurePreviewArtifact, executeStage, publishPreview } from './sandbox-runner';

const BUILD_STEP_CONFIG = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '30 minutes',
} as const;
const PUBLISH_STEP_CONFIG = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '10 minutes',
} as const;
const PREVIEW_TTL = '30 minutes';

/** Execute native build and adapter fallbacks in order, retaining only the first
 * verified preview. Cleanup remains retryable even after a stage fails.
 */
export class CompatibilityWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { runId, fixtureId } = event.payload;
		const run = this.env.RUNS.getByName(runId);

		const start = await step.do(
			'start compatibility run',
			async () => {
				const snapshot = await run.getSnapshot();
				if (!snapshot) throw new Error('Run state was not initialized');
				if (isTerminal(snapshot.status)) return { started: false, status: snapshot.status };

				const timestamp = new Date().toISOString();
				await run.record(makeEvent('run:started', timestamp, 'run.started', 'info', null, 'Compatibility ladder started'), {
					status: 'running',
				});
				return { started: true, status: 'running' as const };
			},
			{
				rollback: async ({ error }) => {
					try {
						await recordUnhandledFailure(run, error);
					} finally {
						await destroyRunSandbox(this.env, runId);
						await recordSandboxDestroyed(run, 'start rollback');
						if (isPublicDemo(this.env) && !(await coordinator(this.env).releaseRun(runId))) {
							throw new Error('Demo run teardown could not be confirmed');
						}
					}
				},
				rollbackConfig: BUILD_STEP_CONFIG,
			},
		);
		if (!start.started) {
			await this.cleanupStep(step, runId, 'clean up terminal run');
			return { status: start.status, reason: 'already-terminal' };
		}

		try {
			const baseline = await this.runCompatibilityStep(step, runId, fixtureId, 'baseline');
			if (baseline.outcome !== 'compatible') {
				await this.failExpected(step, runId, 'The application does not pass its native Next.js baseline.');
				await this.cleanupStep(step, runId, 'clean up invalid baseline');
				return { status: 'failed', reason: 'invalid-baseline' };
			}

			let selectedTarget: DeploymentTarget | null = null;
			const targets: DeploymentTarget[] = ['vinext', 'opennext', 'container'];
			for (const stage of targets) {
				const result = await this.runCompatibilityStep(step, runId, fixtureId, stage);
				if (result.outcome === 'compatible') {
					selectedTarget = stage;
					break;
				}
			}

			if (!selectedTarget) {
				await this.failExpected(step, runId, 'No supported deployment target passed verification.');
				await this.cleanupStep(step, runId, 'clean up unsupported run');
				return { status: 'failed', reason: 'no-compatible-target' };
			}

			await this.skipLaterTargets(step, runId, selectedTarget);
			await this.publishStep(step, runId, fixtureId, selectedTarget);
			const preview = await this.confirmPreviewStep(step, runId, fixtureId, selectedTarget);
			if (isPublicDemo(this.env) && !(await coordinator(this.env).holdPreview(runId))) {
				throw new Error('Demo build deadline elapsed before the preview was ready');
			}
			const previewPath = `/api/runs/${runId}/preview/`;

			await step.do('complete compatibility run', PUBLISH_STEP_CONFIG, async () => {
				const timestamp = new Date().toISOString();
				const snapshot = await run.getSnapshot();
				await run.record(
					makeEvent(
						'run:completed',
						timestamp,
						'run.completed',
						'success',
						'publish',
						`${stageLabels[selectedTarget]} selected and published`,
					),
					{
						status: 'succeeded',
						selectedTarget,
						previewPath,
						previewProcessId: preview.processId,
						previewPort: preview.port,
						stage: {
							name: 'publish',
							status: 'passed',
							summary: 'Live preview is ready',
							completedAt: timestamp,
							durationMs: elapsedMs(snapshot?.stages.publish.startedAt, timestamp),
						},
					},
				);
				return { recorded: true };
			});
			await step.sleep('keep live preview available', PREVIEW_TTL);
			await step.do('expire live preview', BUILD_STEP_CONFIG, async () => {
				const snapshot = await run.getSnapshot();
				if (snapshot?.status !== 'succeeded' || snapshot.previewProcessId !== preview.processId) {
					if (isPublicDemo(this.env) && !snapshot?.sandboxDestroyedAt) {
						await destroyRunSandbox(this.env, runId);
						if (snapshot) await recordSandboxDestroyed(run, 'preview unavailable');
					}
					return { expired: false };
				}
				await destroyRunSandbox(this.env, runId);
				const timestamp = new Date().toISOString();
				await run.record(makeEvent('preview:expired', timestamp, 'preview.expired', 'info', 'publish', 'Live preview expired'), {
					previewPath: null,
					previewProcessId: null,
					previewPort: null,
					sandboxDestroyedAt: timestamp,
					stage: {
						name: 'publish',
						summary: `Live preview expired after ${PREVIEW_TTL}`,
					},
				});
				return { expired: true };
			});
			if (isPublicDemo(this.env) && !(await coordinator(this.env).releaseRun(runId))) {
				throw new Error('Demo run teardown could not be confirmed');
			}

			return { status: 'succeeded', selectedTarget, previewPath };
		} catch (error) {
			try {
				await step.do('record unhandled workflow failure', BUILD_STEP_CONFIG, async () => {
					await recordUnhandledFailure(run, error);
					return { recorded: true };
				});
			} finally {
				await this.cleanupStep(step, runId, 'clean up failed run');
			}
			throw error;
		}
	}

	private async runCompatibilityStep(
		step: WorkflowStep,
		runId: string,
		fixtureId: WorkflowParams['fixtureId'],
		stage: CompatibilityStage,
	): Promise<StageExecutionResult> {
		const run = this.env.RUNS.getByName(runId);
		try {
			return await step.do<StageExecutionResult>(`evaluate ${stage}`, BUILD_STEP_CONFIG, async (context) => {
				await this.requireDemoCapacity(runId);
				const attemptStartedAt = new Date().toISOString();
				const snapshot = await run.getSnapshot();
				const startedAt = snapshot?.stages[stage].startedAt ?? attemptStartedAt;
				await run.record(
					makeEvent(
						`${stage}:attempt:${context.attempt}:started`,
						attemptStartedAt,
						'stage.started',
						'info',
						stage,
						`${stageLabels[stage]} evaluation started (attempt ${context.attempt})`,
					),
					{
						stage: {
							name: stage,
							status: context.attempt === 1 ? 'running' : 'retrying',
							startedAt,
							summary: null,
							completedAt: null,
							durationMs: null,
							checks: [],
						},
					},
				);

				const result = await executeStage(this.env, runId, fixtureId, stage, (logEvent) =>
					run.record({ ...logEvent, key: `${stage}:attempt:${context.attempt}:${logEvent.key}` }),
				);
				await this.requireDemoCapacity(runId);
				const completedAt = new Date().toISOString();
				const passed = result.outcome === 'compatible';
				await run.record(
					makeEvent(
						`${stage}:attempt:${context.attempt}:completed`,
						completedAt,
						passed ? 'stage.passed' : 'stage.incompatible',
						passed ? 'success' : 'warning',
						stage,
						result.summary,
					),
					{
						stage: {
							name: stage,
							status: passed ? 'passed' : stage === 'baseline' ? 'failed' : 'incompatible',
							summary: result.summary,
							completedAt,
							durationMs: result.durationMs,
							checks: result.checks,
						},
					},
				);
				return result;
			});
		} catch (error) {
			await step.do(`record ${stage} infrastructure failure`, async () => {
				const timestamp = new Date().toISOString();
				await run.record(makeEvent(`${stage}:infrastructure-failure`, timestamp, 'stage.failed', 'error', stage, toErrorMessage(error)), {
					status: 'failed',
					stage: {
						name: stage,
						status: 'failed',
						summary: 'Build infrastructure failed after retries',
						completedAt: timestamp,
					},
				});
				return { recorded: true };
			});
			throw error;
		}
	}

	private async publishStep(step: WorkflowStep, runId: string, fixtureId: WorkflowParams['fixtureId'], target: DeploymentTarget) {
		const run = this.env.RUNS.getByName(runId);
		try {
			return await step.do('publish live preview', PUBLISH_STEP_CONFIG, async (context) => {
				await this.requireDemoCapacity(runId);
				const timestamp = new Date().toISOString();
				const snapshot = await run.getSnapshot();
				const startedAt = snapshot?.stages.publish.startedAt ?? timestamp;
				await run.record(
					makeEvent(
						`publish:attempt:${context.attempt}:started`,
						timestamp,
						'publish.started',
						'info',
						'publish',
						`Starting ${stageLabels[target]} preview`,
					),
					{
						selectedTarget: target,
						stage: {
							name: 'publish',
							status: context.attempt === 1 ? 'running' : 'retrying',
							startedAt,
							summary: `Launching ${stageLabels[target]}`,
						},
					},
				);
				const restored = await ensurePreviewArtifact(this.env, runId, fixtureId, target, (event) =>
					run.record({ ...event, key: `publish:attempt:${context.attempt}:restore:${event.key}` }),
				);
				if (restored) {
					const restoredAt = new Date().toISOString();
					await run.record(
						makeEvent(
							`publish:attempt:${context.attempt}:restored`,
							restoredAt,
							'publish.restored',
							'info',
							'publish',
							`${stageLabels[target]} artifacts were rebuilt after the Sandbox restarted`,
						),
					);
				}
				const preview = await publishPreview(this.env, runId, fixtureId, target);
				await this.requireDemoCapacity(runId);
				return preview;
			});
		} catch (error) {
			await step.do('record preview failure', async () => {
				const timestamp = new Date().toISOString();
				await run.record(makeEvent('publish:failed', timestamp, 'publish.failed', 'error', 'publish', toErrorMessage(error)), {
					status: 'failed',
					stage: {
						name: 'publish',
						status: 'failed',
						summary: 'Preview failed after retries',
						completedAt: timestamp,
					},
				});
				return { recorded: true };
			});
			throw error;
		}
	}

	private async confirmPreviewStep(step: WorkflowStep, runId: string, fixtureId: WorkflowParams['fixtureId'], target: DeploymentTarget) {
		const run = this.env.RUNS.getByName(runId);
		return step.do('confirm live preview', PUBLISH_STEP_CONFIG, async (context) => {
			await this.requireDemoCapacity(runId);
			const restored = await ensurePreviewArtifact(this.env, runId, fixtureId, target, (event) =>
				run.record({ ...event, key: `confirm:attempt:${context.attempt}:restore:${event.key}` }),
			);
			if (restored) {
				const timestamp = new Date().toISOString();
				await run.record(
					makeEvent(
						`confirm:attempt:${context.attempt}:restored`,
						timestamp,
						'publish.restored',
						'info',
						'publish',
						`${stageLabels[target]} artifacts were rebuilt before final publication`,
					),
				);
			}
			const preview = await publishPreview(this.env, runId, fixtureId, target);
			await this.requireDemoCapacity(runId);
			return preview;
		});
	}

	private async skipLaterTargets(step: WorkflowStep, runId: string, selectedTarget: DeploymentTarget) {
		const targets: DeploymentTarget[] = ['vinext', 'opennext', 'container'];
		const laterTargets = targets.slice(targets.indexOf(selectedTarget) + 1);
		if (laterTargets.length === 0) return;
		const run = this.env.RUNS.getByName(runId);

		await step.do('skip unnecessary fallbacks', async () => {
			for (const stage of laterTargets) {
				const timestamp = new Date().toISOString();
				await run.record(makeEvent(`${stage}:skipped`, timestamp, 'stage.skipped', 'info', stage, `${stageLabels[stage]} was not needed`), {
					stage: {
						name: stage,
						status: 'skipped',
						summary: `Stopped after ${stageLabels[selectedTarget]} passed`,
						completedAt: timestamp,
					},
				});
			}
			return { skipped: laterTargets };
		});
	}

	private async failExpected(step: WorkflowStep, runId: string, message: string) {
		const run = this.env.RUNS.getByName(runId);
		await step.do('record expected pipeline failure', async () => {
			const timestamp = new Date().toISOString();
			await run.record(makeEvent('run:failed', timestamp, 'run.failed', 'error', null, message), { status: 'failed' });
			return { recorded: true };
		});
	}

	private async cleanupStep(step: WorkflowStep, runId: string, name: string) {
		const run = this.env.RUNS.getByName(runId);
		await step.do(name, BUILD_STEP_CONFIG, async () => {
			await destroyRunSandbox(this.env, runId);
			await recordSandboxDestroyed(run, name);
			return { destroyed: true };
		});
		if (isPublicDemo(this.env) && !(await coordinator(this.env).releaseRun(runId))) {
			throw new Error('Demo run teardown could not be confirmed');
		}
	}

	private async requireDemoCapacity(runId: string): Promise<void> {
		if (isPublicDemo(this.env) && !(await coordinator(this.env).canRun(runId))) {
			throw new Error('Demo build deadline elapsed or the run was cancelled');
		}
	}
}

function makeEvent(
	key: string,
	timestamp: string,
	type: string,
	level: RunEventInput['level'],
	stage: StageName | null,
	message: string,
): RunEventInput {
	return { key, timestamp, type, level, stage, message };
}

function toErrorMessage(error: unknown) {
	return error instanceof Error ? error.message.slice(0, 4_000) : String(error);
}

function isTerminal(status: string) {
	return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function elapsedMs(start: string | null | undefined, end: string): number | null {
	if (!start) return null;
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
}

async function recordUnhandledFailure(run: DurableObjectStub<RunDurableObject>, error: unknown) {
	const snapshot = await run.getSnapshot();
	if (!snapshot || snapshot.status === 'failed' || snapshot.status === 'cancelled') return;

	const timestamp = new Date().toISOString();
	if (snapshot.status === 'succeeded') {
		await run.record(
			makeEvent('preview:workflow-failed', timestamp, 'preview.expired', 'warning', 'publish', 'Live preview became unavailable'),
			{ previewPath: null, previewProcessId: null, previewPort: null },
		);
		return;
	}

	await run.record(makeEvent('run:workflow-failed', timestamp, 'run.failed', 'error', null, toErrorMessage(error)), {
		status: 'failed',
		previewPath: null,
		previewProcessId: null,
		previewPort: null,
	});
}

async function recordSandboxDestroyed(run: DurableObjectStub<RunDurableObject>, reason: string) {
	const timestamp = new Date().toISOString();
	await run.markSandboxDestroyed(timestamp, reason);
}
