/** Defensive ZIP inventory validation for the disabled arbitrary-upload path. */
export type SourceArchiveEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface SourceArchiveEntry {
	path: string;
	uncompressedBytes: number;
	compressedBytes: number;
	kind: SourceArchiveEntryKind;
}

export interface SourceArchiveInspection {
	entries: readonly SourceArchiveEntry[];
	packageJson: unknown;
	packageLock: unknown;
	sourceHash: string;
	lockHash: string;
}

export interface SourceArchiveLimits {
	maxCompressedBytes: number;
	maxExpandedBytes: number;
	maxEntries: number;
	maxDepth: number;
	maxCompressionRatio: number;
}

export interface SourceManifest {
	root: string;
	appName: string;
	sourceHash: string;
	lockHash: string;
	entryCount: number;
	fileCount: number;
	directoryCount: number;
	compressedBytes: number;
	uncompressedBytes: number;
}

export type SourceArchiveValidationCode =
	| 'INVALID_LIMITS'
	| 'INVALID_ENTRY'
	| 'ENTRY_LIMIT_EXCEEDED'
	| 'COMPRESSED_SIZE_EXCEEDED'
	| 'EXPANDED_SIZE_EXCEEDED'
	| 'COMPRESSION_RATIO_EXCEEDED'
	| 'INVALID_PATH'
	| 'PATH_DEPTH_EXCEEDED'
	| 'DUPLICATE_PATH'
	| 'CASE_COLLISION'
	| 'UNSUPPORTED_ENTRY_KIND'
	| 'FORBIDDEN_PATH'
	| 'FORBIDDEN_CREDENTIAL'
	| 'NESTED_ARCHIVE'
	| 'AMBIGUOUS_ROOT'
	| 'WORKSPACES_NOT_SUPPORTED'
	| 'INVALID_PACKAGE_JSON'
	| 'INVALID_PACKAGE_LOCK'
	| 'UNTRUSTED_RESOLVED_URL'
	| 'INVALID_HASH';

export const DEFAULT_SOURCE_ARCHIVE_LIMITS: Readonly<SourceArchiveLimits> = Object.freeze({
	maxCompressedBytes: 50 * 1024 * 1024,
	maxExpandedBytes: 1024 * 1024 * 1024,
	maxEntries: 50_000,
	maxDepth: 32,
	maxCompressionRatio: 100,
});

export class SourceArchiveValidationError extends Error {
	constructor(
		readonly code: SourceArchiveValidationCode,
		message: string,
	) {
		super(message);
		this.name = 'SourceArchiveValidationError';
	}
}

type JsonObject = Record<string, unknown>;
type NormalizedEntry = SourceArchiveEntry & { path: string; kind: 'file' | 'directory' };

const ARCHIVE_SUFFIXES = [
	'.a',
	'.7z',
	'.apk',
	'.ar',
	'.br',
	'.bz2',
	'.cab',
	'.cpio',
	'.deb',
	'.dmg',
	'.ear',
	'.gz',
	'.img',
	'.ipa',
	'.iso',
	'.jar',
	'.lz',
	'.lz4',
	'.lzma',
	'.nupkg',
	'.pkg',
	'.rar',
	'.rpm',
	'.tar',
	'.tar.br',
	'.tar.bz2',
	'.tar.gz',
	'.tar.lz',
	'.tar.lz4',
	'.tar.lzma',
	'.tar.xz',
	'.tar.zst',
	'.taz',
	'.tbz',
	'.tbz2',
	'.tgz',
	'.tlz',
	'.txz',
	'.tzst',
	'.war',
	'.whl',
	'.xz',
	'.xpi',
	'.z',
	'.zip',
	'.zipx',
	'.zst',
] as const;
const SAFE_TEMPLATE_SUFFIXES = ['example', 'sample', 'template', 'dist'] as const;
const CREDENTIAL_FILENAMES = new Set([
	'.credentials',
	'.credentials.json',
	'.dockerconfigjson',
	'.netrc',
	'.pypirc',
	'.secrets',
	'auth.json',
	'credentials',
	'credentials.json',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	'id_rsa',
	'kubeconfig',
	'secret.json',
	'secrets.json',
	'service-account.json',
	'service-account-key.json',
	'service_account.json',
	'service_account_key.json',
]);
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function validateSourceArchive(inspection: SourceArchiveInspection, overrides: Partial<SourceArchiveLimits> = {}): SourceManifest {
	const limits = resolveLimits(overrides);
	if (!isObject(inspection) || !Array.isArray(inspection.entries)) {
		fail('INVALID_ENTRY', 'Archive inspection must contain an entries array');
	}
	if (inspection.entries.length > limits.maxEntries) {
		fail('ENTRY_LIMIT_EXCEEDED', `Archive contains ${inspection.entries.length} entries; limit is ${limits.maxEntries}`);
	}

	const sourceHash = validateHash(inspection.sourceHash, 'sourceHash');
	const lockHash = validateHash(inspection.lockHash, 'lockHash');
	const entries: NormalizedEntry[] = [];
	const explicitPaths = new Set<string>();
	const treeKinds = new Map<string, 'file' | 'directory'>();
	const foldedPaths = new Map<string, string>();
	const packageJsonPaths: string[] = [];
	const packageLockPaths: string[] = [];
	let compressedBytes = 0;
	let uncompressedBytes = 0;
	let fileCount = 0;
	let directoryCount = 0;

	for (let index = 0; index < inspection.entries.length; index += 1) {
		const entry = normalizeEntry(inspection.entries[index], index, limits.maxDepth);
		registerPath(entry, explicitPaths, treeKinds, foldedPaths);
		validateAllowedPath(entry);

		compressedBytes = addWithinLimit(
			compressedBytes,
			entry.compressedBytes,
			limits.maxCompressedBytes,
			'COMPRESSED_SIZE_EXCEEDED',
			'compressed',
		);
		uncompressedBytes = addWithinLimit(
			uncompressedBytes,
			entry.uncompressedBytes,
			limits.maxExpandedBytes,
			'EXPANDED_SIZE_EXCEEDED',
			'expanded',
		);
		if (
			entry.uncompressedBytes > 0 &&
			(entry.compressedBytes === 0 || entry.uncompressedBytes / entry.compressedBytes > limits.maxCompressionRatio)
		) {
			fail(
				'COMPRESSION_RATIO_EXCEEDED',
				`Archive entry ${quote(entry.path)} exceeds the ${limits.maxCompressionRatio}:1 compression ratio limit`,
			);
		}

		if (entry.kind === 'file') {
			fileCount += 1;
			const name = basename(entry.path);
			if (name === 'package.json') packageJsonPaths.push(entry.path);
			if (name === 'package-lock.json') packageLockPaths.push(entry.path);
		} else {
			directoryCount += 1;
		}
		entries.push(entry);
	}

	if (uncompressedBytes > 0 && (compressedBytes === 0 || uncompressedBytes / compressedBytes > limits.maxCompressionRatio)) {
		fail('COMPRESSION_RATIO_EXCEEDED', `Archive exceeds the ${limits.maxCompressionRatio}:1 aggregate compression ratio limit`);
	}

	const root = resolveRoot(entries, packageJsonPaths, packageLockPaths);
	const { appName, nextSpec } = validatePackageJson(inspection.packageJson);
	validatePackageLock(inspection.packageLock, appName, nextSpec);

	return {
		root,
		appName,
		sourceHash,
		lockHash,
		entryCount: entries.length,
		fileCount,
		directoryCount,
		compressedBytes,
		uncompressedBytes,
	};
}

function resolveLimits(overrides: Partial<SourceArchiveLimits>): SourceArchiveLimits {
	const limits: SourceArchiveLimits = {
		maxCompressedBytes: overrides.maxCompressedBytes ?? DEFAULT_SOURCE_ARCHIVE_LIMITS.maxCompressedBytes,
		maxExpandedBytes: overrides.maxExpandedBytes ?? DEFAULT_SOURCE_ARCHIVE_LIMITS.maxExpandedBytes,
		maxEntries: overrides.maxEntries ?? DEFAULT_SOURCE_ARCHIVE_LIMITS.maxEntries,
		maxDepth: overrides.maxDepth ?? DEFAULT_SOURCE_ARCHIVE_LIMITS.maxDepth,
		maxCompressionRatio: overrides.maxCompressionRatio ?? DEFAULT_SOURCE_ARCHIVE_LIMITS.maxCompressionRatio,
	};

	for (const [name, value] of [
		['maxCompressedBytes', limits.maxCompressedBytes],
		['maxExpandedBytes', limits.maxExpandedBytes],
		['maxEntries', limits.maxEntries],
		['maxDepth', limits.maxDepth],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) {
			fail('INVALID_LIMITS', `${name} must be a non-negative safe integer`);
		}
	}
	if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio <= 0) {
		fail('INVALID_LIMITS', 'maxCompressionRatio must be a positive finite number');
	}
	return limits;
}

function normalizeEntry(rawEntry: SourceArchiveEntry | undefined, index: number, maxDepth: number): NormalizedEntry {
	if (!isObject(rawEntry)) fail('INVALID_ENTRY', `Archive entry ${index} must be an object`);
	if (rawEntry.kind === 'symlink' || rawEntry.kind === 'other') {
		fail('UNSUPPORTED_ENTRY_KIND', `Archive entry ${index} has unsupported kind ${quote(rawEntry.kind)}`);
	}
	if (rawEntry.kind !== 'file' && rawEntry.kind !== 'directory') {
		fail('INVALID_ENTRY', `Archive entry ${index} has an invalid kind`);
	}
	if (!Number.isSafeInteger(rawEntry.uncompressedBytes) || rawEntry.uncompressedBytes < 0) {
		fail('INVALID_ENTRY', `Archive entry ${index} has invalid uncompressedBytes`);
	}
	if (!Number.isSafeInteger(rawEntry.compressedBytes) || rawEntry.compressedBytes < 0) {
		fail('INVALID_ENTRY', `Archive entry ${index} has invalid compressedBytes`);
	}
	if (typeof rawEntry.path !== 'string' || rawEntry.path.length === 0) {
		fail('INVALID_PATH', `Archive entry ${index} has an empty or non-string path`);
	}
	if (rawEntry.path.includes('\0')) {
		fail('INVALID_PATH', `Archive entry ${index} path contains NUL`);
	}
	if (rawEntry.path.includes('\\')) {
		fail('INVALID_PATH', `Archive entry ${index} path contains a backslash`);
	}
	if (rawEntry.path.startsWith('/') || /^[A-Za-z]:/.test(rawEntry.path)) {
		fail('INVALID_PATH', `Archive entry ${index} path is absolute`);
	}

	let path = rawEntry.path;
	if (path.endsWith('/')) {
		if (rawEntry.kind !== 'directory') {
			fail('INVALID_PATH', `File entry ${quote(path)} has a trailing slash`);
		}
		path = path.slice(0, -1);
	}
	const segments = path.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.')) {
		fail('INVALID_PATH', `Archive entry path ${quote(rawEntry.path)} is not canonical`);
	}
	if (segments.includes('..')) {
		fail('INVALID_PATH', `Archive entry path ${quote(rawEntry.path)} contains dot-dot traversal`);
	}
	if (segments.length > maxDepth) {
		fail('PATH_DEPTH_EXCEEDED', `Archive entry path ${quote(rawEntry.path)} exceeds depth ${maxDepth}`);
	}

	return {
		path,
		kind: rawEntry.kind,
		uncompressedBytes: rawEntry.uncompressedBytes,
		compressedBytes: rawEntry.compressedBytes,
	};
}

function registerPath(
	entry: NormalizedEntry,
	explicitPaths: Set<string>,
	treeKinds: Map<string, 'file' | 'directory'>,
	foldedPaths: Map<string, string>,
): void {
	const segments = entry.path.split('/');
	let current = '';
	for (let index = 0; index < segments.length; index += 1) {
		current = current.length === 0 ? segments[index] : `${current}/${segments[index]}`;
		const folded = caseFold(current);
		const existingSpelling = foldedPaths.get(folded);
		if (existingSpelling !== undefined && existingSpelling !== current) {
			fail('CASE_COLLISION', `Archive paths ${quote(existingSpelling)} and ${quote(current)} collide when case-folded`);
		}
		foldedPaths.set(folded, current);

		const finalSegment = index === segments.length - 1;
		const existingKind = treeKinds.get(current);
		if (!finalSegment) {
			if (existingKind === 'file') {
				fail('DUPLICATE_PATH', `Archive file ${quote(current)} is also used as a directory`);
			}
			treeKinds.set(current, 'directory');
			continue;
		}

		if (explicitPaths.has(current)) {
			fail('DUPLICATE_PATH', `Archive contains duplicate path ${quote(current)}`);
		}
		if (existingKind === 'file' || (existingKind === 'directory' && entry.kind === 'file')) {
			fail('DUPLICATE_PATH', `Archive path ${quote(current)} is used as both a file and directory`);
		}
		explicitPaths.add(current);
		treeKinds.set(current, entry.kind);
	}
}

function validateAllowedPath(entry: NormalizedEntry): void {
	const segments = entry.path.split('/');
	const foldedSegments = segments.map(caseFold);
	for (const segment of foldedSegments) {
		if (segment === 'node_modules' || segment === '.git' || segment === '.npmrc') {
			fail('FORBIDDEN_PATH', `Archive path ${quote(entry.path)} contains forbidden component ${quote(segment)}`);
		}
	}
	if (entry.kind !== 'file') return;

	const name = foldedSegments[foldedSegments.length - 1];
	if (ARCHIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
		fail('NESTED_ARCHIVE', `Archive contains nested archive ${quote(entry.path)}`);
	}
	if (isCredentialPath(foldedSegments)) {
		fail('FORBIDDEN_CREDENTIAL', `Archive contains credential or environment file ${quote(entry.path)}`);
	}
}

function isCredentialPath(segments: readonly string[]): boolean {
	const name = segments[segments.length - 1];
	const parent = segments.at(-2);
	if (isEnvironmentSecret(name, '.env') || isEnvironmentSecret(name, '.dev.vars')) return true;
	if (CREDENTIAL_FILENAMES.has(name)) return true;
	if (/\.(?:key|pem|p12|pfx|jks|keystore)$/.test(name)) return true;
	const structuredCredential = name.match(/^(.*)\.(?:json|ya?ml|toml|ini|conf|config)$/)?.[1];
	if (structuredCredential && /(?:^|[._-])(?:credential|credentials|secret|secrets)(?:[._-]|$)/.test(structuredCredential)) {
		return true;
	}
	if (parent === '.aws' && name === 'credentials') return true;
	if (parent === '.docker' && name === 'config.json') return true;
	return false;
}

function isEnvironmentSecret(name: string, prefix: '.env' | '.dev.vars'): boolean {
	if (name === prefix) return true;
	if (!name.startsWith(`${prefix}.`)) return false;
	return !SAFE_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(`.${suffix}`));
}

function resolveRoot(
	entries: readonly NormalizedEntry[],
	packageJsonPaths: readonly string[],
	packageLockPaths: readonly string[],
): string {
	if (packageJsonPaths.length !== 1 || packageLockPaths.length !== 1) {
		fail(
			'AMBIGUOUS_ROOT',
			`Archive must contain exactly one package.json and one package-lock.json; found ${packageJsonPaths.length} and ${packageLockPaths.length}`,
		);
	}
	const packageRoot = dirname(packageJsonPaths[0]);
	const lockRoot = dirname(packageLockPaths[0]);
	if (packageRoot !== lockRoot) {
		fail('AMBIGUOUS_ROOT', 'package.json and package-lock.json must be in the same project root');
	}

	if (packageRoot !== '.') {
		for (const entry of entries) {
			const insideRoot = entry.path === packageRoot || entry.path.startsWith(`${packageRoot}/`);
			const rootAncestor = entry.kind === 'directory' && packageRoot.startsWith(`${entry.path}/`);
			if (!insideRoot && !rootAncestor) {
				fail('AMBIGUOUS_ROOT', `Archive entry ${quote(entry.path)} is outside project root ${quote(packageRoot)}`);
			}
		}
	}
	return packageRoot;
}

function validatePackageJson(value: unknown): { appName: string; nextSpec: string } {
	if (!isObject(value)) fail('INVALID_PACKAGE_JSON', 'Parsed package.json must be an object');
	if (hasOwn(value, 'workspaces')) {
		fail('WORKSPACES_NOT_SUPPORTED', 'npm workspaces are not supported');
	}

	const appName = value.name;
	if (
		typeof appName !== 'string' ||
		appName.length === 0 ||
		appName.length > 214 ||
		appName.trim() !== appName ||
		/[\u0000-\u001f\u007f]/.test(appName)
	) {
		fail('INVALID_PACKAGE_JSON', 'package.json name must be a trimmed string of 1 to 214 characters');
	}

	for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		const dependencies = value[section];
		if (!isObject(dependencies)) continue;
		for (const spec of Object.values(dependencies)) {
			if (typeof spec === 'string' && /^(?:workspace|file|link):/.test(spec.trimStart())) {
				fail('WORKSPACES_NOT_SUPPORTED', `package.json ${section} contains a local or workspace dependency`);
			}
		}
	}

	const dependencies = value.dependencies;
	const nextSpec = isObject(dependencies) ? dependencies.next : undefined;
	if (typeof nextSpec !== 'string' || nextSpec.trim().length === 0) {
		fail('INVALID_PACKAGE_JSON', 'package.json must declare next in dependencies');
	}
	return { appName, nextSpec };
}

function validatePackageLock(value: unknown, appName: string, nextSpec: string): void {
	if (!isObject(value)) fail('INVALID_PACKAGE_LOCK', 'Parsed package-lock.json must be an object');
	if (value.lockfileVersion !== 2 && value.lockfileVersion !== 3) {
		fail('INVALID_PACKAGE_LOCK', 'package-lock.json lockfileVersion must be 2 or 3');
	}
	if (hasOwn(value, 'workspaces')) {
		fail('WORKSPACES_NOT_SUPPORTED', 'package-lock.json workspaces are not supported');
	}
	if (value.name !== undefined && value.name !== appName) {
		fail('INVALID_PACKAGE_LOCK', 'package-lock.json name does not match package.json');
	}

	const packages = value.packages;
	if (!isObject(packages)) fail('INVALID_PACKAGE_LOCK', 'package-lock.json must contain a packages object');
	const rootPackage = packages[''];
	if (!isObject(rootPackage)) fail('INVALID_PACKAGE_LOCK', 'package-lock.json must contain its root package entry');
	if (hasOwn(rootPackage, 'workspaces')) {
		fail('WORKSPACES_NOT_SUPPORTED', 'package-lock.json root package contains workspaces');
	}
	if (rootPackage.name !== undefined && rootPackage.name !== appName) {
		fail('INVALID_PACKAGE_LOCK', 'package-lock.json root package name does not match package.json');
	}
	const rootDependencies = rootPackage.dependencies;
	if (!isObject(rootDependencies) || rootDependencies.next !== nextSpec) {
		fail('INVALID_PACKAGE_LOCK', 'package-lock.json does not lock the declared next dependency');
	}

	for (const [path, metadata] of Object.entries(packages)) {
		if (path !== '' && !isNodeModulesLockPath(path)) {
			fail('WORKSPACES_NOT_SUPPORTED', `package-lock.json contains local or workspace package ${quote(path)}`);
		}
		if (!isObject(metadata)) {
			fail('INVALID_PACKAGE_LOCK', `package-lock.json package ${quote(path)} must be an object`);
		}
		if (metadata.link === true) {
			fail('WORKSPACES_NOT_SUPPORTED', `package-lock.json package ${quote(path)} is a local link`);
		}
	}

	const nextPackage = packages['node_modules/next'];
	if (!isObject(nextPackage) || typeof nextPackage.resolved !== 'string') {
		fail('INVALID_PACKAGE_LOCK', 'package-lock.json must contain a resolved node_modules/next package');
	}
	validateResolvedUrls(value);
}

function validateResolvedUrls(lockfile: JsonObject): void {
	const pending: unknown[] = [lockfile];
	const visited = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== 'object' || visited.has(current)) continue;
		visited.add(current);
		for (const [key, child] of Object.entries(current)) {
			if (key === 'resolved') validateResolvedUrl(child);
			if (child && typeof child === 'object') pending.push(child);
		}
	}
}

function validateResolvedUrl(value: unknown): void {
	if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) {
		fail('UNTRUSTED_RESOLVED_URL', 'Every package-lock.json resolved value must be an HTTPS registry.npmjs.org URL');
	}
	let resolved: URL;
	try {
		resolved = new URL(value);
	} catch {
		fail('UNTRUSTED_RESOLVED_URL', `Invalid package-lock.json resolved URL ${quote(value)}`);
	}
	if (
		resolved.protocol !== 'https:' ||
		resolved.hostname !== 'registry.npmjs.org' ||
		resolved.username.length > 0 ||
		resolved.password.length > 0 ||
		resolved.port.length > 0
	) {
		fail('UNTRUSTED_RESOLVED_URL', `Untrusted package-lock.json resolved URL ${quote(value)}`);
	}
}

function validateHash(value: unknown, name: 'sourceHash' | 'lockHash'): string {
	if (typeof value !== 'string' || value.length === 0 || /\s|[\u0000-\u001f\u007f]/.test(value)) {
		fail('INVALID_HASH', `${name} must be a non-empty opaque string without whitespace or control characters`);
	}
	return value;
}

function addWithinLimit(
	current: number,
	value: number,
	limit: number,
	code: 'COMPRESSED_SIZE_EXCEEDED' | 'EXPANDED_SIZE_EXCEEDED',
	label: 'compressed' | 'expanded',
): number {
	if (value > limit - current) {
		fail(code, `Archive ${label} size exceeds ${limit} bytes`);
	}
	return current + value;
}

function isNodeModulesLockPath(path: string): boolean {
	if (!path.startsWith('node_modules/')) return false;
	return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\'));
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function caseFold(value: string): string {
	return value.normalize('NFKC').toUpperCase().toLowerCase();
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
	const separator = path.lastIndexOf('/');
	return separator === -1 ? '.' : path.slice(0, separator);
}

function quote(value: unknown): string {
	return JSON.stringify(value);
}

function fail(code: SourceArchiveValidationCode, message: string): never {
	throw new SourceArchiveValidationError(code, message);
}
