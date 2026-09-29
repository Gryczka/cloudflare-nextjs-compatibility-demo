/** Run an isolated fixture stage in the Sandbox and emit bounded verification
 * results consumed by the Workflow; fixture names are fixed by the control plane.
 */
import { spawn } from 'node:child_process';
import { cp, copyFile, link, lstat, mkdir, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const fixtures = {
	vinext: { marker: 'vinext-target-ok', runtimeMarker: null },
	opennext: { marker: 'opennext-fallback-ok', runtimeMarker: null },
	container: {
		marker: 'container-fallback-ok',
		runtimeMarker: 'container-runtime-ok',
	},
};
const stagePorts = {
	baseline: 4100,
	vinext: 4200,
	opennext: 4300,
	container: 4400,
};
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const PROCESS_STOP_GRACE_MS = 5_000;
const activeChildren = new Set();

process.once('SIGTERM', () => stopActiveChildrenAndExit(143));
process.once('SIGINT', () => stopActiveChildrenAndExit(130));

const args = parseArgs(process.argv.slice(2));
const pipelineRoot = resolve(process.env.PIPELINE_ROOT ?? '/opt/pipeline');
const workspaceRoot = resolve(process.env.PIPELINE_WORKSPACE_ROOT ?? '/workspace/runs');
const fixture = fixtures[args.fixture];
const port = stagePorts[args.stage];
if (!isUuid(args.runId)) throw new Error('Invalid --run-id');
if (!isUuid(args.attemptId)) throw new Error('Invalid --attempt-id');
if (!fixture) throw new Error(`Unknown fixture: ${args.fixture}`);
if (!port) throw new Error(`Unknown stage: ${args.stage}`);
const workspace = join(workspaceRoot, args.runId, args.stage);
const resultPath = join(workspaceRoot, args.runId, '.results', `${args.stage}-${args.attemptId}.json`);
const previewAssetPrefix = `/api/runs/${args.runId}/preview`;
const startedAt = Date.now();

try {
	await prepareWorkspace();
	const result = await evaluateStage();
	await writeResult(result);
	process.exit(0);
} catch (error) {
	await writeResult({
		attemptId: args.attemptId,
		stage: args.stage,
		outcome: 'infrastructure-error',
		summary: error instanceof Error ? error.message : String(error),
		workspace,
		durationMs: Date.now() - startedAt,
	});
	console.error(error);
	process.exit(2);
}

async function evaluateStage() {
	const checks = [];
	if (args.stage === 'baseline') {
		const built = await commandCheck(checks, 'next-build', 'npm', ['run', 'build:next']);
		if (!built) {
			return result('invalid', 'Native Next.js build failed; fallback evaluation stopped', checks);
		}

		const smokePassed = await serverChecks(checks, 'next-runtime', 'npm', ['run', 'start:next', '--', '-H', '0.0.0.0', '-p', String(port)]);
		return result(
			smokePassed ? 'compatible' : 'invalid',
			smokePassed ? 'Native Next.js build and route smoke tests passed' : 'Native Next.js route smoke test failed',
			checks,
		);
	}

	if (args.stage === 'vinext') {
		const compatibilityCheck = await runCommand('npm', ['run', 'check:vinext']);
		checks.push({
			name: 'vinext-check',
			status: 'advisory',
			detail: summarizeCommand(compatibilityCheck),
			durationMs: compatibilityCheck.durationMs,
		});
		const built = await commandCheck(checks, 'vinext-build', 'npm', ['run', 'build:vinext']);
		if (!built) {
			return result('incompatible', 'Vinext compatibility check was advisory, but the production build failed', checks);
		}

		const smokePassed = await serverChecks(checks, 'vinext-runtime', 'npm', [
			'run',
			'start:vinext',
			'--',
			'-H',
			'0.0.0.0',
			'-p',
			String(port),
		]);
		return result(
			smokePassed ? 'compatible' : 'incompatible',
			smokePassed ? 'Vinext production build and route smoke tests passed' : 'Vinext runtime smoke test exposed a compatibility gap',
			checks,
		);
	}

	if (args.stage === 'opennext') {
		const built = await commandCheck(checks, 'opennext-build', 'npm', ['run', 'build:opennext']);
		if (!built) {
			return result('incompatible', 'OpenNext production build failed', checks);
		}

		const smokePassed = await serverChecks(checks, 'workers-runtime', 'npm', [
			'run',
			'preview:opennext',
			'--',
			'--port',
			String(port),
			'--ip',
			'0.0.0.0',
		]);
		return result(
			smokePassed ? 'compatible' : 'incompatible',
			smokePassed ? 'OpenNext build passed in the Workers runtime' : 'OpenNext built successfully, but a Workers runtime smoke test failed',
			checks,
		);
	}

	const dockerReady = await runCommand('docker', ['info', '--format', '{{.ID}}']);
	if (dockerReady.code !== 0) {
		throw new Error(`Docker daemon is unavailable: ${summarizeCommand(dockerReady)}`);
	}
	checks.push({
		name: 'docker-daemon',
		status: 'passed',
		detail: 'Docker daemon is ready',
		durationMs: dockerReady.durationMs,
	});

	const built = await commandCheck(checks, 'standalone-next-build', 'npm', ['run', 'build:next'], {
		COMPATIBILITY_CONTAINER_BUILD: '1',
	});
	if (!built) {
		return result('incompatible', 'Next.js standalone output could not be produced', checks);
	}

	const image = containerImageName(args.runId);
	const imageBuilt = await commandCheck(checks, 'container-image-build', 'docker', [
		'build',
		'--load',
		'-f',
		'Dockerfile.runtime',
		'-t',
		image,
		'.',
	]);
	if (!imageBuilt) throw new Error('Controlled container image build failed');

	const smokePassed = await serverChecks(checks, 'container-runtime', 'docker', [
		'run',
		...dockerRuntimeNetworkArgs(port),
		'--rm',
		'-e',
		`PORT=${port}`,
		'-e',
		'HOSTNAME=0.0.0.0',
		image,
	]);
	return result(
		smokePassed ? 'compatible' : 'incompatible',
		smokePassed ? 'Standalone Next.js image passed in the full Node.js container runtime' : 'Container runtime smoke test failed',
		checks,
	);
}

async function prepareWorkspace() {
	const base = join(pipelineRoot, 'fixtures', 'base');
	const variant = join(pipelineRoot, 'fixtures', args.fixture);
	await rm(workspace, { recursive: true, force: true });
	await mkdir(workspace, { recursive: true });
	await cp(base, workspace, {
		recursive: true,
		filter(source) {
			return !['node_modules', '.next', '.open-next', 'dist', '.wrangler'].includes(basename(source));
		},
	});
	await cp(variant, workspace, { recursive: true, force: true });
	await cloneDependencyTree(join(base, 'node_modules'), join(workspace, 'node_modules'));
	console.log(`[pipeline] clean workspace prepared for ${args.fixture}/${args.stage}`);
}

async function cloneDependencyTree(source, destination) {
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) {
			await cloneDependencyTree(sourcePath, destinationPath);
		} else if (entry.isSymbolicLink()) {
			await symlink(await readlink(sourcePath), destinationPath);
		} else if ((await lstat(sourcePath)).isFile()) {
			try {
				await link(sourcePath, destinationPath);
			} catch (error) {
				if (error?.code !== 'EXDEV') throw error;
				await copyFile(sourcePath, destinationPath);
			}
		}
	}
}

async function commandCheck(checks, name, command, commandArgs, extraEnv) {
	const execution = await runCommand(command, commandArgs, extraEnv);
	checks.push({
		name,
		status: execution.code === 0 ? 'passed' : 'failed',
		detail: summarizeCommand(execution),
		durationMs: execution.durationMs,
	});
	return execution.code === 0;
}

async function serverChecks(checks, name, command, commandArgs) {
	const started = Date.now();
	console.log(`[pipeline] $ ${command} ${commandArgs.join(' ')}`);
	const child = spawn(command, commandArgs, {
		cwd: workspace,
		env: {
			...process.env,
			PORT: String(port),
			HOSTNAME: '0.0.0.0',
			NEXT_TELEMETRY_DISABLED: '1',
			COMPATIBILITY_ASSET_PREFIX: previewAssetPrefix,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
	});
	activeChildren.add(child);
	child.stdout.on('data', (chunk) => process.stdout.write(chunk));
	child.stderr.on('data', (chunk) => process.stderr.write(chunk));
	child.once('close', () => activeChildren.delete(child));
	child.once('error', () => activeChildren.delete(child));

	try {
		await waitForHttp(`http://127.0.0.1:${port}${previewAssetPrefix}/`, 90_000);
		const home = await checkRoute(`${previewAssetPrefix}/`, fixture.marker);
		checks.push({
			name: `${name}-home`,
			status: home.passed ? 'passed' : 'failed',
			detail: home.detail,
			durationMs: Date.now() - started,
		});
		const asset = await checkPreviewAsset(home.body);
		checks.push({
			name: `${name}-asset`,
			status: asset.passed ? 'passed' : 'failed',
			detail: asset.detail,
			durationMs: Date.now() - started,
		});

		let runtimePassed = true;
		if (fixture.runtimeMarker) {
			const runtime = await checkRoute(`${previewAssetPrefix}/api/runtime-check`, fixture.runtimeMarker);
			runtimePassed = runtime.passed;
			checks.push({
				name: `${name}-node-api`,
				status: runtime.passed ? 'passed' : 'failed',
				detail: runtime.detail,
				durationMs: Date.now() - started,
			});
		}
		return home.passed && asset.passed && runtimePassed;
	} finally {
		await stopChild(child);
	}
}

async function checkRoute(path, marker) {
	try {
		const response = await fetchWithTimeout(`http://127.0.0.1:${port}${path}`);
		const body = await readBoundedText(response);
		const passed = response.ok && body.includes(marker);
		return {
			passed,
			detail: passed ? `${path} returned ${response.status} with ${marker}` : `${path} returned ${response.status}; expected ${marker}`,
			body,
		};
	} catch (error) {
		return {
			passed: false,
			detail: error instanceof Error ? error.message : String(error),
			body: '',
		};
	}
}

async function checkPreviewAsset(homeBody) {
	const assetUrl = [...homeBody.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
		.map((match) => match[1])
		.find((value) => value.startsWith(`${previewAssetPrefix}/`) && /\.(?:css|js)(?:\?|$)/.test(value));
	if (!assetUrl) {
		return { passed: false, detail: `No JavaScript or CSS asset used the ${previewAssetPrefix} prefix` };
	}

	try {
		for (const internalPath of [assetUrl, assetUrl.slice(previewAssetPrefix.length)]) {
			const response = await fetchWithTimeout(`http://127.0.0.1:${port}${internalPath}`);
			await response.body?.cancel();
			if (response.ok) {
				return {
					passed: true,
					detail: `${assetUrl} returned ${response.status}`,
				};
			}
		}
		return { passed: false, detail: `${assetUrl} was not served by the runtime` };
	} catch (error) {
		return {
			passed: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

async function waitForHttp(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetchWithTimeout(url, Math.min(5_000, deadline - Date.now()));
			await response.body?.cancel();
			if (response.status < 500) return;
		} catch {
			// The server is still starting.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
	}
	throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

function fetchWithTimeout(url, timeoutMs = HTTP_REQUEST_TIMEOUT_MS) {
	return fetch(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
}

async function readBoundedText(response) {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	let complete = false;

	while (length < RESPONSE_LIMIT_BYTES) {
		const { done, value } = await reader.read();
		if (done) {
			complete = true;
			break;
		}
		const remaining = RESPONSE_LIMIT_BYTES - length;
		chunks.push(value.subarray(0, remaining));
		length += Math.min(value.byteLength, remaining);
		if (value.byteLength > remaining) {
			break;
		}
	}
	if (!complete) await reader.cancel('Response exceeded verification limit');
	return Buffer.concat(chunks).toString('utf8');
}

function runCommand(command, commandArgs, extraEnv = {}) {
	const started = Date.now();
	console.log(`[pipeline] $ ${command} ${commandArgs.join(' ')}`);
	return new Promise((resolveCommand, rejectCommand) => {
		let settled = false;
		let timedOut = false;
		let forceKillTimer;
		const child = spawn(command, commandArgs, {
			cwd: workspace,
			env: {
				...process.env,
				CI: '1',
				NEXT_TELEMETRY_DISABLED: '1',
				COMPATIBILITY_ASSET_PREFIX: previewAssetPrefix,
				...extraEnv,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		});
		activeChildren.add(child);
		let output = '';
		const capture = (chunk, destination) => {
			const text = chunk.toString();
			output = `${output}${text}`.slice(-12_000);
			destination.write(chunk);
		};
		child.stdout.on('data', (chunk) => capture(chunk, process.stdout));
		child.stderr.on('data', (chunk) => capture(chunk, process.stderr));
		const timeout = setTimeout(() => {
			timedOut = true;
			signalChildGroup(child, 'SIGTERM');
			forceKillTimer = setTimeout(() => signalChildGroup(child, 'SIGKILL'), PROCESS_STOP_GRACE_MS);
		}, COMMAND_TIMEOUT_MS);
		const settle = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			callback();
		};
		child.once('error', (error) => {
			activeChildren.delete(child);
			settle(() => rejectCommand(error));
		});
		child.once('close', (code, signal) => {
			activeChildren.delete(child);
			if (timedOut) signalChildGroup(child, 'SIGKILL');
			settle(() =>
				resolveCommand({
					code: timedOut ? 1 : (code ?? 1),
					signal,
					timedOut,
					output,
					durationMs: Date.now() - started,
				}),
			);
		});
	});
}

async function stopChild(child) {
	if (child.exitCode === null) {
		signalChildGroup(child, 'SIGTERM');
		await Promise.race([
			new Promise((resolveClose) => child.once('close', resolveClose)),
			new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
		]);
	}

	// npm may exit before a server descendant. Sandbox supervises the complete
	// process group, so always ensure that group is gone before this stage exits.
	signalChildGroup(child, 'SIGKILL');
	child.stdout?.destroy();
	child.stderr?.destroy();
}

function signalChildGroup(child, signal) {
	try {
		if (process.platform !== 'win32' && child.pid) {
			process.kill(-child.pid, signal);
		} else if (child.exitCode === null) {
			child.kill(signal);
		}
	} catch {
		// The process group already exited.
	}
}

function stopActiveChildrenAndExit(code) {
	for (const child of activeChildren) signalChildGroup(child, 'SIGKILL');
	process.exit(code);
}

function result(outcome, summary, checks) {
	return {
		attemptId: args.attemptId,
		stage: args.stage,
		outcome,
		summary,
		checks,
		workspace,
		durationMs: Date.now() - startedAt,
	};
}

async function writeResult(value) {
	await mkdir(dirname(resultPath), { recursive: true });
	const temporaryPath = `${resultPath}.tmp`;
	await writeFile(temporaryPath, JSON.stringify(value));
	await rename(temporaryPath, resultPath);
	console.log(`[pipeline] ${value.summary}`);
}

function summarizeCommand(execution) {
	const clean = stripAnsi(execution.output).trim().split('\n').slice(-4).join(' ');
	const summary = clean.slice(0, 1_000) || `Process exited with code ${execution.code}`;
	return execution.timedOut ? `Timed out after ${COMMAND_TIMEOUT_MS}ms: ${summary}` : summary;
}

function stripAnsi(value) {
	return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function containerImageName(runId) {
	return `nextjs-compat-${runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`;
}

function dockerRuntimeNetworkArgs(runtimePort) {
	return process.env.COMPATIBILITY_DOCKER_NETWORK === 'host'
		? ['--network=host']
		: ['--publish', `127.0.0.1:${runtimePort}:${runtimePort}`];
}

function parseArgs(values) {
	const parsed = {};
	for (let index = 0; index < values.length; index += 2) {
		const key = values[index]?.replace(/^--/, '');
		const value = values[index + 1];
		if (key && value) parsed[toCamelCase(key)] = value;
	}
	for (const required of ['runId', 'fixture', 'stage', 'attemptId']) {
		if (!parsed[required]) throw new Error(`Missing --${required}`);
	}
	return parsed;
}

function isUuid(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toCamelCase(value) {
	return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
