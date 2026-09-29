import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildRunComparison, COMPARISON_MODEL_VERSION } from '../src/comparison';
import { applyRunPatch, createInitialRun } from '../src/domain';
import { previewArtifactPath } from '../src/sandbox-runner';

describe('control-plane HTTP API', () => {
	it('serves the authenticated application shell', async () => {
		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
		expect(await response.text()).toContain('One application.');
	});

	it('lists the controlled fixture matrix', async () => {
		const response = await SELF.fetch('https://example.com/api/fixtures');
		const body = await response.json<{
			fixtures: Array<{ id: string; expectedTarget: string }>;
			comparison: { modelVersion: string; runtimeTargets: Array<{ target: string; monthlyUsd: number }> };
		}>();

		expect(response.status).toBe(200);
		expect(body.fixtures.map((fixture) => [fixture.id, fixture.expectedTarget])).toEqual([
			['vinext', 'vinext'],
			['opennext', 'opennext'],
			['container', 'container'],
		]);
		expect(body.comparison.modelVersion).toBe(COMPARISON_MODEL_VERSION);
		expect(body.comparison.runtimeTargets.map((target) => [target.target, target.monthlyUsd])).toEqual([
			['vinext', 5.4],
			['opennext', 5.4],
			['container', 8.7962],
			['wfp', 25],
		]);
	});

	it('rejects an unknown fixture before creating a Workflow', async () => {
		const response = await SELF.fetch('https://example.com/api/runs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ fixtureId: 'unknown' }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'fixtureId must be vinext, opennext, or container',
		});
	});

	it('returns client errors for malformed and oversized request bodies', async () => {
		const malformed = await SELF.fetch('https://example.com/api/runs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{',
		});
		const oversized = await SELF.fetch('https://example.com/api/runs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'x'.repeat(4_097),
		});

		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({ error: 'Request body must be valid JSON' });
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toEqual({ error: 'Request body is too large' });
	});

	it('requires same-origin JSON for run creation', async () => {
		const nonJson = await SELF.fetch('https://example.com/api/runs', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: JSON.stringify({ fixtureId: 'vinext' }),
		});
		const crossOrigin = await SELF.fetch('https://example.com/api/runs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
			body: JSON.stringify({ fixtureId: 'vinext' }),
		});

		expect(nonJson.status).toBe(415);
		expect(await nonJson.json()).toEqual({ error: 'Content-Type must be application/json' });
		expect(crossOrigin.status).toBe(403);
		expect(await crossOrigin.json()).toEqual({ error: 'Cross-origin run creation is not allowed' });
	});

	it('sandboxes embedded fixture previews', async () => {
		const response = await SELF.fetch('https://example.com/');
		const html = await response.text();

		expect(html).toContain('sandbox="allow-scripts"');
		expect(html).toContain('referrerpolicy="no-referrer"');
		expect(html).toContain('Time is observed.');
		expect(html).toContain('Try the fixed-template publisher');
		expect(html).toContain('Emdash builds. WfP ships.');
	});
});

describe('comparison model', () => {
	it('derives measured timing without changing persisted run state', () => {
		const createdAt = '2026-09-02T12:00:00.000Z';
		let snapshot = createInitialRun(crypto.randomUUID(), 'vinext', 'access-user:test', 'test@example.com', createdAt);
		snapshot = applyRunPatch(
			snapshot,
			{ status: 'running', stage: { name: 'baseline', status: 'running', startedAt: '2026-09-02T12:00:01.000Z' } },
			'2026-09-02T12:00:01.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{
				stage: {
					name: 'baseline',
					status: 'passed',
					completedAt: '2026-09-02T12:00:11.000Z',
					durationMs: 9_000,
				},
			},
			'2026-09-02T12:00:11.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{ stage: { name: 'vinext', status: 'running', startedAt: '2026-09-02T12:00:12.000Z' } },
			'2026-09-02T12:00:12.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{
				stage: {
					name: 'vinext',
					status: 'passed',
					completedAt: '2026-09-02T12:00:32.000Z',
					durationMs: 19_000,
				},
				selectedTarget: 'vinext',
			},
			'2026-09-02T12:00:32.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{ stage: { name: 'publish', status: 'running', startedAt: '2026-09-02T12:00:33.000Z' } },
			'2026-09-02T12:00:33.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{
				status: 'succeeded',
				stage: {
					name: 'publish',
					status: 'passed',
					completedAt: '2026-09-02T12:00:36.000Z',
					durationMs: 3_000,
				},
			},
			'2026-09-02T12:00:36.000Z',
		);

		const comparison = buildRunComparison(snapshot, '2026-09-02T12:05:00.000Z');
		const vinext = comparison.timing.targets.find((target) => target.target === 'vinext');

		expect(comparison.timing.queueToFirstStageMs).toBe(1_000);
		expect(comparison.timing.selectedDecisionMs).toBe(32_000);
		expect(comparison.timing.verifiedPreviewMs).toBe(36_000);
		expect(comparison.generatedAt).toBe('2026-09-02T12:05:00.000Z');
		expect(comparison.snapshotRevision).toBe(snapshot.revision);
		expect(vinext).toMatchObject({ evaluationMs: 19_000, wallMs: 20_000, cumulativeDecisionMs: 32_000 });
		expect(comparison.pipelineCost.basisDurationMs).toBe(35_000);
		expect(comparison.pipelineCost.previewHold).toEqual({ lowerUsd: 0.019008, upperUsd: 0.037008 });
		expect(comparison.platformStory).toMatchObject({
			name: 'Fixed-template publisher',
			observation: expect.stringContaining('measures each fixed-template upload separately'),
		});
		expect(snapshot).not.toHaveProperty('comparison');
	});

	it('leaves invalid and skipped measurements empty', () => {
		let snapshot = createInitialRun(crypto.randomUUID(), 'vinext', 'access-user:test', 'test@example.com', 'not-a-date');
		snapshot = applyRunPatch(
			snapshot,
			{
				stage: { name: 'baseline', status: 'running', startedAt: 'also-not-a-date' },
			},
			'still-not-a-date',
		);
		snapshot = applyRunPatch(
			snapshot,
			{
				stage: { name: 'vinext', status: 'skipped', completedAt: '2026-09-02T12:00:00.000Z' },
			},
			'2026-09-02T12:00:00.000Z',
		);

		const comparison = buildRunComparison(snapshot, '2026-09-02T12:05:00.000Z');
		const vinext = comparison.timing.targets.find((target) => target.target === 'vinext');

		expect(comparison.timing.queueToFirstStageMs).toBeNull();
		expect(comparison.pipelineCost.toReady).toBeNull();
		expect(vinext?.evaluationMs).toBeNull();
		expect(vinext?.cumulativeDecisionMs).toBeNull();
	});

	it('caps an active target and resource window when a run is cancelled', () => {
		let snapshot = createInitialRun(crypto.randomUUID(), 'vinext', 'access-user:test', 'test@example.com', '2026-09-02T12:00:00.000Z');
		snapshot = applyRunPatch(
			snapshot,
			{
				status: 'running',
				stage: { name: 'baseline', status: 'running', startedAt: '2026-09-02T12:00:01.000Z' },
			},
			'2026-09-02T12:00:01.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{
				stage: {
					name: 'baseline',
					status: 'passed',
					completedAt: '2026-09-02T12:00:02.000Z',
					durationMs: 1_000,
				},
			},
			'2026-09-02T12:00:02.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{ stage: { name: 'vinext', status: 'running', startedAt: '2026-09-02T12:00:03.000Z' } },
			'2026-09-02T12:00:03.000Z',
		);
		snapshot = applyRunPatch(snapshot, { status: 'cancelled', sandboxDestroyedAt: '2026-09-02T12:00:10.000Z' }, '2026-09-02T12:00:10.000Z');

		const comparison = buildRunComparison(snapshot, '2026-09-02T13:00:00.000Z');
		const vinext = comparison.timing.targets.find((target) => target.target === 'vinext');

		expect(vinext).toMatchObject({ status: 'cancelled', wallMs: 7_000, cumulativeDecisionMs: null });
		expect(comparison.pipelineCost.basisDurationMs).toBe(9_000);
	});

	it('tracks failed-run cost through teardown without extending target timing', () => {
		let snapshot = createInitialRun(crypto.randomUUID(), 'vinext', 'access-user:test', 'test@example.com', '2026-09-02T12:00:00.000Z');
		snapshot = applyRunPatch(
			snapshot,
			{
				status: 'running',
				stage: { name: 'baseline', status: 'running', startedAt: '2026-09-02T12:00:01.000Z' },
			},
			'2026-09-02T12:00:01.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{
				stage: {
					name: 'baseline',
					status: 'passed',
					completedAt: '2026-09-02T12:00:02.000Z',
					durationMs: 1_000,
				},
			},
			'2026-09-02T12:00:02.000Z',
		);
		snapshot = applyRunPatch(
			snapshot,
			{ stage: { name: 'vinext', status: 'running', startedAt: '2026-09-02T12:00:03.000Z' } },
			'2026-09-02T12:00:03.000Z',
		);
		snapshot = applyRunPatch(snapshot, { status: 'failed' }, '2026-09-02T12:00:10.000Z');

		const pendingCleanup = buildRunComparison(snapshot, '2026-09-02T12:00:12.000Z');
		expect(pendingCleanup.pipelineCost.basisDurationMs).toBe(11_000);
		expect(pendingCleanup.timing.targets.find((target) => target.target === 'vinext')).toMatchObject({
			status: 'failed',
			wallMs: 7_000,
		});

		snapshot = applyRunPatch(snapshot, { sandboxDestroyedAt: '2026-09-02T12:00:15.000Z' }, '2026-09-02T12:00:15.000Z');
		const cleanedUp = buildRunComparison(snapshot, '2026-09-02T13:00:00.000Z');
		expect(cleanedUp.pipelineCost.basisDurationMs).toBe(14_000);
		expect(cleanedUp.pipelineCost.basis).toBe('Sandbox window through teardown');
		expect(cleanedUp.timing.targets.find((target) => target.target === 'vinext')?.wallMs).toBe(7_000);
	});

	it('uses the Vinext App Router server entry as the preview artifact', () => {
		const runId = '11111111-1111-4111-8111-111111111111';
		expect(previewArtifactPath(runId, 'vinext')).toBe(`/workspace/runs/${runId}/vinext/dist/server/index.js`);
	});
});

describe('RunDurableObject', () => {
	it('streams a comparison with each WebSocket snapshot', async () => {
		const runId = crypto.randomUUID();
		const stub = env.RUNS.getByName(runId);
		await stub.initialize(createInitialRun(runId, 'vinext', 'access-user:test', 'test@example.com', '2026-09-02T12:00:00.000Z'));

		const response = await stub.fetch(
			new Request('https://example.com/ws', {
				headers: { Upgrade: 'websocket', 'X-Compatibility-Run-Owner': 'access-user:test' },
			}),
		);
		const client = response.webSocket;
		expect(response.status).toBe(101);
		expect(client).not.toBeNull();
		if (!client) throw new Error('Expected WebSocket');

		const initialMessage = nextWebSocketMessage(client);
		client.accept();
		const initial = JSON.parse(String((await initialMessage).data));
		expect(initial.comparison.modelVersion).toBe(COMPARISON_MODEL_VERSION);
		expect(initial.snapshot.revision).toBe(0);
		expect(initial.snapshot.ownerPrincipalId).toBeUndefined();

		const logMessage = nextWebSocketMessage(client);
		await stub.record({
			key: 'baseline:log',
			timestamp: '2026-09-02T12:00:00.500Z',
			type: 'stage.log',
			level: 'info',
			stage: 'baseline',
			message: 'Preparing workspace',
		});
		const log = JSON.parse(String((await logMessage).data));
		expect(log.comparison).toBeUndefined();
		expect(log.snapshot.revision).toBe(0);

		const eventMessage = nextWebSocketMessage(client);
		await stub.record(
			{
				key: 'baseline:started',
				timestamp: '2026-09-02T12:00:01.000Z',
				type: 'stage.started',
				level: 'info',
				stage: 'baseline',
				message: 'Baseline started',
			},
			{ status: 'running', stage: { name: 'baseline', status: 'running', startedAt: '2026-09-02T12:00:01.000Z' } },
		);
		const streamed = JSON.parse(String((await eventMessage).data));
		expect(streamed.comparison.timing.queueToFirstStageMs).toBe(1_000);
		expect(streamed.snapshot.revision).toBe(1);
		client.close(1000, 'Test complete');
	});

	it('records Sandbox teardown after a terminal failure', async () => {
		const runId = crypto.randomUUID();
		const stub = env.RUNS.getByName(runId);
		await stub.initialize(createInitialRun(runId, 'vinext', 'access-user:test', 'test@example.com', '2026-09-02T12:00:00.000Z'));
		await stub.record(
			{
				key: 'run:failed',
				timestamp: '2026-09-02T12:00:10.000Z',
				type: 'run.failed',
				level: 'error',
				stage: null,
				message: 'Run failed',
			},
			{ status: 'failed' },
		);
		await stub.markSandboxDestroyed('2026-09-02T12:00:15.000Z', 'test');
		await stub.markSandboxDestroyed('2026-09-02T12:00:20.000Z', 'duplicate');

		const snapshot = await stub.getSnapshot();
		expect(snapshot).toMatchObject({
			status: 'failed',
			revision: 2,
			updatedAt: '2026-09-02T12:00:15.000Z',
			sandboxDestroyedAt: '2026-09-02T12:00:15.000Z',
		});
		expect((await stub.getEvents()).events.map((event) => event.key)).toEqual(['run:created', 'run:failed', 'sandbox:destroyed:test']);
	});

	it('atomically cancels the latest active stage', async () => {
		const runId = crypto.randomUUID();
		const stub = env.RUNS.getByName(runId);
		await stub.initialize(createInitialRun(runId, 'vinext', 'access-user:test', 'test@example.com', '2026-09-02T12:00:00.000Z'));
		await stub.record(
			{
				key: 'baseline:started',
				timestamp: '2026-09-02T12:00:01.000Z',
				type: 'stage.started',
				level: 'info',
				stage: 'baseline',
				message: 'Baseline started',
			},
			{ status: 'running', stage: { name: 'baseline', status: 'running', startedAt: '2026-09-02T12:00:01.000Z' } },
		);
		await stub.record(
			{
				key: 'vinext:started',
				timestamp: '2026-09-02T12:00:02.000Z',
				type: 'stage.started',
				level: 'info',
				stage: 'vinext',
				message: 'Vinext started',
			},
			{
				stage: { name: 'baseline', status: 'passed', completedAt: '2026-09-02T12:00:02.000Z' },
			},
		);
		await stub.record(
			{
				key: 'vinext:running',
				timestamp: '2026-09-02T12:00:03.000Z',
				type: 'stage.started',
				level: 'info',
				stage: 'vinext',
				message: 'Vinext running',
			},
			{ stage: { name: 'vinext', status: 'running', startedAt: '2026-09-02T12:00:03.000Z' } },
		);

		const cancelled = await stub.cancel('2026-09-02T12:00:04.000Z');
		expect(cancelled).toMatchObject({
			status: 'cancelled',
			terminalAt: '2026-09-02T12:00:04.000Z',
			sandboxDestroyedAt: null,
		});
		expect(cancelled.stages.baseline.status).toBe('passed');
		expect(cancelled.stages.vinext).toMatchObject({
			status: 'cancelled',
			completedAt: '2026-09-02T12:00:04.000Z',
		});

		const cleanedUp = await stub.markSandboxDestroyed('2026-09-02T12:00:05.000Z', 'cancellation');
		expect(cleanedUp.sandboxDestroyedAt).toBe('2026-09-02T12:00:05.000Z');
	});

	it('persists state, ordered events, and idempotency keys', async () => {
		const runId = crypto.randomUUID();
		const stub = env.RUNS.getByName(runId);
		const createdAt = '2026-08-31T12:00:00.000Z';
		await stub.initialize(createInitialRun(runId, 'vinext', 'access-user:test', 'test@example.com', createdAt));

		const event = {
			key: 'vinext:started',
			timestamp: '2026-08-31T12:00:01.000Z',
			type: 'stage.started',
			level: 'info' as const,
			stage: 'vinext' as const,
			message: 'Vinext evaluation started',
		};
		await stub.record(event, {
			status: 'running',
			previewPath: '/api/runs/test/preview/',
			previewProcessId: 'preview-process',
			previewPort: 8080,
			stage: {
				name: 'vinext',
				status: 'running',
				startedAt: event.timestamp,
			},
		});
		await stub.record(event, {
			status: 'failed',
			stage: { name: 'vinext', status: 'failed' },
		});

		const snapshot = await stub.getSnapshot();
		const events = (await stub.getEvents()).events;
		expect(snapshot?.status).toBe('running');
		expect(snapshot?.stages.vinext.status).toBe('running');
		expect(events.map((item) => item.key)).toEqual(['run:created', 'vinext:started']);
		expect(events[1]?.seq).toBeGreaterThan(events[0]?.seq ?? 0);

		await stub.record(
			{
				key: 'run:cancelled',
				timestamp: '2026-08-31T12:00:02.000Z',
				type: 'run.cancelled',
				level: 'warning',
				stage: null,
				message: 'Run cancelled',
			},
			{ status: 'cancelled', previewPath: null, previewProcessId: null, previewPort: null },
		);
		await stub.record(
			{
				key: 'vinext:late-completion',
				timestamp: '2026-08-31T12:00:03.000Z',
				type: 'stage.passed',
				level: 'success',
				stage: 'vinext',
				message: 'Late completion',
			},
			{ status: 'succeeded', stage: { name: 'vinext', status: 'passed' } },
		);

		const cancelled = await stub.getSnapshot();
		const finalEvents = (await stub.getEvents()).events;
		expect(cancelled?.status).toBe('cancelled');
		expect(cancelled?.previewPath).toBeNull();
		expect(cancelled?.previewProcessId).toBeNull();
		expect(cancelled?.previewPort).toBeNull();
		expect(cancelled?.stages.vinext.status).toBe('running');
		expect(finalEvents.map((item) => item.key)).toEqual(['run:created', 'vinext:started', 'run:cancelled']);
	});

	it('allows preview expiry without changing a successful run result', async () => {
		const runId = crypto.randomUUID();
		const stub = env.RUNS.getByName(runId);
		await stub.initialize(createInitialRun(runId, 'vinext', 'access-user:test', 'test@example.com', '2026-08-31T12:00:00.000Z'));
		await stub.record(
			{
				key: 'run:completed',
				timestamp: '2026-08-31T12:01:00.000Z',
				type: 'run.completed',
				level: 'success',
				stage: 'publish',
				message: 'Run completed',
			},
			{
				status: 'succeeded',
				selectedTarget: 'vinext',
				previewPath: `/api/runs/${runId}/preview/`,
				previewProcessId: 'preview-process',
				previewPort: 8080,
			},
		);
		await stub.record(
			{
				key: 'preview:unavailable',
				timestamp: '2026-08-31T12:02:00.000Z',
				type: 'preview.expired',
				level: 'warning',
				stage: 'publish',
				message: 'Preview unavailable',
			},
			{ previewPath: null, previewProcessId: null, previewPort: null },
		);

		const snapshot = await stub.getSnapshot();
		expect(snapshot?.status).toBe('succeeded');
		expect(snapshot?.selectedTarget).toBe('vinext');
		expect(snapshot?.previewPath).toBeNull();
		expect((await stub.getEvents()).events.map((event) => event.key)).toEqual(['run:created', 'run:completed', 'preview:unavailable']);
	});

	it('paginates event history without advancing past unread events', async () => {
		const runId = crypto.randomUUID();
		const stub = env.RUNS.getByName(runId);
		await stub.initialize(createInitialRun(runId, 'vinext', 'access-user:test', 'test@example.com', '2026-08-31T12:00:00.000Z'));

		for (let index = 0; index < 201; index += 1) {
			await stub.record({
				key: `log:${index}`,
				timestamp: new Date(Date.UTC(2026, 7, 31, 12, 0, index)).toISOString(),
				type: 'stage.log',
				level: 'info',
				stage: 'vinext',
				message: `Log ${index}`,
			});
		}

		const first = await stub.getEvents();
		expect(first.events).toHaveLength(200);
		expect(first.hasMore).toBe(true);
		expect(first.nextAfter).toBe(first.events.at(-1)?.seq);

		const second = await stub.getEvents(first.nextAfter);
		expect(second.events.map((event) => event.key)).toEqual(['log:199', 'log:200']);
		expect(second.hasMore).toBe(false);
		expect(second.nextAfter).toBe(second.events.at(-1)?.seq);
	});
});

function nextWebSocketMessage(socket: WebSocket): Promise<MessageEvent> {
	return new Promise((resolve) => socket.addEventListener('message', resolve, { once: true }));
}
