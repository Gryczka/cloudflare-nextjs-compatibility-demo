/** Candidate artifact and manifest validation for the disabled source-upload
 * prototype; the hosted WfP publisher always uploads its fixed template.
 */
import type { DeploymentTarget } from './domain';

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_BINDING_TYPES = ['assets', 'durable_object_namespace', 'plain_text'] as const;
export const ARTIFACT_RETENTION_MS = Object.freeze({
	sourceAfterTerminal: 24 * 60 * 60 * 1_000,
	unselectedCandidateAfterTerminal: 7 * 24 * 60 * 60 * 1_000,
	selectedCandidateAfterDeletion: 7 * 24 * 60 * 60 * 1_000,
});

export type ArtifactBindingType = (typeof ARTIFACT_BINDING_TYPES)[number];
export type ArtifactRetention = keyof typeof ARTIFACT_RETENTION_MS;
export type ArtifactProbeStatus = 'passed' | 'failed' | 'advisory';
export type WorkerArtifactCandidate = Exclude<DeploymentTarget, 'container'>;

export type ArtifactContractErrorCode =
	| 'INVALID_INPUT'
	| 'UNKNOWN_FIELD'
	| 'INVALID_HASH'
	| 'INVALID_PATH'
	| 'DUPLICATE_PATH'
	| 'DUPLICATE_ENTRY'
	| 'CASE_COLLISION'
	| 'BINDING_NOT_ALLOWED'
	| 'INVALID_TARGET_SHAPE';

export class ArtifactContractError extends Error {
	constructor(
		readonly code: ArtifactContractErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ArtifactContractError';
	}
}

export interface SourceArtifactKeys {
	rawSource: string;
	normalizedSource: string;
}

export interface CandidateArtifactKeys {
	artifact: string;
	manifest: string;
	log: string;
}

export interface ArtifactToolchain {
	runnerVersion: string;
	nodeVersion: string;
	npmVersion: string;
	sandboxImageDigest: string;
}

export interface ArtifactModule {
	path: string;
	hash: string;
	mimeType: string;
}

export interface ArtifactAsset {
	path: string;
	hash: string;
	bytes: number;
	mimeType: string;
}

export interface ArtifactBinding {
	name: string;
	type: ArtifactBindingType;
}

export interface TrustedArtifactProbe {
	name: string;
	status: ArtifactProbeStatus;
	detail: string;
	durationMs: number;
	trusted: true;
}

export interface RuntimeImageIdentity {
	reference: string;
	digest: string;
}

interface ArtifactManifestBase {
	schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION;
	runId: string;
	candidate: DeploymentTarget;
	generation: number;
	sourceHash: string;
	artifactDigest: string;
	artifactBytes: number;
	toolchain: ArtifactToolchain;
	adapterVersion: string;
	modules: ArtifactModule[];
	assets: ArtifactAsset[];
	bindings: ArtifactBinding[];
	probes: TrustedArtifactProbe[];
	createdAt: string;
}

export interface WorkerArtifactManifest extends Omit<ArtifactManifestBase, 'candidate'> {
	candidate: WorkerArtifactCandidate;
	mainModule: string;
}

export interface ContainerArtifactManifest extends Omit<ArtifactManifestBase, 'candidate' | 'modules'> {
	candidate: 'container';
	modules: [];
	runtimeImage: RuntimeImageIdentity;
}

export type ArtifactManifest = WorkerArtifactManifest | ContainerArtifactManifest;

type JsonObject = Record<string, unknown>;

const PRIVATE_RUN_PREFIX = 'private/upload-runs';
const MAX_MODULES = 10_000;
const MAX_ASSETS = 100_000;
const MAX_BINDINGS = 64;
const MAX_PROBES = 64;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MIME_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;
const BINDING_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAIN_MODULE_MIME_TYPES = new Set(['application/javascript', 'application/javascript+module', 'text/javascript']);
const WORKER_MANIFEST_FIELDS = [
	'schemaVersion',
	'runId',
	'candidate',
	'generation',
	'sourceHash',
	'artifactDigest',
	'artifactBytes',
	'toolchain',
	'adapterVersion',
	'mainModule',
	'modules',
	'assets',
	'bindings',
	'probes',
	'createdAt',
] as const;
const CONTAINER_MANIFEST_FIELDS = [
	'schemaVersion',
	'runId',
	'candidate',
	'generation',
	'sourceHash',
	'artifactDigest',
	'artifactBytes',
	'toolchain',
	'adapterVersion',
	'modules',
	'assets',
	'bindings',
	'probes',
	'createdAt',
	'runtimeImage',
] as const;
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function sourceArtifactKeys(runId: string, generation: number): SourceArtifactKeys {
	const root = artifactGenerationRoot(runId, generation);
	return {
		rawSource: `${root}/source/raw.zip`,
		normalizedSource: `${root}/source/normalized.tar.gz`,
	};
}

export function candidateArtifactKeys(runId: string, generation: number, candidate: DeploymentTarget): CandidateArtifactKeys {
	const root = `${artifactGenerationRoot(runId, generation)}/candidates/${deploymentTarget(candidate)}`;
	return {
		artifact: `${root}/artifact.tar.gz`,
		manifest: `${root}/manifest.json`,
		log: `${root}/build.log`,
	};
}

export function artifactRetentionExpiresAt(from: string, retention: ArtifactRetention): string {
	const timestamp = canonicalTimestamp(from, 'retention timestamp');
	if (!hasOwn(ARTIFACT_RETENTION_MS, retention)) fail('INVALID_INPUT', 'retention policy is invalid');
	const expiresAt = Date.parse(timestamp) + ARTIFACT_RETENTION_MS[retention];
	if (!Number.isFinite(expiresAt)) fail('INVALID_INPUT', 'retention timestamp is outside the supported date range');
	try {
		return new Date(expiresAt).toISOString();
	} catch {
		fail('INVALID_INPUT', 'retention timestamp is outside the supported date range');
	}
}

export function validateArtifactManifest(input: unknown, allowedBindings: readonly ArtifactBinding[] = []): ArtifactManifest {
	const value = objectValue(input, 'artifact manifest');
	const candidate = deploymentTarget(value.candidate);
	assertKnownFields(value, candidate === 'container' ? CONTAINER_MANIFEST_FIELDS : WORKER_MANIFEST_FIELDS, 'artifact manifest');

	if (value.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
		fail('INVALID_INPUT', `schemaVersion must be ${ARTIFACT_MANIFEST_SCHEMA_VERSION}`);
	}

	const runId = keyComponent(value.runId, 'runId');
	const generation = positiveInteger(value.generation, 'generation');
	const sourceHash = sha256(value.sourceHash, 'sourceHash');
	const artifactDigest = sha256(value.artifactDigest, 'artifactDigest');
	const artifactBytes = positiveInteger(value.artifactBytes, 'artifactBytes');
	const toolchain = artifactToolchain(value.toolchain);
	const adapterVersion = identityString(value.adapterVersion, 'adapterVersion', 256);
	const modules = artifactModules(value.modules);
	const paths = createPathRegistry();
	for (const module of modules) registerManifestPath(module.path, paths);
	const assets = artifactAssets(value.assets, paths);
	const bindings = artifactBindings(value.bindings, allowedBindings);
	const probes = artifactProbes(value.probes);
	const createdAt = canonicalTimestamp(value.createdAt, 'createdAt');

	const common = {
		schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
		runId,
		generation,
		sourceHash,
		artifactDigest,
		artifactBytes,
		toolchain,
		adapterVersion,
		assets,
		bindings,
		probes,
		createdAt,
	};

	if (candidate === 'container') {
		if (modules.length !== 0) fail('INVALID_TARGET_SHAPE', 'container manifests cannot contain Worker modules');
		return {
			...common,
			candidate,
			modules: [],
			runtimeImage: runtimeImageIdentity(value.runtimeImage),
		};
	}

	if (modules.length === 0) fail('INVALID_TARGET_SHAPE', 'Worker manifests must contain at least one module');
	const mainModule = manifestPath(value.mainModule, 'mainModule');
	const main = modules.find((module) => module.path === mainModule);
	if (!main) fail('INVALID_TARGET_SHAPE', 'mainModule must exactly match a declared module path');
	if (!MAIN_MODULE_MIME_TYPES.has(main.mimeType)) {
		fail('INVALID_TARGET_SHAPE', 'mainModule must use a JavaScript module MIME type');
	}
	return { ...common, candidate, mainModule, modules };
}

function artifactGenerationRoot(runId: string, generation: number): string {
	return `${PRIVATE_RUN_PREFIX}/${keyComponent(runId, 'runId')}/generations/${positiveInteger(generation, 'generation')}`;
}

function artifactToolchain(input: unknown): ArtifactToolchain {
	const value = strictObject(input, ['runnerVersion', 'nodeVersion', 'npmVersion', 'sandboxImageDigest'], 'toolchain');
	return {
		runnerVersion: identityString(value.runnerVersion, 'toolchain.runnerVersion', 256),
		nodeVersion: identityString(value.nodeVersion, 'toolchain.nodeVersion', 128),
		npmVersion: identityString(value.npmVersion, 'toolchain.npmVersion', 128),
		sandboxImageDigest: sha256(value.sandboxImageDigest, 'toolchain.sandboxImageDigest'),
	};
}

function runtimeImageIdentity(input: unknown): RuntimeImageIdentity {
	const value = strictObject(input, ['reference', 'digest'], 'runtimeImage');
	return {
		reference: identityString(value.reference, 'runtimeImage.reference', 512),
		digest: sha256(value.digest, 'runtimeImage.digest'),
	};
}

function artifactModules(input: unknown): ArtifactModule[] {
	return arrayValue(input, 'modules', MAX_MODULES).map((rawModule, index) => {
		const value = strictObject(rawModule, ['path', 'hash', 'mimeType'], `modules[${index}]`);
		return {
			path: manifestPath(value.path, `modules[${index}].path`),
			hash: sha256(value.hash, `modules[${index}].hash`),
			mimeType: mimeType(value.mimeType, `modules[${index}].mimeType`),
		};
	});
}

function artifactAssets(input: unknown, paths: PathRegistry): ArtifactAsset[] {
	return arrayValue(input, 'assets', MAX_ASSETS).map((rawAsset, index) => {
		const value = strictObject(rawAsset, ['path', 'hash', 'bytes', 'mimeType'], `assets[${index}]`);
		const asset = {
			path: manifestPath(value.path, `assets[${index}].path`),
			hash: sha256(value.hash, `assets[${index}].hash`),
			bytes: nonnegativeInteger(value.bytes, `assets[${index}].bytes`),
			mimeType: mimeType(value.mimeType, `assets[${index}].mimeType`),
		};
		registerManifestPath(asset.path, paths);
		return asset;
	});
}

function artifactBindings(input: unknown, allowedInput: readonly ArtifactBinding[]): ArtifactBinding[] {
	const allowed = allowedBindingMap(allowedInput);
	const seen = new Map<string, string>();
	return arrayValue(input, 'bindings', MAX_BINDINGS).map((rawBinding, index) => {
		const binding = bindingValue(rawBinding, `bindings[${index}]`);
		registerUniqueName(binding.name, seen, `binding name ${quote(binding.name)}`);
		if (allowed.get(binding.name) !== binding.type) {
			fail('BINDING_NOT_ALLOWED', `binding ${quote(binding.name)} with type ${quote(binding.type)} is not explicitly allowed`);
		}
		return binding;
	});
}

function allowedBindingMap(input: readonly ArtifactBinding[]): Map<string, ArtifactBindingType> {
	if (!Array.isArray(input)) fail('INVALID_INPUT', 'allowedBindings must be an array');
	if (input.length > MAX_BINDINGS) fail('INVALID_INPUT', `allowedBindings cannot contain more than ${MAX_BINDINGS} entries`);
	const allowed = new Map<string, ArtifactBindingType>();
	const seen = new Map<string, string>();
	for (let index = 0; index < input.length; index += 1) {
		const binding = bindingValue(input[index], `allowedBindings[${index}]`);
		registerUniqueName(binding.name, seen, `allowed binding name ${quote(binding.name)}`);
		allowed.set(binding.name, binding.type);
	}
	return allowed;
}

function bindingValue(input: unknown, name: string): ArtifactBinding {
	const value = strictObject(input, ['name', 'type'], name);
	if (typeof value.name !== 'string' || value.name.length > 128 || !BINDING_NAME_PATTERN.test(value.name)) {
		fail('INVALID_INPUT', `${name}.name must be an ASCII JavaScript identifier of at most 128 characters`);
	}
	if (!ARTIFACT_BINDING_TYPES.includes(value.type as ArtifactBindingType)) {
		fail('INVALID_INPUT', `${name}.type is not a supported P1 binding type`);
	}
	return { name: value.name, type: value.type as ArtifactBindingType };
}

function artifactProbes(input: unknown): TrustedArtifactProbe[] {
	const values = arrayValue(input, 'probes', MAX_PROBES);
	if (values.length === 0) fail('INVALID_INPUT', 'probes must contain at least one trusted result');
	const seen = new Map<string, string>();
	return values.map((rawProbe, index) => {
		const value = strictObject(rawProbe, ['name', 'status', 'detail', 'durationMs', 'trusted'], `probes[${index}]`);
		const name = identityString(value.name, `probes[${index}].name`, 128);
		registerUniqueName(name, seen, `probe name ${quote(name)}`);
		if (value.status !== 'passed' && value.status !== 'failed' && value.status !== 'advisory') {
			fail('INVALID_INPUT', `probes[${index}].status is invalid`);
		}
		if (value.trusted !== true) fail('INVALID_INPUT', `probes[${index}] must be marked as trusted`);
		return {
			name,
			status: value.status,
			detail: boundedText(value.detail, `probes[${index}].detail`, 2_000),
			durationMs: nonnegativeInteger(value.durationMs, `probes[${index}].durationMs`),
			trusted: true,
		};
	});
}

interface PathRegistry {
	files: Set<string>;
	directories: Set<string>;
	foldedSpellings: Map<string, string>;
}

function createPathRegistry(): PathRegistry {
	return { files: new Set(), directories: new Set(), foldedSpellings: new Map() };
}

function registerManifestPath(path: string, registry: PathRegistry): void {
	const segments = path.split('/');
	let current = '';
	for (let index = 0; index < segments.length; index += 1) {
		current = current ? `${current}/${segments[index]}` : segments[index];
		const folded = caseFold(current);
		const priorSpelling = registry.foldedSpellings.get(folded);
		if (priorSpelling !== undefined && priorSpelling !== current) {
			fail('CASE_COLLISION', `manifest paths ${quote(priorSpelling)} and ${quote(current)} collide when case-folded`);
		}
		registry.foldedSpellings.set(folded, current);

		const finalSegment = index === segments.length - 1;
		if (!finalSegment) {
			if (registry.files.has(current)) fail('DUPLICATE_PATH', `manifest path ${quote(current)} is used as both a file and directory`);
			registry.directories.add(current);
			continue;
		}
		if (registry.files.has(current)) fail('DUPLICATE_PATH', `manifest contains duplicate path ${quote(current)}`);
		if (registry.directories.has(current)) fail('DUPLICATE_PATH', `manifest path ${quote(current)} is used as both a file and directory`);
		registry.files.add(current);
	}
}

function registerUniqueName(name: string, seen: Map<string, string>, label: string): void {
	const folded = caseFold(name);
	const prior = seen.get(folded);
	if (prior === name) fail('DUPLICATE_ENTRY', `duplicate ${label}`);
	if (prior !== undefined) fail('CASE_COLLISION', `${label} collides with ${quote(prior)} when case-folded`);
	seen.set(folded, name);
}

function manifestPath(input: unknown, name: string): string {
	if (typeof input !== 'string' || input.length === 0 || input.length > 1_024) {
		fail('INVALID_PATH', `${name} must be a nonempty relative path of at most 1024 characters`);
	}
	if (/[\u0000-\u001f\u007f]/.test(input)) fail('INVALID_PATH', `${name} contains a control character`);
	if (input.includes('\\')) fail('INVALID_PATH', `${name} contains a backslash`);
	if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) fail('INVALID_PATH', `${name} is absolute`);
	if (/%(?:00|2e|2f|5c)/i.test(input)) fail('INVALID_PATH', `${name} contains an encoded path-control sequence`);
	const segments = input.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		fail('INVALID_PATH', `${name} contains traversal or is not canonical`);
	}
	return input;
}

function mimeType(input: unknown, name: string): string {
	if (typeof input !== 'string' || input.length > 255 || !MIME_TYPE_PATTERN.test(input)) {
		fail('INVALID_INPUT', `${name} must be a lowercase MIME type without parameters`);
	}
	return input;
}

function sha256(input: unknown, name: string): string {
	if (typeof input !== 'string' || !SHA256_PATTERN.test(input)) {
		fail('INVALID_HASH', `${name} must be a lowercase sha256 digest`);
	}
	return input;
}

function keyComponent(input: unknown, name: string): string {
	if (typeof input !== 'string' || input.length === 0 || input.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)) {
		fail('INVALID_PATH', `${name} must be a safe ASCII R2 key component of at most 128 characters`);
	}
	return input;
}

function deploymentTarget(input: unknown): DeploymentTarget {
	if (input !== 'vinext' && input !== 'opennext' && input !== 'container') {
		fail('INVALID_INPUT', 'candidate must be vinext, opennext, or container');
	}
	return input;
}

function identityString(input: unknown, name: string, maxLength: number): string {
	if (
		typeof input !== 'string' ||
		input.length === 0 ||
		input.length > maxLength ||
		input.trim() !== input ||
		/\s|[\u0000-\u001f\u007f]/.test(input)
	) {
		fail('INVALID_INPUT', `${name} must be a nonempty identity without whitespace or control characters`);
	}
	return input;
}

function boundedText(input: unknown, name: string, maxLength: number): string {
	if (
		typeof input !== 'string' ||
		input.length === 0 ||
		input.length > maxLength ||
		input.trim() !== input ||
		/[\u0000-\u001f\u007f]/.test(input)
	) {
		fail('INVALID_INPUT', `${name} must be nonempty, trimmed, at most ${maxLength} characters, and contain no control characters`);
	}
	return input;
}

function positiveInteger(input: unknown, name: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 1) fail('INVALID_INPUT', `${name} must be a positive safe integer`);
	return input as number;
}

function nonnegativeInteger(input: unknown, name: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 0) fail('INVALID_INPUT', `${name} must be a nonnegative safe integer`);
	return input as number;
}

function canonicalTimestamp(input: unknown, name: string): string {
	if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
		fail('INVALID_INPUT', `${name} must be a canonical UTC ISO timestamp`);
	}
	const milliseconds = Date.parse(input);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
		fail('INVALID_INPUT', `${name} must be a canonical UTC ISO timestamp`);
	}
	return input;
}

function arrayValue(input: unknown, name: string, maxLength: number): unknown[] {
	if (!Array.isArray(input)) fail('INVALID_INPUT', `${name} must be an array`);
	if (input.length > maxLength) fail('INVALID_INPUT', `${name} cannot contain more than ${maxLength} entries`);
	return input;
}

function strictObject(input: unknown, fields: readonly string[], name: string): JsonObject {
	const value = objectValue(input, name);
	assertKnownFields(value, fields, name);
	return value;
}

function objectValue(input: unknown, name: string): JsonObject {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_INPUT', `${name} must be an object`);
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT', `${name} must be a plain object`);
	return input as JsonObject;
}

function assertKnownFields(value: JsonObject, fields: readonly string[], name: string): void {
	const allowed = new Set(fields);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || !allowed.has(key)) fail('UNKNOWN_FIELD', `${name} contains unknown field ${quote(key)}`);
	}
}

function caseFold(value: string): string {
	return value.normalize('NFKC').toUpperCase().toLowerCase();
}

function quote(value: unknown): string {
	return typeof value === 'symbol' ? value.toString() : JSON.stringify(value);
}

function fail(code: ArtifactContractErrorCode, message: string): never {
	throw new ArtifactContractError(code, message);
}
