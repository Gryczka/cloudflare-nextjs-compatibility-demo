/** Execute the fixture matrix outside Cloudflare using the same stage runner;
 * VERIFY_CONTAINER=1 also proves the standalone fallback with a Docker daemon.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspaceRoot = join(tmpdir(), `nextjs-compat-fixtures-${process.pid}`);
const DOCKER_INFO_TIMEOUT_MS = 30_000;
const STAGE_TIMEOUT_MS = 25 * 60 * 1000;
const PROCESS_STOP_GRACE_MS = 5_000;
const matrix = [
	['vinext', 'baseline', 'compatible'],
	['vinext', 'vinext', 'compatible'],
	['opennext', 'baseline', 'compatible'],
	['opennext', 'vinext', 'incompatible'],
	['opennext', 'opennext', 'compatible'],
	['container', 'baseline', 'compatible'],
	['container', 'vinext', 'incompatible'],
	['container', 'opennext', 'incompatible'],
];
const expectedArtifacts = {
	vinext: 'dist/server/index.js',
	opennext: '.open-next/worker.js',
	container: '.next/standalone/server.js',
};

if (process.env.VERIFY_CONTAINER === '1') {
	if (spawnSync('docker', ['info'], { stdio: 'ignore', timeout: DOCKER_INFO_TIMEOUT_MS }).status !== 0) {
		throw new Error('VERIFY_CONTAINER=1 requires an unrestricted Docker daemon');
	}
	matrix.push(['container', 'container', 'compatible']);
} else {
	console.warn('[verify] Set VERIFY_CONTAINER=1 with an unrestricted Docker daemon to test the container image');
}

try {
	for (const [fixture, stage, expected] of matrix) {
		const runId = randomUUID();
		const attemptId = randomUUID();
		await runStage(runId, fixture, stage, attemptId);
		const resultPath = join(workspaceRoot, runId, '.results', `${stage}-${attemptId}.json`);
		const result = JSON.parse(await readFile(resultPath, 'utf8'));
		if (result.outcome !== expected) {
			throw new Error(`${fixture}/${stage}: expected ${expected}, received ${result.outcome}`);
		}
		if (result.outcome === 'compatible' && expectedArtifacts[stage]) {
			await access(join(workspaceRoot, runId, stage, expectedArtifacts[stage]));
		}
		console.log(`[verify] ${fixture}/${stage}: ${result.outcome}`);
	}
} finally {
	await rm(workspaceRoot, { recursive: true, force: true });
}

function runStage(runId, fixture, stage, attemptId) {
	return new Promise((resolveStage, rejectStage) => {
		let settled = false;
		let timedOut = false;
		let forceKillTimer;
		const child = spawn(
			process.execPath,
			[join(root, 'runner', 'run-stage.mjs'), '--run-id', runId, '--fixture', fixture, '--stage', stage, '--attempt-id', attemptId],
			{
				cwd: root,
				env: {
					...process.env,
					PIPELINE_ROOT: root,
					PIPELINE_WORKSPACE_ROOT: workspaceRoot,
				},
				stdio: 'inherit',
				detached: process.platform !== 'win32',
			},
		);
		const timeout = setTimeout(() => {
			timedOut = true;
			signalChildGroup(child, 'SIGTERM');
			forceKillTimer = setTimeout(() => signalChildGroup(child, 'SIGKILL'), PROCESS_STOP_GRACE_MS);
		}, STAGE_TIMEOUT_MS);
		const settle = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			callback();
		};
		child.once('error', (error) => settle(() => rejectStage(error)));
		child.once('close', (code) => {
			settle(() => {
				if (code === 0 && !timedOut) resolveStage();
				else rejectStage(new Error(`${fixture}/${stage} ${timedOut ? `timed out after ${STAGE_TIMEOUT_MS}ms` : `exited with ${code}`}`));
			});
		});
	});
}

function signalChildGroup(child, signal) {
	try {
		if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
		else if (child.exitCode === null) child.kill(signal);
	} catch {
		// The stage process already exited.
	}
}
