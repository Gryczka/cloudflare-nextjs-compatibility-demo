/** Controlled fixture builds, Sandbox lifecycle, and isolated preview proxy. */
import { getSandbox, type ProcessLogEvent, type SandboxProcess } from '@cloudflare/sandbox';
import { z } from 'zod';
import {
	compatibilityStages,
	stageLabels,
	type CompatibilityStage,
	type DeploymentTarget,
	type FixtureId,
	type RunEventInput,
	type StageExecutionResult,
} from './domain';
import { getFixture } from './fixtures';

const BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const PREVIEW_READY_TIMEOUT_MS = 2 * 60 * 1000;
const PREVIEW_REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const SANDBOX_DESTROY_TIMEOUT_MS = 20_000;
const PREVIEW_PORT = 8080;
const PREVIEW_IDLE_TIMEOUT = '30m';
const PREVIEW_REQUEST_HEADERS = [
	'accept',
	'accept-language',
	'if-modified-since',
	'if-none-match',
	'next-router-prefetch',
	'next-router-segment-prefetch',
	'next-router-state-tree',
	'next-url',
	'purpose',
	'range',
	'rsc',
] as const;
const PREVIEW_RESPONSE_HEADERS = [
	'accept-ranges',
	'cache-control',
	'content-encoding',
	'content-length',
	'content-range',
	'content-type',
	'etag',
	'last-modified',
	'link',
	'location',
	'vary',
	'x-nextjs-cache',
	'x-nextjs-matched-path',
	'x-nextjs-redirect',
	'x-nextjs-rewrite',
] as const;
const PREVIEW_CONTENT_SECURITY_POLICY = [
	'sandbox allow-scripts',
	"default-src 'self' data: blob:",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"worker-src 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join('; ');

const stageResultSchema = z.object({
	stage: z.enum(compatibilityStages),
	outcome: z.enum(['compatible', 'incompatible', 'invalid']),
	summary: z.string(),
	checks: z.array(
		z.object({
			name: z.string(),
			status: z.enum(['passed', 'failed', 'advisory']),
			detail: z.string(),
			durationMs: z.number(),
		}),
	),
	workspace: z.string(),
	durationMs: z.number(),
});
const stageAttemptResultSchema = stageResultSchema.extend({ attemptId: z.uuid() });
const stageInfrastructureErrorSchema = z.object({
	attemptId: z.uuid(),
	outcome: z.literal('infrastructure-error'),
	summary: z.string(),
});

export type StageLogRecorder = (event: RunEventInput) => Promise<unknown>;

/** Evaluate exactly one fixed fixture in the isolated Sandbox. Retry attempts
 * get distinct result files to avoid reusing a prior stage's stale success.
 * @param env - Sandbox binding.
 * @param runId - UUID shared with the Workflow and Sandbox.
 * @param fixtureId - Bundled fixture selected by the authenticated visitor.
 * @param stage - Native baseline or target adapter to run.
 * @param recordLog - Durable callback for process log lines.
 * @returns Validated stage evidence and timings.
 * @throws When the Sandbox fails or a result is stale/invalid.
 */
export async function executeStage(
	env: Env,
	runId: string,
	fixtureId: FixtureId,
	stage: CompatibilityStage,
	recordLog: StageLogRecorder,
): Promise<StageExecutionResult> {
	const sandbox = getSandbox(env.Sandbox, runId, {
		normalizeId: true,
		sleepAfter: '30m',
		containerTimeouts: {
			instanceGetTimeoutMS: 90_000,
			portReadyTimeoutMS: 120_000,
		},
	});
	const attemptId = crypto.randomUUID();
	const resultPath = stageAttemptResultPath(runId, stage, attemptId);
	await killPriorStageProcesses(sandbox, runId, stage);
	const process = await sandbox.exec(
		[
			'/usr/local/bin/node',
			'/opt/pipeline/runner/run-stage.mjs',
			'--run-id',
			runId,
			'--fixture',
			fixtureId,
			'--stage',
			stage,
			'--attempt-id',
			attemptId,
		],
		{ cwd: '/opt/pipeline', timeout: BUILD_TIMEOUT_MS },
	);
	const logController = new AbortController();
	const logForwarding = forwardProcessLogs(process, stage, recordLog, logController.signal).catch((error) => {
		if (!logController.signal.aborted) console.warn(JSON.stringify({ event: 'stage.log.stream_failed', error }));
	});
	let rawResult: string | null = null;
	const deadline = Date.now() + BUILD_TIMEOUT_MS;
	try {
		while (Date.now() < deadline) {
			rawResult = await readCompletedResult(sandbox, resultPath);
			if (rawResult) break;

			try {
				const status = await process.status();
				if (status.state === 'error') {
					rawResult = await readCompletedResult(sandbox, resultPath);
					if (!rawResult) throw new Error(status.error.message);
				}
				if (status.state === 'exited') {
					rawResult = await readCompletedResult(sandbox, resultPath);
					if (!rawResult) throw new Error(`Sandbox stage process exited with code ${status.exit.code}`);
				}
			} catch (error) {
				rawResult = await readCompletedResult(sandbox, resultPath);
				if (!rawResult) throw error;
			}
			if (!rawResult) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
		}
		if (!rawResult) throw new Error(`Sandbox stage did not produce a result within ${BUILD_TIMEOUT_MS}ms`);
	} finally {
		await stopSandboxProcess(process);
		logController.abort();
		await logForwarding;
	}

	const parsedResult: unknown = JSON.parse(rawResult);
	const infrastructureError = stageInfrastructureErrorSchema.safeParse(parsedResult);
	if (infrastructureError.success) {
		if (infrastructureError.data.attemptId !== attemptId) throw new Error('Sandbox returned a result from a different stage attempt');
		throw new Error(infrastructureError.data.summary);
	}
	const attemptResult = stageAttemptResultSchema.parse(parsedResult);
	if (attemptResult.attemptId !== attemptId) throw new Error('Sandbox returned a result from a different stage attempt');
	const { attemptId: _, ...result } = attemptResult;
	await sandbox.writeFile(workspacePath(runId, stage, 'result.json'), JSON.stringify(result));
	return result;
}

async function readCompletedResult(sandbox: ReturnType<typeof getSandbox>, resultPath: string): Promise<string | null> {
	try {
		const candidate = (await sandbox.readFile(resultPath, { encoding: 'utf8' })).content;
		JSON.parse(candidate);
		return candidate;
	} catch {
		return null;
	}
}

/** Start (or verify and reuse) the first compatible target's preview server.
 * @param env - Sandbox binding.
 * @param runId - Run UUID used for preview paths and Sandbox selection.
 * @param fixtureId - Bundled fixture to verify against.
 * @param target - Verified adapter or container fallback.
 * @returns Live process ID and proxy port after route-level verification.
 * @throws When the process cannot serve the fixture marker.
 */
export async function publishPreview(
	env: Env,
	runId: string,
	fixtureId: FixtureId,
	target: DeploymentTarget,
): Promise<{ processId: string; port: number }> {
	const fixture = getFixture(fixtureId);
	if (!fixture) throw new Error(`Unknown fixture: ${fixtureId}`);

	const sandbox = getSandbox(env.Sandbox, runId, {
		normalizeId: true,
		sleepAfter: PREVIEW_IDLE_TIMEOUT,
		containerTimeouts: {
			instanceGetTimeoutMS: 90_000,
			portReadyTimeoutMS: PREVIEW_READY_TIMEOUT_MS,
		},
	});
	const command = previewCommand(target, runId);
	for (const status of await sandbox.listProcesses()) {
		if (status.state !== 'running' || !sameCommand(status.command, command)) continue;
		const existing = await sandbox.getProcess(status.id);
		if (!existing) continue;
		try {
			await verifyPublishedPreview(sandbox, fixture.marker, runId);
			return { processId: existing.id, port: PREVIEW_PORT };
		} catch {
			await stopSandboxProcess(existing);
		}
	}

	const process = await sandbox.exec(command, {
		cwd: workspacePath(runId, target),
		env: {
			PORT: String(PREVIEW_PORT),
			HOSTNAME: '0.0.0.0',
			NEXT_TELEMETRY_DISABLED: '1',
			COMPATIBILITY_ASSET_PREFIX: previewAssetPrefix(runId),
		},
	});

	try {
		await process.waitForPort(PREVIEW_PORT, {
			mode: 'http',
			path: `${previewAssetPrefix(runId)}/`,
			status: { min: 200, max: 399 },
			timeout: PREVIEW_READY_TIMEOUT_MS,
		});
		await verifyPublishedPreview(sandbox, fixture.marker, runId);
		return { processId: process.id, port: PREVIEW_PORT };
	} catch (error) {
		await stopSandboxProcess(process);
		throw error;
	}
}

/** Rebuild a compatible adapter artifact if a Sandbox container was replaced.
 * @param env - Sandbox binding.
 * @param runId - Run UUID.
 * @param fixtureId - Bundled source fixture.
 * @param target - Chosen target to restore.
 * @param recordLog - Durable callback for rebuild evidence.
 * @returns True when a rebuild was needed; false when prior evidence is valid.
 */
export async function ensurePreviewArtifact(
	env: Env,
	runId: string,
	fixtureId: FixtureId,
	target: DeploymentTarget,
	recordLog: StageLogRecorder,
): Promise<boolean> {
	const sandbox = getSandbox(env.Sandbox, runId, { normalizeId: true, sleepAfter: PREVIEW_IDLE_TIMEOUT });
	const artifact = await sandbox.exists(previewArtifactPath(runId, target));
	if (artifact.exists) {
		try {
			const rawResult = (await sandbox.readFile(workspacePath(runId, target, 'result.json'), { encoding: 'utf8' })).content;
			const result = stageResultSchema.safeParse(JSON.parse(rawResult));
			if (result.success && result.data.outcome === 'compatible') return false;
		} catch {
			// Rebuild when the artifact cannot be tied to a successful stage result.
		}
	}

	const result = await executeStage(env, runId, fixtureId, target, recordLog);
	if (result.outcome !== 'compatible') throw new Error(`${stageLabels[target]} artifacts could not be restored`);
	return true;
}

export async function isPreviewProcessRunning(env: Env, runId: string, processId: string): Promise<boolean> {
	const sandbox = getSandbox(env.Sandbox, runId, { normalizeId: true, sleepAfter: PREVIEW_IDLE_TIMEOUT });
	return (await sandbox.listProcesses()).some((status) => status.id === processId && status.state === 'running');
}

/** Forward an authenticated preview request without cookies or Access headers.
 * @param env - Sandbox binding.
 * @param runId - Authorized run UUID.
 * @param request - Inbound browser request.
 * @param previewPath - Fallback path for assets produced without the prefix.
 * @param port - Verified preview server port.
 * @returns Streaming response with restricted headers and sandboxed CSP.
 */
export async function proxyPreview(env: Env, runId: string, request: Request, previewPath: string, port: number): Promise<Response> {
	const sandbox = getSandbox(env.Sandbox, runId, {
		normalizeId: true,
		sleepAfter: PREVIEW_IDLE_TIMEOUT,
	});
	const target = new URL(request.url);
	const externalPath = target.pathname;
	const requestHeaders = pickHeaders(request.headers, PREVIEW_REQUEST_HEADERS);
	let upstream = await sandbox.containerFetch(new Request(target, { method: request.method, headers: requestHeaders }), port);
	if (upstream.status === 404 && previewPath !== externalPath) {
		await upstream.body?.cancel();
		target.pathname = previewPath;
		upstream = await sandbox.containerFetch(new Request(target, { method: request.method, headers: requestHeaders }), port);
	}
	const responseHeaders = pickHeaders(upstream.headers, PREVIEW_RESPONSE_HEADERS);
	const location = responseHeaders.get('Location');
	const prefix = previewAssetPrefix(runId);
	if (location?.startsWith('/') && location !== prefix && !location.startsWith(`${prefix}/`)) {
		responseHeaders.set('Location', `${prefix}${location}`);
	}
	responseHeaders.set('Content-Security-Policy', PREVIEW_CONTENT_SECURITY_POLICY);
	responseHeaders.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
	responseHeaders.set('Referrer-Policy', 'no-referrer');
	responseHeaders.set('X-Content-Type-Options', 'nosniff');
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	});
}

/** Confirm container teardown before returning a public capacity reservation.
 * @param env - Sandbox binding.
 * @param runId - UUID of the Sandbox instance.
 * @throws On timeout or uncertain destruction; caller must retry rather than free a slot.
 */
export async function destroyRunSandbox(env: Env, runId: string) {
	const sandbox = getSandbox(env.Sandbox, runId, { normalizeId: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			sandbox.destroy(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error('Sandbox cleanup timed out')), SANDBOX_DESTROY_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function forwardProcessLogs(process: SandboxProcess, stage: CompatibilityStage, recordLog: StageLogRecorder, signal: AbortSignal) {
	const stream = await process.logs({ replay: true, follow: true, signal });
	const reader = stream.getReader();
	const decoder = new TextDecoder();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value.type !== 'stdout' && value.type !== 'stderr') continue;
		const message = decodeLogEvent(value, decoder);
		if (!message) continue;

		try {
			await recordLog({
				key: `${stage}:log:${value.cursor}`,
				timestamp: value.timestamp,
				type: 'stage.log',
				level: value.type === 'stderr' ? 'warning' : 'info',
				stage,
				message,
			});
		} catch (error) {
			console.warn(JSON.stringify({ event: 'stage.log.persist_failed', error }));
		}
	}
}

function decodeLogEvent(event: ProcessLogEvent, decoder: TextDecoder): string {
	if (event.type !== 'stdout' && event.type !== 'stderr') return '';
	return decoder.decode(event.data, { stream: true }).trim().slice(0, 4_000);
}

function previewCommand(target: DeploymentTarget, runId: string): readonly [string, ...string[]] {
	if (target === 'vinext') {
		return ['/usr/local/bin/npm', 'run', 'start:vinext', '--', '-p', String(PREVIEW_PORT)];
	}
	if (target === 'opennext') {
		return ['/usr/local/bin/npm', 'run', 'preview:opennext', '--', '--port', String(PREVIEW_PORT), '--ip', '0.0.0.0'];
	}
	return [
		'/usr/local/bin/docker',
		'run',
		'--network=host',
		'--rm',
		'-e',
		`PORT=${PREVIEW_PORT}`,
		'-e',
		'HOSTNAME=0.0.0.0',
		'-e',
		`COMPATIBILITY_ASSET_PREFIX=${previewAssetPrefix(runId)}`,
		containerImageName(runId),
	];
}

function previewAssetPrefix(runId: string): string {
	return `/api/runs/${runId}/preview`;
}

export function previewArtifactPath(runId: string, target: DeploymentTarget): string {
	const artifacts: Record<DeploymentTarget, string> = {
		vinext: 'dist/server/index.js',
		opennext: '.open-next/worker.js',
		container: '.next/standalone/server.js',
	};
	return workspacePath(runId, target, artifacts[target]);
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((part, index) => part === right[index]);
}

async function killPriorStageProcesses(sandbox: ReturnType<typeof getSandbox>, runId: string, stage: CompatibilityStage) {
	for (const status of await sandbox.listProcesses()) {
		if (status.state !== 'running' || !isStageCommand(status.command, runId, stage)) continue;
		const process = await sandbox.getProcess(status.id);
		if (process) await stopSandboxProcess(process);
	}
}

function isStageCommand(command: readonly string[], runId: string, stage: CompatibilityStage): boolean {
	if (command[1] !== '/opt/pipeline/runner/run-stage.mjs') return false;
	return command[command.indexOf('--run-id') + 1] === runId && command[command.indexOf('--stage') + 1] === stage;
}

async function verifyPublishedPreview(sandbox: ReturnType<typeof getSandbox>, marker: string, runId: string) {
	// Requests cross the Sandbox RPC boundary, where AbortSignal is not serializable.
	const response = await sandbox.containerFetch(new Request(`http://preview.local${previewAssetPrefix(runId)}/`), PREVIEW_PORT);
	const signal = AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS);
	const body = await readBoundedText(response, 64 * 1024, signal);
	if (!response.ok || !body.includes(marker)) {
		throw new Error(`Published preview failed verification (${response.status})`);
	}
}

function pickHeaders(headers: Headers, names: readonly string[]): Headers {
	const picked = new Headers();
	for (const name of names) {
		const value = headers.get(name);
		if (value !== null) picked.set(name, value);
	}
	return picked;
}

function workspacePath(runId: string, stage: string, file = ''): string {
	const root = `/workspace/runs/${runId}/${stage}`;
	return file ? `${root}/${file}` : root;
}

function stageAttemptResultPath(runId: string, stage: CompatibilityStage, attemptId: string): string {
	return `/workspace/runs/${runId}/.results/${stage}-${attemptId}.json`;
}

function containerImageName(runId: string): string {
	return `nextjs-compat-${runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`;
}

async function readBoundedText(response: Response, limit = 64 * 1024, signal?: AbortSignal) {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let body = '';
	let bytes = 0;
	let complete = false;
	let onAbort: (() => void) | undefined;
	const aborted = signal
		? new Promise<never>((_, reject) => {
				onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Preview verification timed out'));
				if (signal.aborted) onAbort();
				else signal.addEventListener('abort', onAbort, { once: true });
			})
		: null;

	try {
		while (true) {
			const { done, value } = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read();
			if (done) {
				complete = true;
				break;
			}
			bytes += value.byteLength;
			if (bytes > limit) throw new Error('Preview response exceeded verification limit');
			body += decoder.decode(value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		if (signal && onAbort) signal.removeEventListener('abort', onAbort);
		if (!complete) await reader.cancel('Preview verification stopped').catch(() => undefined);
		reader.releaseLock();
	}
}

async function stopSandboxProcess(process: SandboxProcess) {
	await process.kill().catch(() => undefined);
	try {
		await process.waitForExit({ timeout: PROCESS_STOP_TIMEOUT_MS });
		return;
	} catch {
		await process.kill(9).catch(() => undefined);
		await process.waitForExit({ timeout: PROCESS_STOP_TIMEOUT_MS }).catch(() => undefined);
	}
}
