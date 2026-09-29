/** Owner-fenced site promotion prototype for the disabled arbitrary-upload path. */
import { DurableObject } from 'cloudflare:workers';

export const MAX_SITES_PER_OWNER = 5;
export const INITIAL_SITE_GENERATION = 1;
export const SITE_STATES = ['building', 'provisional', 'deploying', 'active', 'deleting', 'uncertain'] as const;
export const SITE_CANDIDATES = ['vinext', 'opennext', 'container'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCRIPT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_OWNER_PRINCIPAL_ID_LENGTH = 256;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;

export type SiteState = (typeof SITE_STATES)[number];
export type SiteCandidate = (typeof SITE_CANDIDATES)[number];

export interface SandboxRouteTarget {
	kind: 'sandbox';
	sandboxId: string;
	processId: string;
	port: number;
	candidate: SiteCandidate;
}

export interface WfpRouteTarget {
	kind: 'wfp';
	scriptName: string;
	candidate: SiteCandidate;
}

export interface ContainerShimRouteTarget {
	kind: 'container-shim';
	scriptName: string;
	containerId: string;
	candidate: SiteCandidate;
}

export type SiteRouteTarget = SandboxRouteTarget | WfpRouteTarget | ContainerShimRouteTarget;
export type PromotedRouteTarget = WfpRouteTarget | ContainerShimRouteTarget;

export interface InitializeSiteInput {
	ownerPrincipalId: string;
	runId: string;
	slug: string;
	hostname: string;
}

export interface SiteRecord {
	siteId: string;
	runId: string;
	slug: string;
	hostname: string;
	state: SiteState;
	generation: number;
	routeTarget: SiteRouteTarget | null;
	createdAt: string;
	updatedAt: string;
}

export type InitializeSiteResult = { ok: true; created: boolean; site: SiteRecord } | { ok: false; reason: 'quota' | 'conflict' } | null;

export type SiteDispatchSelector = { siteId: string } | { hostname: string };
export type SiteDispatchAuthorization = Omit<SiteRecord, 'routeTarget'> & { routeTarget: SiteRouteTarget };

export interface SiteMutationFence {
	siteId: string;
	ownerPrincipalId: string;
	generation: number;
}

export interface SiteRegistryInspection {
	ownerBound: boolean;
	siteCount: number;
	sites: SiteRecord[];
}

interface OwnerRow {
	[key: string]: SqlStorageValue;
	owner_principal_id: string;
}

interface CountRow {
	[key: string]: SqlStorageValue;
	count: number;
}

interface SiteRow {
	[key: string]: SqlStorageValue;
	site_id: string;
	owner_principal_id: string;
	run_id: string;
	slug: string;
	hostname: string;
	state: SiteState;
	generation: number;
	route_kind: SiteRouteTarget['kind'] | null;
	candidate: SiteCandidate | null;
	sandbox_id: string | null;
	process_id: string | null;
	port: number | null;
	script_name: string | null;
	container_id: string | null;
	created_at: number;
	updated_at: number;
}

interface RouteColumns {
	kind: SiteRouteTarget['kind'];
	candidate: SiteCandidate;
	sandboxId: string | null;
	processId: string | null;
	port: number | null;
	scriptName: string | null;
	containerId: string | null;
}

export class SiteRegistry extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS site_registry_owner (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				owner_principal_id TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS sites (
				site_id TEXT PRIMARY KEY,
				owner_principal_id TEXT NOT NULL,
				run_id TEXT NOT NULL UNIQUE,
				slug TEXT NOT NULL UNIQUE,
				hostname TEXT NOT NULL UNIQUE,
				state TEXT NOT NULL CHECK (state IN ('building', 'provisional', 'deploying', 'active', 'deleting', 'uncertain')),
				generation INTEGER NOT NULL CHECK (generation >= 1),
				route_kind TEXT CHECK (route_kind IS NULL OR route_kind IN ('sandbox', 'wfp', 'container-shim')),
				candidate TEXT CHECK (candidate IS NULL OR candidate IN ('vinext', 'opennext', 'container')),
				sandbox_id TEXT,
				process_id TEXT,
				port INTEGER CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
				script_name TEXT,
				container_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				CHECK (
					(route_kind IS NULL AND candidate IS NULL AND sandbox_id IS NULL AND process_id IS NULL AND port IS NULL AND script_name IS NULL AND container_id IS NULL)
					OR (route_kind = 'sandbox' AND candidate IS NOT NULL AND sandbox_id IS NOT NULL AND process_id IS NOT NULL AND port IS NOT NULL AND script_name IS NULL AND container_id IS NULL)
					OR (route_kind = 'wfp' AND candidate IS NOT NULL AND sandbox_id IS NULL AND process_id IS NULL AND port IS NULL AND script_name IS NOT NULL AND container_id IS NULL)
					OR (route_kind = 'container-shim' AND candidate IS NOT NULL AND sandbox_id IS NULL AND process_id IS NULL AND port IS NULL AND script_name IS NOT NULL AND container_id IS NOT NULL)
				),
				CHECK (
					(state = 'building' AND route_kind IS NULL)
					OR (state IN ('provisional', 'deploying') AND route_kind = 'sandbox')
					OR (state = 'active' AND route_kind IN ('wfp', 'container-shim'))
					OR state IN ('deleting', 'uncertain')
				)
			);
			CREATE INDEX IF NOT EXISTS sites_by_owner_created
				ON sites (owner_principal_id, created_at DESC, site_id ASC);
			CREATE TRIGGER IF NOT EXISTS sites_immutable_identity
				BEFORE UPDATE OF site_id, owner_principal_id, run_id, hostname ON sites
				BEGIN
					SELECT RAISE(ABORT, 'site identity is immutable');
				END;
		`);
	}

	async initializeSite(rawInput: InitializeSiteInput): Promise<InitializeSiteResult> {
		const input = validateInitializeSiteInput(rawInput);
		let result: InitializeSiteResult | undefined;

		this.ctx.storage.transactionSync(() => {
			const boundOwner = this.#readOwner();
			if (boundOwner !== null && boundOwner !== input.ownerPrincipalId) {
				result = null;
				return;
			}
			if (boundOwner === null) {
				this.ctx.storage.sql.exec('INSERT INTO site_registry_owner (id, owner_principal_id) VALUES (1, ?)', input.ownerPrincipalId);
			}

			const existing = this.#readByRun(input.runId);
			if (existing) {
				if (
					existing.owner_principal_id !== input.ownerPrincipalId ||
					existing.slug !== input.slug ||
					existing.hostname !== input.hostname
				) {
					result = { ok: false, reason: 'conflict' };
					return;
				}
				result = { ok: true, created: false, site: toPublicSiteRecord(existing) };
				return;
			}

			const identifierConflict = this.ctx.storage.sql
				.exec('SELECT 1 FROM sites WHERE slug = ? OR hostname = ? LIMIT 1', input.slug, input.hostname)
				.toArray().length;
			if (identifierConflict > 0) {
				result = { ok: false, reason: 'conflict' };
				return;
			}

			const siteCount = this.ctx.storage.sql.exec<CountRow>('SELECT COUNT(*) AS count FROM sites').one().count;
			if (!hasSiteCapacity(siteCount)) {
				result = { ok: false, reason: 'quota' };
				return;
			}

			const now = Date.now();
			const row = this.ctx.storage.sql
				.exec<SiteRow>(
					`INSERT INTO sites
						(site_id, owner_principal_id, run_id, slug, hostname, state, generation, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'building', ?, ?, ?)
					 RETURNING *`,
					crypto.randomUUID(),
					input.ownerPrincipalId,
					input.runId,
					input.slug,
					input.hostname,
					INITIAL_SITE_GENERATION,
					now,
					now,
				)
				.one();
			result = { ok: true, created: true, site: toPublicSiteRecord(row) };
		});

		if (result === undefined) throw new Error('Site initialization did not produce a result');
		return result;
	}

	async list(ownerPrincipalId: string): Promise<SiteRecord[]> {
		const owner = validateOwnerPrincipalId(ownerPrincipalId);
		if (!this.#ownerMatches(owner)) return [];
		return this.#readAll().map(toPublicSiteRecord);
	}

	async getAuthorized(siteId: string, ownerPrincipalId: string): Promise<SiteRecord | null> {
		const normalizedSiteId = validateUuid(siteId, 'siteId');
		const owner = validateOwnerPrincipalId(ownerPrincipalId);
		const row = this.#readAuthorized(normalizedSiteId, owner);
		return row ? toPublicSiteRecord(row) : null;
	}

	async setProvisional(
		siteId: string,
		ownerPrincipalId: string,
		generation: number,
		rawTarget: SandboxRouteTarget,
	): Promise<SiteRecord | null> {
		const fence = validateSiteMutationFence({ siteId, ownerPrincipalId, generation });
		const target = validateProvisionalRouteTarget(rawTarget);
		let result: SiteRecord | null = null;

		this.ctx.storage.transactionSync(() => {
			const existing = this.#readAuthorized(fence.siteId, fence.ownerPrincipalId);
			if (!existing || existing.generation !== fence.generation) return;
			if (existing.state === 'provisional') {
				if (routeTargetsEqual(routeTargetFromRow(existing), target)) result = toPublicSiteRecord(existing);
				return;
			}
			if (!canSetProvisional(existing.state, existing.generation, fence.generation)) return;

			const route = routeColumns(target);
			const row = this.ctx.storage.sql
				.exec<SiteRow>(
					`UPDATE sites SET
						state = 'provisional', route_kind = ?, candidate = ?, sandbox_id = ?, process_id = ?, port = ?,
						script_name = ?, container_id = ?, updated_at = ?
					 WHERE site_id = ? AND owner_principal_id = ? AND state = 'building' AND generation = ?
					 RETURNING *`,
					route.kind,
					route.candidate,
					route.sandboxId,
					route.processId,
					route.port,
					route.scriptName,
					route.containerId,
					Date.now(),
					fence.siteId,
					fence.ownerPrincipalId,
					fence.generation,
				)
				.toArray()[0];
			result = row ? toPublicSiteRecord(row) : null;
		});

		return result;
	}

	async beginPromotion(siteId: string, ownerPrincipalId: string, generation: number): Promise<SiteRecord | null> {
		const fence = validateSiteMutationFence({ siteId, ownerPrincipalId, generation });
		assertIncrementableGeneration(fence.generation);
		const row = this.ctx.storage.sql
			.exec<SiteRow>(
				`UPDATE sites SET state = 'deploying', generation = generation + 1, updated_at = ?
				 WHERE site_id = ? AND owner_principal_id = ? AND state = 'provisional' AND generation = ?
				 RETURNING *`,
				Date.now(),
				fence.siteId,
				fence.ownerPrincipalId,
				fence.generation,
			)
			.toArray()[0];
		return row ? toPublicSiteRecord(row) : null;
	}

	async completePromotion(
		siteId: string,
		ownerPrincipalId: string,
		generation: number,
		rawTarget: PromotedRouteTarget,
	): Promise<SiteRecord | null> {
		const fence = validateSiteMutationFence({ siteId, ownerPrincipalId, generation });
		const target = validatePromotedRouteTarget(rawTarget);
		let result: SiteRecord | null = null;

		this.ctx.storage.transactionSync(() => {
			const existing = this.#readAuthorized(fence.siteId, fence.ownerPrincipalId);
			if (!existing || existing.generation !== fence.generation) return;
			if (existing.state === 'active') {
				if (routeTargetsEqual(routeTargetFromRow(existing), target)) result = toPublicSiteRecord(existing);
				return;
			}
			if (existing.state !== 'deploying') return;

			const route = routeColumns(target);
			const row = this.ctx.storage.sql
				.exec<SiteRow>(
					`UPDATE sites SET
						state = 'active', route_kind = ?, candidate = ?, sandbox_id = ?, process_id = ?, port = ?,
						script_name = ?, container_id = ?, updated_at = ?
					 WHERE site_id = ? AND owner_principal_id = ? AND state = 'deploying' AND generation = ?
					 RETURNING *`,
					route.kind,
					route.candidate,
					route.sandboxId,
					route.processId,
					route.port,
					route.scriptName,
					route.containerId,
					Date.now(),
					fence.siteId,
					fence.ownerPrincipalId,
					fence.generation,
				)
				.toArray()[0];
			result = row ? toPublicSiteRecord(row) : null;
		});

		return result;
	}

	async beginDelete(siteId: string, ownerPrincipalId: string, generation: number): Promise<SiteRecord | null> {
		const fence = validateSiteMutationFence({ siteId, ownerPrincipalId, generation });
		assertIncrementableGeneration(fence.generation);
		const row = this.ctx.storage.sql
			.exec<SiteRow>(
				`UPDATE sites SET state = 'deleting', generation = generation + 1, updated_at = ?
				 WHERE site_id = ? AND owner_principal_id = ?
					AND state IN ('building', 'provisional', 'deploying', 'active', 'uncertain') AND generation = ?
				 RETURNING *`,
				Date.now(),
				fence.siteId,
				fence.ownerPrincipalId,
				fence.generation,
			)
			.toArray()[0];
		return row ? toPublicSiteRecord(row) : null;
	}

	async completeDelete(siteId: string, ownerPrincipalId: string, generation: number): Promise<boolean> {
		const fence = validateSiteMutationFence({ siteId, ownerPrincipalId, generation });
		return (
			this.ctx.storage.sql
				.exec(
					`DELETE FROM sites
					 WHERE site_id = ? AND owner_principal_id = ? AND state = 'deleting' AND generation = ?
					 RETURNING site_id`,
					fence.siteId,
					fence.ownerPrincipalId,
					fence.generation,
				)
				.toArray().length === 1
		);
	}

	async failDelete(siteId: string, ownerPrincipalId: string, generation: number): Promise<SiteRecord | null> {
		const fence = validateSiteMutationFence({ siteId, ownerPrincipalId, generation });
		let result: SiteRecord | null = null;

		this.ctx.storage.transactionSync(() => {
			const existing = this.#readAuthorized(fence.siteId, fence.ownerPrincipalId);
			if (!existing || existing.generation !== fence.generation) return;
			if (existing.state === 'uncertain') {
				result = toPublicSiteRecord(existing);
				return;
			}
			if (existing.state !== 'deleting') return;
			const row = this.ctx.storage.sql
				.exec<SiteRow>(
					`UPDATE sites SET state = 'uncertain', updated_at = ?
					 WHERE site_id = ? AND owner_principal_id = ? AND state = 'deleting' AND generation = ?
					 RETURNING *`,
					Date.now(),
					fence.siteId,
					fence.ownerPrincipalId,
					fence.generation,
				)
				.toArray()[0];
			result = row ? toPublicSiteRecord(row) : null;
		});

		return result;
	}

	async authorizeDispatch(rawSelector: SiteDispatchSelector, ownerPrincipalId: string): Promise<SiteDispatchAuthorization | null> {
		const selector = validateSiteDispatchSelector(rawSelector);
		const owner = validateOwnerPrincipalId(ownerPrincipalId);
		if (!this.#ownerMatches(owner)) return null;
		const row =
			'siteId' in selector
				? this.ctx.storage.sql
						.exec<SiteRow>(
							`SELECT * FROM sites
							 WHERE site_id = ? AND owner_principal_id = ?
								AND state IN ('provisional', 'deploying', 'active') AND route_kind IS NOT NULL`,
							selector.siteId,
							owner,
						)
						.toArray()[0]
				: this.ctx.storage.sql
						.exec<SiteRow>(
							`SELECT * FROM sites
							 WHERE hostname = ? AND owner_principal_id = ?
								AND state IN ('provisional', 'deploying', 'active') AND route_kind IS NOT NULL`,
							selector.hostname,
							owner,
						)
						.toArray()[0];
		if (!row) return null;
		const site = toPublicSiteRecord(row);
		if (!site.routeTarget) throw new Error('Dispatchable site is missing a route target');
		return { ...site, routeTarget: site.routeTarget };
	}

	async inspect(): Promise<SiteRegistryInspection> {
		const sites = this.#readAll().map(toPublicSiteRecord);
		return { ownerBound: this.#readOwner() !== null, siteCount: sites.length, sites };
	}

	#readOwner(): string | null {
		return (
			this.ctx.storage.sql.exec<OwnerRow>('SELECT owner_principal_id FROM site_registry_owner WHERE id = 1').toArray()[0]
				?.owner_principal_id ?? null
		);
	}

	#ownerMatches(ownerPrincipalId: string): boolean {
		return this.#readOwner() === ownerPrincipalId;
	}

	#readByRun(runId: string): SiteRow | null {
		return this.ctx.storage.sql.exec<SiteRow>('SELECT * FROM sites WHERE run_id = ?', runId).toArray()[0] ?? null;
	}

	#readAuthorized(siteId: string, ownerPrincipalId: string): SiteRow | null {
		return (
			this.ctx.storage.sql
				.exec<SiteRow>('SELECT * FROM sites WHERE site_id = ? AND owner_principal_id = ?', siteId, ownerPrincipalId)
				.toArray()[0] ?? null
		);
	}

	#readAll(): SiteRow[] {
		return this.ctx.storage.sql.exec<SiteRow>('SELECT * FROM sites ORDER BY created_at DESC, site_id ASC').toArray();
	}
}

export function validateInitializeSiteInput(input: unknown): InitializeSiteInput {
	const value = requireRecord(input, 'site initialization');
	assertExactKeys(value, ['ownerPrincipalId', 'runId', 'slug', 'hostname'], 'site initialization');
	return {
		ownerPrincipalId: validateOwnerPrincipalId(value.ownerPrincipalId),
		runId: validateUuid(value.runId, 'runId'),
		slug: validateSiteSlug(value.slug),
		hostname: validateHostname(value.hostname),
	};
}

export function validateOwnerPrincipalId(value: unknown): string {
	if (typeof value !== 'string') throw new TypeError('ownerPrincipalId must be a string');
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_OWNER_PRINCIPAL_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new TypeError(`ownerPrincipalId must be 1-${MAX_OWNER_PRINCIPAL_ID_LENGTH} printable characters`);
	}
	return normalized;
}

export function validateSiteSlug(value: unknown): string {
	if (typeof value !== 'string' || !DNS_LABEL_PATTERN.test(value)) {
		throw new TypeError('slug must be a lowercase DNS label between 1 and 63 characters');
	}
	return value;
}

export function validateHostname(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
		throw new TypeError('hostname must be a DNS hostname no longer than 253 characters');
	}
	const labels = value.split('.');
	if (labels.some((label) => !DNS_LABEL_PATTERN.test(label))) {
		throw new TypeError('hostname must contain only lowercase DNS labels');
	}
	return value;
}

export function validateRouteTarget(target: unknown): SiteRouteTarget {
	const value = requireRecord(target, 'route target');
	if (value.kind === 'sandbox') {
		assertExactKeys(value, ['kind', 'sandboxId', 'processId', 'port', 'candidate'], 'sandbox route target');
		return {
			kind: 'sandbox',
			sandboxId: validateOpaqueId(value.sandboxId, 'sandboxId'),
			processId: validateOpaqueId(value.processId, 'processId'),
			port: validatePort(value.port),
			candidate: validateCandidate(value.candidate),
		};
	}
	if (value.kind === 'wfp') {
		assertExactKeys(value, ['kind', 'scriptName', 'candidate'], 'wfp route target');
		return {
			kind: 'wfp',
			scriptName: validateScriptName(value.scriptName),
			candidate: validateCandidate(value.candidate),
		};
	}
	if (value.kind === 'container-shim') {
		assertExactKeys(value, ['kind', 'scriptName', 'containerId', 'candidate'], 'container-shim route target');
		return {
			kind: 'container-shim',
			scriptName: validateScriptName(value.scriptName),
			containerId: validateOpaqueId(value.containerId, 'containerId'),
			candidate: validateCandidate(value.candidate),
		};
	}
	throw new TypeError('route target kind must be sandbox, wfp, or container-shim');
}

export function validateProvisionalRouteTarget(target: unknown): SandboxRouteTarget {
	const validated = validateRouteTarget(target);
	if (validated.kind !== 'sandbox') throw new TypeError('provisional route target must be sandbox');
	return validated;
}

export function validatePromotedRouteTarget(target: unknown): PromotedRouteTarget {
	const validated = validateRouteTarget(target);
	if (validated.kind === 'sandbox') throw new TypeError('promoted route target must be wfp or container-shim');
	return validated;
}

export function validateSiteMutationFence(input: unknown): SiteMutationFence {
	const value = requireRecord(input, 'site mutation fence');
	assertExactKeys(value, ['siteId', 'ownerPrincipalId', 'generation'], 'site mutation fence');
	return {
		siteId: validateUuid(value.siteId, 'siteId'),
		ownerPrincipalId: validateOwnerPrincipalId(value.ownerPrincipalId),
		generation: validateGeneration(value.generation),
	};
}

export function validateSiteDispatchSelector(selector: unknown): SiteDispatchSelector {
	const value = requireRecord(selector, 'site dispatch selector');
	const keys = Object.keys(value);
	if (keys.length !== 1) throw new TypeError('site dispatch selector must contain exactly one identifier');
	if (Object.hasOwn(value, 'siteId')) {
		assertExactKeys(value, ['siteId'], 'site dispatch selector');
		return { siteId: validateUuid(value.siteId, 'siteId') };
	}
	if (Object.hasOwn(value, 'hostname')) {
		assertExactKeys(value, ['hostname'], 'site dispatch selector');
		return { hostname: validateHostname(value.hostname) };
	}
	throw new TypeError('site dispatch selector must contain siteId or hostname');
}

export function validateGeneration(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < INITIAL_SITE_GENERATION || (value as number) > MAX_GENERATION) {
		throw new RangeError(`generation must be an integer between ${INITIAL_SITE_GENERATION} and ${MAX_GENERATION}`);
	}
	return value as number;
}

function assertIncrementableGeneration(generation: number): void {
	if (generation >= MAX_GENERATION) throw new RangeError('generation cannot be incremented');
}

export function hasSiteCapacity(siteCount: number): boolean {
	if (!Number.isSafeInteger(siteCount) || siteCount < 0) throw new RangeError('siteCount must be a nonnegative integer');
	return siteCount < MAX_SITES_PER_OWNER;
}

export function canSetProvisional(state: SiteState, generation: number, expectedGeneration: number): boolean {
	return state === 'building' && generation === expectedGeneration;
}

export function isDispatchableSiteState(state: SiteState): boolean {
	return state === 'provisional' || state === 'deploying' || state === 'active';
}

export function redactSiteOwner(record: SiteRecord & { ownerPrincipalId: string }): SiteRecord {
	return {
		siteId: record.siteId,
		runId: record.runId,
		slug: record.slug,
		hostname: record.hostname,
		state: record.state,
		generation: record.generation,
		routeTarget: record.routeTarget ? cloneRouteTarget(record.routeTarget) : null,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function toPublicSiteRecord(row: SiteRow): SiteRecord {
	return redactSiteOwner({
		siteId: row.site_id,
		ownerPrincipalId: row.owner_principal_id,
		runId: row.run_id,
		slug: row.slug,
		hostname: row.hostname,
		state: row.state,
		generation: row.generation,
		routeTarget: routeTargetFromRow(row),
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
	});
}

function routeTargetFromRow(row: SiteRow): SiteRouteTarget | null {
	if (row.route_kind === null) return null;
	if (!row.candidate) throw new Error('Stored site route is missing a candidate');
	if (row.route_kind === 'sandbox') {
		if (!row.sandbox_id || !row.process_id || row.port === null) throw new Error('Stored sandbox route is incomplete');
		return { kind: 'sandbox', sandboxId: row.sandbox_id, processId: row.process_id, port: row.port, candidate: row.candidate };
	}
	if (row.route_kind === 'wfp') {
		if (!row.script_name) throw new Error('Stored WfP route is incomplete');
		return { kind: 'wfp', scriptName: row.script_name, candidate: row.candidate };
	}
	if (!row.script_name || !row.container_id) throw new Error('Stored container-shim route is incomplete');
	return { kind: 'container-shim', scriptName: row.script_name, containerId: row.container_id, candidate: row.candidate };
}

function routeColumns(target: SiteRouteTarget): RouteColumns {
	if (target.kind === 'sandbox') {
		return {
			kind: target.kind,
			candidate: target.candidate,
			sandboxId: target.sandboxId,
			processId: target.processId,
			port: target.port,
			scriptName: null,
			containerId: null,
		};
	}
	if (target.kind === 'wfp') {
		return {
			kind: target.kind,
			candidate: target.candidate,
			sandboxId: null,
			processId: null,
			port: null,
			scriptName: target.scriptName,
			containerId: null,
		};
	}
	return {
		kind: target.kind,
		candidate: target.candidate,
		sandboxId: null,
		processId: null,
		port: null,
		scriptName: target.scriptName,
		containerId: target.containerId,
	};
}

function routeTargetsEqual(left: SiteRouteTarget | null, right: SiteRouteTarget): boolean {
	if (!left || left.kind !== right.kind || left.candidate !== right.candidate) return false;
	if (left.kind === 'sandbox' && right.kind === 'sandbox') {
		return left.sandboxId === right.sandboxId && left.processId === right.processId && left.port === right.port;
	}
	if (left.kind === 'wfp' && right.kind === 'wfp') return left.scriptName === right.scriptName;
	if (left.kind === 'container-shim' && right.kind === 'container-shim') {
		return left.scriptName === right.scriptName && left.containerId === right.containerId;
	}
	return false;
}

function cloneRouteTarget(target: SiteRouteTarget): SiteRouteTarget {
	if (target.kind === 'sandbox') return { ...target };
	if (target.kind === 'wfp') return { ...target };
	return { ...target };
}

function validateCandidate(value: unknown): SiteCandidate {
	if (typeof value !== 'string' || !SITE_CANDIDATES.includes(value as SiteCandidate)) {
		throw new TypeError('candidate must be vinext, opennext, or container');
	}
	return value as SiteCandidate;
}

function validatePort(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
		throw new RangeError('port must be an integer between 1 and 65535');
	}
	return value as number;
}

function validateScriptName(value: unknown): string {
	if (typeof value !== 'string' || !SCRIPT_NAME_PATTERN.test(value)) {
		throw new TypeError('scriptName must contain 1-128 lowercase letters, numbers, hyphens, or underscores');
	}
	return value;
}

function validateOpaqueId(value: unknown, name: 'sandboxId' | 'processId' | 'containerId'): string {
	if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) {
		throw new TypeError(`${name} must be a nonempty identifier no longer than 256 characters`);
	}
	return value;
}

function validateUuid(value: unknown, name: 'runId' | 'siteId'): string {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`${name} must be a UUID`);
	return value.toLowerCase();
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], name: string): void {
	if (
		Object.keys(value).length !== expectedKeys.length ||
		expectedKeys.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !expectedKeys.includes(key))
	) {
		throw new TypeError(`${name} has missing or unsupported fields`);
	}
}
