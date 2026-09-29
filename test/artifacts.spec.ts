import { describe, expect, it } from 'vitest';
import {
	ARTIFACT_MANIFEST_SCHEMA_VERSION,
	ARTIFACT_RETENTION_MS,
	ArtifactContractError,
	artifactRetentionExpiresAt,
	candidateArtifactKeys,
	sourceArtifactKeys,
	validateArtifactManifest,
	type ArtifactBinding,
	type ArtifactContractErrorCode,
} from '../src/artifacts';
import type { DeploymentTarget } from '../src/domain';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const SHA_C = `sha256:${'c'.repeat(64)}`;
const CREATED_AT = '2026-09-08T12:00:00.000Z';
const ASSETS_BINDING = [{ name: 'ASSETS', type: 'assets' }] as const satisfies readonly ArtifactBinding[];

describe('artifact R2 keys', () => {
	it('creates deterministic generation-fenced private source keys', () => {
		expect(sourceArtifactKeys('run-123', 4)).toEqual({
			rawSource: 'private/upload-runs/run-123/generations/4/source/raw.zip',
			normalizedSource: 'private/upload-runs/run-123/generations/4/source/normalized.tar.gz',
		});
		expect(sourceArtifactKeys('run-123', 4)).toEqual(sourceArtifactKeys('run-123', 4));
		expect(sourceArtifactKeys('run-123', 5)).not.toEqual(sourceArtifactKeys('run-123', 4));
	});

	it('creates isolated per-candidate artifact, manifest, and log keys', () => {
		expect(candidateArtifactKeys('run-123', 4, 'opennext')).toEqual({
			artifact: 'private/upload-runs/run-123/generations/4/candidates/opennext/artifact.tar.gz',
			manifest: 'private/upload-runs/run-123/generations/4/candidates/opennext/manifest.json',
			log: 'private/upload-runs/run-123/generations/4/candidates/opennext/build.log',
		});
		expect(candidateArtifactKeys('run-123', 4, 'vinext')).not.toEqual(candidateArtifactKeys('run-123', 4, 'container'));
	});

	it.each(['../run', '/run', 'parent/run', 'parent\\run', `run\0id`, ' run', '.', ''])('rejects unsafe run ID %j', (runId) => {
		expectCode(() => sourceArtifactKeys(runId, 1), 'INVALID_PATH');
	});

	it('rejects invalid generations and candidates at runtime', () => {
		for (const generation of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expectCode(() => sourceArtifactKeys('run-123', generation), 'INVALID_INPUT');
		}
		expectCode(() => candidateArtifactKeys('run-123', 1, 'other' as DeploymentTarget), 'INVALID_INPUT');
	});
});

describe('artifact retention', () => {
	it('publishes and applies the approved retention windows', () => {
		expect(ARTIFACT_RETENTION_MS).toEqual({
			sourceAfterTerminal: 86_400_000,
			unselectedCandidateAfterTerminal: 604_800_000,
			selectedCandidateAfterDeletion: 604_800_000,
		});
		expect(artifactRetentionExpiresAt(CREATED_AT, 'sourceAfterTerminal')).toBe('2026-09-09T12:00:00.000Z');
		expect(artifactRetentionExpiresAt(CREATED_AT, 'unselectedCandidateAfterTerminal')).toBe('2026-09-15T12:00:00.000Z');
		expect(artifactRetentionExpiresAt(CREATED_AT, 'selectedCandidateAfterDeletion')).toBe('2026-09-15T12:00:00.000Z');
	});

	it.each(['not-a-date', '2026-09-08', '2026-09-08T12:00:00Z', '2026-09-08T12:00:00.000+00:00'])('rejects noncanonical date %j', (date) => {
		expectCode(() => artifactRetentionExpiresAt(date, 'sourceAfterTerminal'), 'INVALID_INPUT');
	});

	it('rejects an unknown policy at runtime', () => {
		expectCode(() => artifactRetentionExpiresAt(CREATED_AT, 'forever' as keyof typeof ARTIFACT_RETENTION_MS), 'INVALID_INPUT');
	});
});

describe('validateArtifactManifest', () => {
	it('accepts and copies a complete Worker artifact manifest', () => {
		const input = workerManifest();
		const result = validateArtifactManifest(input, ASSETS_BINDING);

		expect(result).toEqual(input);
		expect(result).not.toBe(input);
		expect(result.toolchain).not.toBe(input.toolchain);
		expect(result.modules).not.toBe(input.modules);
		expect(result).toMatchObject({
			schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
			runId: 'run-123',
			candidate: 'vinext',
			generation: 2,
			sourceHash: SHA_A,
			artifactDigest: SHA_B,
			artifactBytes: 4_096,
			adapterVersion: '@cloudflare/vinext@1.2.3',
			mainModule: 'worker/index.mjs',
			createdAt: CREATED_AT,
		});
	});

	it('accepts a container manifest with immutable runtime image identity', () => {
		const input = containerManifest();
		const result = validateArtifactManifest(input, [
			{ name: 'CONTAINER', type: 'durable_object_namespace' },
			{ name: 'SITE_ID', type: 'plain_text' },
		]);

		expect(result).toEqual(input);
		expect(result).toMatchObject({
			candidate: 'container',
			modules: [],
			runtimeImage: {
				reference: 'registry.example.test/platform/next-runtime:2026-09-08',
				digest: SHA_C,
			},
		});
	});

	it('denies every binding unless its exact name and type are explicitly allowed', () => {
		expectCode(() => validateArtifactManifest(workerManifest()), 'BINDING_NOT_ALLOWED');
		expectCode(() => validateArtifactManifest(workerManifest(), [{ name: 'assets', type: 'assets' }]), 'BINDING_NOT_ALLOWED');
		expectCode(() => validateArtifactManifest(workerManifest(), [{ name: 'ASSETS', type: 'plain_text' }]), 'BINDING_NOT_ALLOWED');
		expect(validateArtifactManifest(workerManifest({ bindings: [] })).bindings).toEqual([]);
	});

	it('limits binding types to the P1 non-secret platform surface', () => {
		const input = workerManifest({ bindings: [{ name: 'SECRET', type: 'secret_text' }] });
		expectCode(
			() => validateArtifactManifest(input, [{ name: 'SECRET', type: 'secret_text' } as unknown as ArtifactBinding]),
			'INVALID_INPUT',
		);
	});

	it('rejects unknown fields at every manifest level', () => {
		const cases = [
			workerManifest({ extra: true }),
			mutate(workerManifest(), (value) => ((value.toolchain as JsonObject).extra = true)),
			mutate(workerManifest(), (value) => ((value.modules as JsonObject[])[0].extra = true)),
			mutate(workerManifest(), (value) => ((value.assets as JsonObject[])[0].extra = true)),
			mutate(workerManifest(), (value) => ((value.bindings as JsonObject[])[0].extra = true)),
			mutate(workerManifest(), (value) => ((value.probes as JsonObject[])[0].extra = true)),
			mutate(containerManifest(), (value) => ((value.runtimeImage as JsonObject).extra = true)),
		];

		for (const input of cases) expectCode(() => validateForCandidate(input), 'UNKNOWN_FIELD');
	});

	it.each([
		'/absolute.mjs',
		'C:/absolute.mjs',
		'../outside.mjs',
		'worker/../outside.mjs',
		'worker/./index.mjs',
		'worker//index.mjs',
		'worker\\index.mjs',
		`worker/nul\0index.mjs`,
		'worker/%2e%2e/outside.mjs',
		'worker/%2Foutside.mjs',
	])('rejects unsafe module path %j', (path) => {
		const input = workerManifest({ mainModule: path, modules: [moduleEntry(path)] });
		expectCode(() => validateArtifactManifest(input, ASSETS_BINDING), 'INVALID_PATH');
	});

	it('applies the same path policy to assets and mainModule', () => {
		const badAsset = workerManifest({ assets: [assetEntry('../asset.txt')] });
		expectCode(() => validateArtifactManifest(badAsset, ASSETS_BINDING), 'INVALID_PATH');

		const badMain = workerManifest({ mainModule: '../worker/index.mjs' });
		expectCode(() => validateArtifactManifest(badMain, ASSETS_BINDING), 'INVALID_PATH');
	});

	it('rejects duplicate, case-colliding, and file-directory-conflicting paths', () => {
		const duplicate = workerManifest({ modules: [moduleEntry(), moduleEntry()] });
		expectCode(() => validateArtifactManifest(duplicate, ASSETS_BINDING), 'DUPLICATE_PATH');

		const caseCollision = workerManifest({
			assets: [assetEntry('_next/app.js'), assetEntry('_NEXT/other.js')],
		});
		expectCode(() => validateArtifactManifest(caseCollision, ASSETS_BINDING), 'CASE_COLLISION');

		const crossCollectionDuplicate = workerManifest({ assets: [assetEntry('worker/index.mjs')] });
		expectCode(() => validateArtifactManifest(crossCollectionDuplicate, ASSETS_BINDING), 'DUPLICATE_PATH');

		const fileDirectoryConflict = workerManifest({ assets: [assetEntry('worker/index.mjs/chunk.js')] });
		expectCode(() => validateArtifactManifest(fileDirectoryConflict, ASSETS_BINDING), 'DUPLICATE_PATH');
	});

	it('rejects malformed SHA-256 values everywhere hashes are accepted', () => {
		const invalidHashes = [
			workerManifest({ sourceHash: 'sha256:short' }),
			workerManifest({ artifactDigest: SHA_A.toUpperCase() }),
			mutate(workerManifest(), (value) => ((value.toolchain as JsonObject).sandboxImageDigest = 'a'.repeat(64))),
			workerManifest({ modules: [moduleEntry('worker/index.mjs', 'md5:abc')] }),
			workerManifest({ assets: [assetEntry('_next/app.js', 'sha256:not-hex')] }),
			mutate(containerManifest(), (value) => ((value.runtimeImage as JsonObject).digest = 'sha256:xyz')),
		];

		for (const input of invalidHashes) expectCode(() => validateForCandidate(input), 'INVALID_HASH');
	});

	it.each(['text/javascript; charset=utf-8', 'Text/Javascript', 'javascript', '', 'text/plain\n'])(
		'rejects invalid MIME type %j',
		(mimeType) => {
			const input = workerManifest({ modules: [moduleEntry('worker/index.mjs', SHA_C, mimeType)] });
			expectCode(() => validateArtifactManifest(input, ASSETS_BINDING), 'INVALID_INPUT');
		},
	);

	it('rejects invalid Worker-specific shapes', () => {
		expectCode(() => validateArtifactManifest(workerManifest({ modules: [] }), ASSETS_BINDING), 'INVALID_TARGET_SHAPE');
		expectCode(
			() => validateArtifactManifest(workerManifest({ mainModule: 'worker/missing.mjs' }), ASSETS_BINDING),
			'INVALID_TARGET_SHAPE',
		);
		expectCode(
			() =>
				validateArtifactManifest(workerManifest({ modules: [moduleEntry('worker/index.mjs', SHA_C, 'application/wasm')] }), ASSETS_BINDING),
			'INVALID_TARGET_SHAPE',
		);
		expectCode(
			() => validateArtifactManifest(workerManifest({ runtimeImage: { reference: 'image', digest: SHA_C } }), ASSETS_BINDING),
			'UNKNOWN_FIELD',
		);
	});

	it('rejects invalid container-specific shapes', () => {
		expectCode(
			() => validateArtifactManifest(containerManifest({ modules: [moduleEntry()] }), containerBindings()),
			'INVALID_TARGET_SHAPE',
		);
		expectCode(() => validateArtifactManifest(containerManifest({ mainModule: 'worker/index.mjs' }), containerBindings()), 'UNKNOWN_FIELD');
		expectCode(() => validateArtifactManifest(without(containerManifest(), 'runtimeImage'), containerBindings()), 'INVALID_INPUT');
	});

	it('rejects unsupported candidates and schema versions', () => {
		expectCode(() => validateArtifactManifest(workerManifest({ candidate: 'other' }), ASSETS_BINDING), 'INVALID_INPUT');
		expectCode(() => validateArtifactManifest(workerManifest({ schemaVersion: 2 }), ASSETS_BINDING), 'INVALID_INPUT');
	});

	it('requires canonical positive byte counts and generation', () => {
		for (const [field, value] of [
			['generation', 0],
			['artifactBytes', -1],
			['artifactBytes', 1.5],
			['artifactBytes', Number.POSITIVE_INFINITY],
		] as const) {
			expectCode(() => validateArtifactManifest(workerManifest({ [field]: value }), ASSETS_BINDING), 'INVALID_INPUT');
		}
		expectCode(
			() => validateArtifactManifest(workerManifest({ assets: [assetEntry('_next/empty.js', SHA_A, -1)] }), ASSETS_BINDING),
			'INVALID_INPUT',
		);
	});

	it('requires bounded, unique, explicitly trusted probe results', () => {
		expectCode(() => validateArtifactManifest(workerManifest({ probes: [] }), ASSETS_BINDING), 'INVALID_INPUT');
		expectCode(() => validateArtifactManifest(workerManifest({ probes: [probe(), probe()] }), ASSETS_BINDING), 'DUPLICATE_ENTRY');
		expectCode(
			() => validateArtifactManifest(workerManifest({ probes: [probe(), probe({ name: 'ROOT' })] }), ASSETS_BINDING),
			'CASE_COLLISION',
		);
		expectCode(() => validateArtifactManifest(workerManifest({ probes: [probe({ trusted: false })] }), ASSETS_BINDING), 'INVALID_INPUT');
		expectCode(() => validateArtifactManifest(workerManifest({ probes: [probe({ status: 'unknown' })] }), ASSETS_BINDING), 'INVALID_INPUT');
	});

	it('rejects duplicate and case-colliding binding names', () => {
		const duplicate = workerManifest({
			bindings: [
				{ name: 'ASSETS', type: 'assets' },
				{ name: 'ASSETS', type: 'assets' },
			],
		});
		expectCode(() => validateArtifactManifest(duplicate, ASSETS_BINDING), 'DUPLICATE_ENTRY');

		const collision = workerManifest({
			bindings: [
				{ name: 'ASSETS', type: 'assets' },
				{ name: 'assets', type: 'assets' },
			],
		});
		expectCode(() => validateArtifactManifest(collision, [...ASSETS_BINDING, { name: 'assets', type: 'assets' }]), 'CASE_COLLISION');
	});

	it('requires a canonical creation timestamp and safe run ID', () => {
		expectCode(() => validateArtifactManifest(workerManifest({ createdAt: '2026-09-08T12:00:00Z' }), ASSETS_BINDING), 'INVALID_INPUT');
		expectCode(() => validateArtifactManifest(workerManifest({ runId: '../other-run' }), ASSETS_BINDING), 'INVALID_PATH');
	});
});

type JsonObject = Record<string, unknown>;

function workerManifest(overrides: JsonObject = {}): JsonObject {
	return {
		schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
		runId: 'run-123',
		candidate: 'vinext',
		generation: 2,
		sourceHash: SHA_A,
		artifactDigest: SHA_B,
		artifactBytes: 4_096,
		toolchain: toolchain(),
		adapterVersion: '@cloudflare/vinext@1.2.3',
		mainModule: 'worker/index.mjs',
		modules: [moduleEntry()],
		assets: [assetEntry()],
		bindings: [{ name: 'ASSETS', type: 'assets' }],
		probes: [probe()],
		createdAt: CREATED_AT,
		...overrides,
	};
}

function containerManifest(overrides: JsonObject = {}): JsonObject {
	return {
		schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
		runId: 'run-123',
		candidate: 'container',
		generation: 2,
		sourceHash: SHA_A,
		artifactDigest: SHA_B,
		artifactBytes: 32_768,
		toolchain: toolchain(),
		adapterVersion: 'next-standalone@1.0.0',
		modules: [],
		assets: [assetEntry()],
		bindings: [
			{ name: 'CONTAINER', type: 'durable_object_namespace' },
			{ name: 'SITE_ID', type: 'plain_text' },
		],
		probes: [probe()],
		createdAt: CREATED_AT,
		runtimeImage: {
			reference: 'registry.example.test/platform/next-runtime:2026-09-08',
			digest: SHA_C,
		},
		...overrides,
	};
}

function toolchain(): JsonObject {
	return {
		runnerVersion: 'runner@1.0.0',
		nodeVersion: '22.19.0',
		npmVersion: '10.9.3',
		sandboxImageDigest: SHA_C,
	};
}

function moduleEntry(path = 'worker/index.mjs', hash = SHA_C, mimeType = 'application/javascript+module'): JsonObject {
	return { path, hash, mimeType };
}

function assetEntry(path = '_next/static/app.js', hash = SHA_A, bytes = 1_024, mimeType = 'text/javascript'): JsonObject {
	return { path, hash, bytes, mimeType };
}

function probe(overrides: JsonObject = {}): JsonObject {
	return {
		name: 'root',
		status: 'passed',
		detail: 'GET / returned 200',
		durationMs: 12,
		trusted: true,
		...overrides,
	};
}

function containerBindings(): ArtifactBinding[] {
	return [
		{ name: 'CONTAINER', type: 'durable_object_namespace' },
		{ name: 'SITE_ID', type: 'plain_text' },
	];
}

function validateForCandidate(input: JsonObject): unknown {
	return input.candidate === 'container'
		? validateArtifactManifest(input, containerBindings())
		: validateArtifactManifest(input, ASSETS_BINDING);
}

function mutate(input: JsonObject, mutation: (value: JsonObject) => void): JsonObject {
	mutation(input);
	return input;
}

function without(input: JsonObject, field: string): JsonObject {
	delete input[field];
	return input;
}

function expectCode(run: () => unknown, code: ArtifactContractErrorCode): void {
	let error: unknown;
	try {
		run();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ArtifactContractError);
	expect(error).toMatchObject({ code });
}
