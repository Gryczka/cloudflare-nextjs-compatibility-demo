import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SOURCE_ARCHIVE_LIMITS,
	SourceArchiveValidationError,
	type SourceArchiveEntry,
	type SourceArchiveInspection,
	type SourceArchiveLimits,
	type SourceArchiveValidationCode,
	validateSourceArchive,
} from '../src/source-archive';

const NEXT_RESOLVED = 'https://registry.npmjs.org/next/-/next-16.0.0.tgz';

describe('validateSourceArchive', () => {
	it('returns a normalized manifest and allows environment templates', () => {
		const result = validateSourceArchive(
			inspection({
				entries: [...baseEntries(), entry('next-app/.env.production.example', 10, 8)],
			}),
		);

		expect(result).toEqual({
			root: 'next-app',
			appName: 'safe-next-app',
			sourceHash: 'sha256:source',
			lockHash: 'sha256:lock',
			entryCount: 6,
			fileCount: 5,
			directoryCount: 1,
			compressedBytes: 338,
			uncompressedBytes: 570,
		});
	});

	it('normalizes an archive-root project to dot', () => {
		const entries = baseEntries()
			.slice(1)
			.map((item) => ({ ...item, path: item.path.slice('next-app/'.length) }));

		expect(validateSourceArchive(inspection({ entries })).root).toBe('.');
	});

	it('publishes the approved default limits', () => {
		expect(DEFAULT_SOURCE_ARCHIVE_LIMITS).toEqual({
			maxCompressedBytes: 50 * 1024 * 1024,
			maxExpandedBytes: 1024 * 1024 * 1024,
			maxEntries: 50_000,
			maxDepth: 32,
			maxCompressionRatio: 100,
		});
	});

	it('accepts exact custom boundaries and rejects values over each boundary', () => {
		const exact: SourceArchiveLimits = {
			maxCompressedBytes: 330,
			maxExpandedBytes: 560,
			maxEntries: 5,
			maxDepth: 3,
			maxCompressionRatio: 2,
		};
		expect(validateSourceArchive(inspection(), exact).entryCount).toBe(5);

		const rejected: Array<[Partial<SourceArchiveLimits>, SourceArchiveValidationCode]> = [
			[{ maxCompressedBytes: 329 }, 'COMPRESSED_SIZE_EXCEEDED'],
			[{ maxExpandedBytes: 559 }, 'EXPANDED_SIZE_EXCEEDED'],
			[{ maxEntries: 4 }, 'ENTRY_LIMIT_EXCEEDED'],
			[{ maxDepth: 2 }, 'PATH_DEPTH_EXCEEDED'],
			[{ maxCompressionRatio: 1.99 }, 'COMPRESSION_RATIO_EXCEEDED'],
		];
		for (const [limits, code] of rejected) expectCode(() => validateSourceArchive(inspection(), limits), code);
	});

	it('rejects a non-empty entry that claims zero compressed bytes', () => {
		expectCode(
			() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('next-app/zero.txt', 1, 0)] })),
			'COMPRESSION_RATIO_EXCEEDED',
		);
	});

	it.each([
		['/absolute.txt'],
		['C:/absolute.txt'],
		['next-app/../outside.txt'],
		['next-app/./inside.txt'],
		['next-app\\windows.txt'],
		[`next-app/nul\0name.txt`],
	])('rejects unsafe or non-canonical path %j', (path) => {
		expectCode(() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry(path)] })), 'INVALID_PATH');
	});

	it('rejects exact duplicates, file-directory conflicts, and case-folded parent collisions', () => {
		expectCode(() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('next-app/app/page.tsx')] })), 'DUPLICATE_PATH');
		expectCode(() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('next-app/app', 1, 1)] })), 'DUPLICATE_PATH');
		expectCode(() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('next-app/App/other.tsx')] })), 'CASE_COLLISION');
	});

	it.each(['symlink', 'other'] as const)('rejects %s entries', (kind) => {
		expectCode(
			() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('next-app/unsafe', 0, 0, kind)] })),
			'UNSUPPORTED_ENTRY_KIND',
		);
	});

	it.each([
		['next-app/node_modules/evil/index.js', 'FORBIDDEN_PATH'],
		['next-app/.Git/config', 'FORBIDDEN_PATH'],
		['next-app/.npmrc', 'FORBIDDEN_PATH'],
		['next-app/vendor.TAR.GZ', 'NESTED_ARCHIVE'],
		['next-app/vendor.tar.zst', 'NESTED_ARCHIVE'],
		['next-app/.env', 'FORBIDDEN_CREDENTIAL'],
		['next-app/.env.local', 'FORBIDDEN_CREDENTIAL'],
		['next-app/.dev.vars', 'FORBIDDEN_CREDENTIAL'],
		['next-app/credentials.json', 'FORBIDDEN_CREDENTIAL'],
		['next-app/client-credentials.yml', 'FORBIDDEN_CREDENTIAL'],
		['next-app/server.key', 'FORBIDDEN_CREDENTIAL'],
	] as const)('rejects forbidden source path %s', (path, code) => {
		expectCode(() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry(path)] })), code);
	});

	it('rejects malformed entry sizes before summing them', () => {
		for (const badSize of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expectCode(
				() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('next-app/bad-size.txt', badSize, 1)] })),
				'INVALID_ENTRY',
			);
		}
	});

	it('requires exactly one aligned package root with no sibling payload', () => {
		expectCode(
			() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('next-app/example/package.json')] })),
			'AMBIGUOUS_ROOT',
		);
		expectCode(
			() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('other/package-lock.json')] })),
			'AMBIGUOUS_ROOT',
		);
		expectCode(() => validateSourceArchive(inspection({ entries: [...baseEntries(), entry('outside.txt')] })), 'AMBIGUOUS_ROOT');
	});

	it('rejects package and lockfile workspace representations', () => {
		expectCode(
			() => validateSourceArchive(inspection({ packageJson: { ...packageJson(), workspaces: ['packages/*'] } })),
			'WORKSPACES_NOT_SUPPORTED',
		);
		expectCode(
			() =>
				validateSourceArchive(inspection({ packageJson: { ...packageJson(), dependencies: { next: '16.0.0', local: 'file:../local' } } })),
			'WORKSPACES_NOT_SUPPORTED',
		);

		const lock = packageLock();
		const packages = lock.packages as Record<string, unknown>;
		expectCode(
			() =>
				validateSourceArchive(
					inspection({
						packageLock: { ...lock, packages: { ...packages, 'packages/web': { version: '1.0.0' } } },
					}),
				),
			'WORKSPACES_NOT_SUPPORTED',
		);
	});

	it.each([2, 3])('accepts package-lock version %i', (lockfileVersion) => {
		expect(validateSourceArchive(inspection({ packageLock: packageLock(lockfileVersion) })).appName).toBe('safe-next-app');
	});

	it('requires a named app, a production next dependency, and a matching lock entry', () => {
		expectCode(
			() => validateSourceArchive(inspection({ packageJson: { name: 'safe-next-app', devDependencies: { next: '16.0.0' } } })),
			'INVALID_PACKAGE_JSON',
		);
		expectCode(() => validateSourceArchive(inspection({ packageJson: { dependencies: { next: '16.0.0' } } })), 'INVALID_PACKAGE_JSON');
		expectCode(() => validateSourceArchive(inspection({ packageLock: packageLock(1) })), 'INVALID_PACKAGE_LOCK');

		const lock = packageLock();
		const packages = lock.packages as Record<string, unknown>;
		expectCode(
			() =>
				validateSourceArchive(
					inspection({
						packageLock: {
							...lock,
							packages: { ...packages, '': { name: 'safe-next-app', dependencies: { next: '15.0.0' } } },
						},
					}),
				),
			'INVALID_PACKAGE_LOCK',
		);
	});

	it.each([
		'http://registry.npmjs.org/next/-/next-16.0.0.tgz',
		'https://registry.example.com/next/-/next-16.0.0.tgz',
		'https://registry.npmjs.org.evil.example/next.tgz',
		'https://registry.npmjs.org@evil.example/next.tgz',
		'file:../next',
	])('rejects untrusted lockfile URL %s', (resolved) => {
		expectCode(() => validateSourceArchive(inspection({ packageLock: packageLock(3, resolved) })), 'UNTRUSTED_RESOLVED_URL');
	});

	it('checks resolved URLs recursively, including the v2 dependency tree', () => {
		expectCode(
			() =>
				validateSourceArchive(
					inspection({
						packageLock: {
							...packageLock(2),
							dependencies: { transitive: { resolved: 'https://packages.example.test/transitive.tgz' } },
						},
					}),
				),
			'UNTRUSTED_RESOLVED_URL',
		);
	});

	it('rejects whitespace-bearing caller hashes', () => {
		expectCode(() => validateSourceArchive(inspection({ sourceHash: 'sha256:bad hash' })), 'INVALID_HASH');
	});
});

function inspection(overrides: Partial<SourceArchiveInspection> = {}): SourceArchiveInspection {
	return {
		entries: baseEntries(),
		packageJson: packageJson(),
		packageLock: packageLock(),
		sourceHash: 'sha256:source',
		lockHash: 'sha256:lock',
		...overrides,
	};
}

function baseEntries(): SourceArchiveEntry[] {
	return [
		entry('next-app/', 0, 0, 'directory'),
		entry('next-app/package.json', 120, 80),
		entry('next-app/package-lock.json', 300, 150),
		entry('next-app/app/page.tsx', 100, 70),
		entry('next-app/.env.example', 40, 30),
	];
}

function entry(path: string, uncompressedBytes = 1, compressedBytes = 1, kind: SourceArchiveEntry['kind'] = 'file'): SourceArchiveEntry {
	return { path, uncompressedBytes, compressedBytes, kind };
}

function packageJson(): Record<string, unknown> {
	return {
		name: 'safe-next-app',
		version: '1.0.0',
		dependencies: { next: '16.0.0' },
	};
}

function packageLock(lockfileVersion = 3, resolved = NEXT_RESOLVED): Record<string, unknown> {
	return {
		name: 'safe-next-app',
		lockfileVersion,
		packages: {
			'': { name: 'safe-next-app', version: '1.0.0', dependencies: { next: '16.0.0' } },
			'node_modules/next': { version: '16.0.0', resolved },
		},
	};
}

function expectCode(run: () => unknown, code: SourceArchiveValidationCode): void {
	let error: unknown;
	try {
		run();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(SourceArchiveValidationError);
	expect(error).toMatchObject({ code });
}
