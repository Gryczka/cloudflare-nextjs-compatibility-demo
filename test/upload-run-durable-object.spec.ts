import { describe, expect, it } from 'vitest';
import {
	MAX_UPLOAD_CANDIDATE_CHECKS,
	UploadRunDomainError,
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
	createInitialUploadRun,
	publicUploadRunSnapshot,
	type ReportCandidateInput,
	type UploadCandidateTerminalResult,
	type UploadRunSnapshot,
} from '../src/upload-domain';
import { uploadRunWebSocketRejection } from '../src/upload-run-durable-object';
import type { DeploymentTarget } from '../src/domain';
import type { SourceManifest } from '../src/source-archive';

const CREATED_AT = '2026-09-08T12:00:00.000Z';
const SOURCE_HASH = 'sha256:source-123';
const LOCK_HASH = 'sha256:lock-123';

const manifest: SourceManifest = {
	root: '.',
	appName: 'customer-next-app',
	sourceHash: SOURCE_HASH,
	lockHash: LOCK_HASH,
	entryCount: 12,
	fileCount: 10,
	directoryCount: 2,
	compressedBytes: 1_024,
	uncompressedBytes: 4_096,
};

describe('upload run candidate coordination', () => {
	it('keeps the first committed passing report as the provisional target', () => {
		let snapshot = preparedRun();
		snapshot = start(snapshot, 'opennext', '2026-09-08T12:00:03.000Z');
		snapshot = start(snapshot, 'vinext', '2026-09-08T12:00:03.100Z');

		const first = report(snapshot, 'opennext', passed('opennext'), '2026-09-08T12:00:04.000Z');
		const second = report(first.snapshot, 'vinext', passed('vinext'), '2026-09-08T12:00:04.100Z');

		expect(first.provisionalChosen).toBe(true);
		expect(second.provisionalChosen).toBe(false);
		expect(second.snapshot.provisional).toMatchObject({ status: 'live', target: 'opennext', reportOrder: 1 });
		expect(second.snapshot.candidates.vinext.reportOrder).toBe(2);
		expect(second.snapshot.timeToFirstLive).toBe(4_000);
	});

	it('treats a duplicate terminal callback as a no-op', () => {
		let snapshot = preparedRun();
		snapshot = start(snapshot, 'vinext', '2026-09-08T12:00:03.000Z');
		const result = passed('vinext');
		const first = report(snapshot, 'vinext', result, '2026-09-08T12:00:04.000Z');
		const duplicate = report(first.snapshot, 'vinext', result, '2026-09-08T12:00:05.000Z', 'report:vinext:duplicate');

		expect(duplicate.changed).toBe(false);
		expect(duplicate.snapshot).toBe(first.snapshot);
		expect(duplicate.snapshot.revision).toBe(first.snapshot.revision);
		expect(duplicate.provisionalChosen).toBe(false);
	});

	it('rejects stale-generation callbacks after cancellation', () => {
		let snapshot = preparedRun();
		snapshot = start(snapshot, 'vinext', '2026-09-08T12:00:03.000Z');
		const cancelled = applyRequestCancellation(snapshot, {
			idempotencyKey: 'cancel:run',
			generation: 1,
			timestamp: '2026-09-08T12:00:04.000Z',
		}).snapshot;

		expect(cancelled.generation).toBe(2);
		expect(() => report(cancelled, 'vinext', passed('vinext'), '2026-09-08T12:00:05.000Z', 'report:stale', 1)).toThrowError(
			expect.objectContaining<Partial<UploadRunDomainError>>({ code: 'STALE_GENERATION' }),
		);
	});

	it('rejects source-hash and artifact-digest fence mismatches', () => {
		let snapshot = preparedRun();
		expect(() =>
			applyMarkCandidateStarted(snapshot, {
				...sourceMutation('start:wrong-source', '2026-09-08T12:00:03.000Z'),
				sourceHash: 'sha256:different-source',
				target: 'vinext',
				attempt: 1,
				status: 'building',
			}),
		).toThrowError(expect.objectContaining<Partial<UploadRunDomainError>>({ code: 'SOURCE_HASH_MISMATCH' }));

		snapshot = start(snapshot, 'vinext', '2026-09-08T12:00:03.000Z');
		snapshot = report(snapshot, 'vinext', passed('vinext'), '2026-09-08T12:00:04.000Z').snapshot;
		snapshot = applyBeginFinalization(snapshot, {
			...sourceMutation('finalize:digest-fence', '2026-09-08T12:00:05.000Z'),
			force: true,
		}).snapshot;
		expect(() =>
			applyMarkDeploying(snapshot, {
				...sourceMutation('deploy:wrong-digest', '2026-09-08T12:00:06.000Z'),
				target: 'vinext',
				artifactDigest: 'sha256:different-artifact',
			}),
		).toThrowError(expect.objectContaining<Partial<UploadRunDomainError>>({ code: 'ARTIFACT_DIGEST_MISMATCH' }));
	});

	it('selects by final policy rather than provisional completion order and advances after promotion failure', () => {
		let snapshot = preparedRun();
		for (const [target, timestamp] of [
			['container', '2026-09-08T12:00:03.000Z'],
			['opennext', '2026-09-08T12:00:03.100Z'],
			['vinext', '2026-09-08T12:00:03.200Z'],
		] as const) {
			snapshot = start(snapshot, target, timestamp);
		}
		for (const [target, timestamp] of [
			['container', '2026-09-08T12:00:04.000Z'],
			['opennext', '2026-09-08T12:00:04.100Z'],
			['vinext', '2026-09-08T12:00:04.200Z'],
		] as const) {
			snapshot = report(snapshot, target, passed(target), timestamp).snapshot;
		}

		const finalization = applyBeginFinalization(snapshot, {
			...sourceMutation('finalize:run', '2026-09-08T12:00:05.000Z'),
			force: false,
		});
		expect(finalization.snapshot.provisional.target).toBe('container');
		expect(finalization.selectedTarget).toBe('vinext');

		snapshot = applyMarkDeploying(finalization.snapshot, {
			...sourceMutation('deploy:vinext', '2026-09-08T12:00:06.000Z'),
			target: 'vinext',
			artifactDigest: digest('vinext'),
		}).snapshot;
		const failed = applyRecordPromotionFailure(snapshot, {
			...sourceMutation('fail:vinext', '2026-09-08T12:00:07.000Z'),
			target: 'vinext',
			artifactDigest: digest('vinext'),
			reason: 'Promotion API rejected the artifact',
		});

		expect(failed.nextTarget).toBe('opennext');
		expect(failed.snapshot.status).toBe('selecting');
		expect(failed.snapshot.selection.promotionFailures).toHaveLength(1);
		expect(failed.snapshot.selection.rationale?.eligiblePassedTargets).toEqual(['opennext', 'container']);
	});

	it('times out unfinished candidates when finalization is forced', () => {
		let snapshot = preparedRun();
		snapshot = start(snapshot, 'opennext', '2026-09-08T12:00:03.000Z');
		snapshot = report(snapshot, 'opennext', passed('opennext'), '2026-09-08T12:00:04.000Z').snapshot;

		const finalization = applyBeginFinalization(snapshot, {
			...sourceMutation('finalize:forced', '2026-09-08T12:00:10.000Z'),
			force: true,
		});

		expect(finalization.timedOutCandidates).toEqual(['vinext', 'container']);
		expect(finalization.snapshot.candidates.vinext.status).toBe('timed_out');
		expect(finalization.snapshot.candidates.container.status).toBe('timed_out');
		expect(finalization.selectedTarget).toBe('opennext');
	});

	it('increments the fence, cancels every active candidate, and completes cleanup separately', () => {
		let snapshot = preparedRun();
		snapshot = start(snapshot, 'vinext', '2026-09-08T12:00:03.000Z');
		const cancellation = applyRequestCancellation(snapshot, {
			idempotencyKey: 'cancel:active',
			generation: 1,
			timestamp: '2026-09-08T12:00:04.000Z',
		});

		expect(cancellation.snapshot.status).toBe('cancelling');
		expect(cancellation.snapshot.generation).toBe(2);
		expect(cancellation.cancelledCandidates).toEqual(['vinext', 'opennext', 'container']);
		expect(Object.values(cancellation.snapshot.candidates).map((candidate) => candidate.status)).toEqual([
			'cancelled',
			'cancelled',
			'cancelled',
		]);

		const cleaned = applyCompleteCleanup(cancellation.snapshot, {
			idempotencyKey: 'cleanup:cancelled',
			generation: 2,
			timestamp: '2026-09-08T12:00:05.000Z',
		});
		expect(cleaned.snapshot.status).toBe('cancelled');
		expect(cleaned.snapshot.cleanup.status).toBe('completed');
		expect(cleaned.snapshot.timeToFinal).toBe(5_000);
	});

	it('enforces the candidate check bound', () => {
		let snapshot = preparedRun();
		snapshot = start(snapshot, 'vinext', '2026-09-08T12:00:03.000Z');
		const result = passed('vinext');
		result.checks = Array.from({ length: MAX_UPLOAD_CANDIDATE_CHECKS + 1 }, (_, index) => ({
			name: `check-${index}`,
			status: 'passed' as const,
			detail: 'ok',
			durationMs: 1,
		}));
		expect(() => report(snapshot, 'vinext', result, '2026-09-08T12:00:04.000Z')).toThrow(`more than ${MAX_UPLOAD_CANDIDATE_CHECKS}`);
	});
});

describe('upload run privacy and resources', () => {
	it('redacts ownership, R2 keys, digests, and runtime resource details from public state', () => {
		let snapshot = preparedRun();
		snapshot = start(snapshot, 'vinext', '2026-09-08T12:00:03.000Z');
		snapshot = report(snapshot, 'vinext', passed('vinext'), '2026-09-08T12:00:04.000Z').snapshot;
		snapshot = applyBeginFinalization(snapshot, {
			...sourceMutation('finalize:redaction', '2026-09-08T12:00:05.000Z'),
			force: true,
		}).snapshot;
		snapshot = applyMarkDeploying(snapshot, {
			...sourceMutation('deploy:redaction', '2026-09-08T12:00:06.000Z'),
			target: 'vinext',
			artifactDigest: digest('vinext'),
		}).snapshot;
		snapshot = applyCompleteDeployment(snapshot, {
			...sourceMutation('complete:redaction', '2026-09-08T12:00:07.000Z'),
			target: 'vinext',
			artifactDigest: digest('vinext'),
			deploymentId: 'deployment-secret-id',
			url: 'https://customer.example.com/',
		}).snapshot;

		const publicSnapshot = publicUploadRunSnapshot(snapshot);
		const serialized = JSON.stringify(publicSnapshot);
		expect(publicSnapshot.source.manifest?.appName).toBe(manifest.appName);
		expect(publicSnapshot.candidates.vinext).not.toHaveProperty('sandboxId');
		expect(publicSnapshot.candidates.vinext).not.toHaveProperty('processId');
		expect(publicSnapshot.candidates.vinext).not.toHaveProperty('port');
		expect(publicSnapshot.candidates.vinext).not.toHaveProperty('artifactR2Key');
		expect(publicSnapshot.candidates.vinext).not.toHaveProperty('artifactDigest');
		expect(publicSnapshot.deployment.attempts[0]).not.toHaveProperty('artifactDigest');
		expect(publicSnapshot.deployment.attempts[0]).not.toHaveProperty('deploymentId');
		for (const secret of [
			'access-user:owner-secret',
			'uploads/private/source.tgz',
			SOURCE_HASH,
			LOCK_HASH,
			'artifacts/private/vinext.tgz',
			digest('vinext'),
			'sandbox-vinext-secret',
			'process-vinext-secret',
			'deployment-secret-id',
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it('tracks resource registration and release idempotently and fences cleanup on active resources', () => {
		let snapshot = preparedRun();
		const registrationInput = {
			...sourceMutation('resource:register', '2026-09-08T12:00:03.000Z'),
			resourceId: 'sandbox:vinext:1',
			kind: 'sandbox' as const,
			candidate: 'vinext' as const,
			details: { sandboxId: 'sandbox-vinext-secret' },
		};
		const registered = applyRegisterResource(snapshot, null, registrationInput);
		const duplicate = applyRegisterResource(registered.snapshot, registered.resource, {
			...registrationInput,
			idempotencyKey: 'resource:register:duplicate',
		});
		expect(registered.snapshot.cleanup.registeredResources).toBe(1);
		expect(duplicate.changed).toBe(false);
		expect(duplicate.snapshot).toBe(registered.snapshot);

		const cancellation = applyRequestCancellation(registered.snapshot, {
			idempotencyKey: 'cancel:with-resource',
			generation: 1,
			timestamp: '2026-09-08T12:00:04.000Z',
		}).snapshot;
		expect(() =>
			applyCompleteCleanup(cancellation, {
				idempotencyKey: 'cleanup:too-early',
				generation: 2,
				timestamp: '2026-09-08T12:00:05.000Z',
			}),
		).toThrowError(expect.objectContaining<Partial<UploadRunDomainError>>({ code: 'RESOURCES_ACTIVE' }));

		const released = applyReleaseResource(cancellation, registered.resource, {
			idempotencyKey: 'resource:release',
			generation: 2,
			timestamp: '2026-09-08T12:00:05.000Z',
			sourceHash: SOURCE_HASH,
			resourceId: registered.resource.resourceId,
			reason: 'Cancellation cleanup',
		});
		const duplicateRelease = applyReleaseResource(released.snapshot, released.resource, {
			idempotencyKey: 'resource:release:duplicate',
			generation: 2,
			timestamp: '2026-09-08T12:00:06.000Z',
			sourceHash: SOURCE_HASH,
			resourceId: released.resource.resourceId,
			reason: 'Cancellation cleanup',
		});
		expect(released.snapshot.cleanup.releasedResources).toBe(1);
		expect(duplicateRelease.changed).toBe(false);

		const cleaned = applyCompleteCleanup(released.snapshot, {
			idempotencyKey: 'cleanup:released',
			generation: 2,
			timestamp: '2026-09-08T12:00:06.000Z',
		});
		expect(cleaned.snapshot.cleanup.status).toBe('completed');
	});
});

describe('upload run WebSocket authorization', () => {
	it('hides runs from the wrong owner and requires a WebSocket upgrade', () => {
		const snapshot = initialRun();
		const wrongOwner = uploadRunWebSocketRejection(webSocketRequest({ 'X-Compatibility-Run-Owner': 'access-user:someone-else' }), snapshot);
		const noUpgrade = uploadRunWebSocketRejection(
			new Request('https://pipeline.example/runs/test', {
				headers: { 'X-Compatibility-Run-Owner': snapshot.ownerPrincipalId },
			}),
			snapshot,
		);
		const authorized = uploadRunWebSocketRejection(webSocketRequest({ 'X-Compatibility-Run-Owner': snapshot.ownerPrincipalId }), snapshot);

		expect(wrongOwner?.status).toBe(404);
		expect(noUpgrade?.status).toBe(426);
		expect(authorized).toBeNull();
		expect(uploadRunWebSocketRejection(webSocketRequest({}), null)?.status).toBe(404);
	});
});

function initialRun(): UploadRunSnapshot {
	return createInitialUploadRun({
		runId: '11111111-1111-4111-8111-111111111111',
		ownerPrincipalId: 'access-user:owner-secret',
		requestedBy: 'owner@example.com',
		siteId: 'site-123',
		siteHostname: 'customer.example.com',
		generation: 1,
		sourceR2Key: 'uploads/private/source.tgz',
		createdAt: CREATED_AT,
	});
}

function preparedRun(): UploadRunSnapshot {
	let snapshot = initialRun();
	snapshot = applyStartPreparing(snapshot, {
		idempotencyKey: 'prepare:start',
		generation: 1,
		timestamp: '2026-09-08T12:00:01.000Z',
	}).snapshot;
	return applyMarkPrepared(snapshot, {
		idempotencyKey: 'prepare:complete',
		generation: 1,
		timestamp: '2026-09-08T12:00:02.000Z',
		manifest,
	}).snapshot;
}

function start(snapshot: UploadRunSnapshot, target: DeploymentTarget, timestamp: string): UploadRunSnapshot {
	const offset = target === 'vinext' ? 0 : target === 'opennext' ? 1 : 2;
	return applyMarkCandidateStarted(snapshot, {
		...sourceMutation(`start:${target}`, timestamp),
		target,
		attempt: 1,
		status: 'building',
		sandboxId: `sandbox-${target}-secret`,
		processId: `process-${target}-secret`,
		port: 3_000 + offset,
	}).snapshot;
}

function report(
	snapshot: UploadRunSnapshot,
	target: DeploymentTarget,
	result: UploadCandidateTerminalResult,
	timestamp: string,
	idempotencyKey = `report:${target}`,
	generation = snapshot.generation,
) {
	const input: ReportCandidateInput = {
		idempotencyKey,
		generation,
		timestamp,
		sourceHash: SOURCE_HASH,
		target,
		attempt: 1,
		result,
	};
	return applyReportCandidate(snapshot, input);
}

function passed(target: DeploymentTarget): UploadCandidateTerminalResult {
	return {
		status: 'passed',
		durationMs: 1_000,
		summary: `${target} passed verification`,
		artifactR2Key: `artifacts/private/${target}.tgz`,
		artifactDigest: digest(target),
		artifactBytes: 2_048,
		finalDeployEligible: true,
		checks: [{ name: 'smoke', status: 'passed', detail: 'Route responded successfully', durationMs: 50 }],
	};
}

function digest(target: DeploymentTarget): string {
	return `sha256:${target}-artifact-secret`;
}

function sourceMutation(idempotencyKey: string, timestamp: string) {
	return { idempotencyKey, generation: 1, timestamp, sourceHash: SOURCE_HASH };
}

function webSocketRequest(headers: Record<string, string>): Request {
	return new Request('https://pipeline.example/runs/test', { headers: { Upgrade: 'websocket', ...headers } });
}
