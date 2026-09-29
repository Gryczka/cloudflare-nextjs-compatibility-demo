import { describe, expect, it } from 'vitest';
import {
	canSetProvisional,
	hasSiteCapacity,
	INITIAL_SITE_GENERATION,
	isDispatchableSiteState,
	MAX_SITES_PER_OWNER,
	redactSiteOwner,
	SiteRegistry,
	SITE_STATES,
	validateGeneration,
	validateHostname,
	validateInitializeSiteInput,
	validatePromotedRouteTarget,
	validateProvisionalRouteTarget,
	validateRouteTarget,
	validateSiteDispatchSelector,
	validateSiteMutationFence,
	validateSiteSlug,
	type InitializeSiteInput,
	type SiteRecord,
} from '../src/site-registry';

const runId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';
const ownerPrincipalId = 'access-user:test-owner';

const initialization: InitializeSiteInput = {
	ownerPrincipalId,
	runId,
	slug: 'my-site',
	hostname: 'my-site.preview.example.com',
};

describe('site identity validation', () => {
	it('accepts canonical DNS labels and their inclusive length boundary', () => {
		expect(validateSiteSlug('a')).toBe('a');
		expect(validateSiteSlug(`a${'b'.repeat(61)}z`)).toHaveLength(63);
		expect(validateHostname('my-site.preview.example.com')).toBe('my-site.preview.example.com');
	});

	it.each(['', '-site', 'site-', 'Site', 'site.name', 'site_name', `a${'b'.repeat(63)}`])('rejects invalid slug %j', (slug) => {
		expect(() => validateSiteSlug(slug)).toThrow('lowercase DNS label');
	});

	it.each(['UPPER.example.com', 'bad_label.example.com', '.example.com', 'example.com.', `${'a'.repeat(64)}.example.com`])(
		'rejects invalid hostname %j',
		(hostname) => {
			expect(() => validateHostname(hostname)).toThrow('hostname');
		},
	);

	it('normalizes only stable identity fields with an explicit normalization rule', () => {
		expect(
			validateInitializeSiteInput({
				...initialization,
				ownerPrincipalId: `  ${ownerPrincipalId}  `,
				runId: runId.toUpperCase(),
			}),
		).toEqual(initialization);
	});

	it('rejects malformed, missing, and additional initialization data', () => {
		expect(() => validateInitializeSiteInput({ ...initialization, runId: 'run-1' })).toThrow('runId must be a UUID');
		expect(() => validateInitializeSiteInput({ ...initialization, ownerPrincipalId: '   ' })).toThrow('ownerPrincipalId');
		expect(() => validateInitializeSiteInput({ ...initialization, hostname: 'Other.example.com' })).toThrow('hostname');
		expect(() => validateInitializeSiteInput({ ...initialization, unexpected: true })).toThrow('unsupported fields');
	});
});

describe('site route validation', () => {
	it('accepts and copies every supported route shape', () => {
		const routes = [
			{ kind: 'sandbox', sandboxId: 'sandbox-1', processId: 'preview-1', port: 3_000, candidate: 'vinext' },
			{ kind: 'wfp', scriptName: 'site-worker-1', candidate: 'opennext' },
			{ kind: 'container-shim', scriptName: 'site-shim-1', containerId: 'abcdef123456', candidate: 'container' },
		] as const;

		for (const route of routes) {
			const validated = validateRouteTarget(route);
			expect(validated).toEqual(route);
			expect(validated).not.toBe(route);
		}
	});

	it('enforces provisional and promoted target roles', () => {
		const sandbox = { kind: 'sandbox', sandboxId: 'sandbox-1', processId: 'preview-1', port: 3_000, candidate: 'vinext' } as const;
		const wfp = { kind: 'wfp', scriptName: 'site-worker-1', candidate: 'opennext' } as const;

		expect(validateProvisionalRouteTarget(sandbox)).toEqual(sandbox);
		expect(validatePromotedRouteTarget(wfp)).toEqual(wfp);
		expect(() => validateProvisionalRouteTarget(wfp)).toThrow('must be sandbox');
		expect(() => validatePromotedRouteTarget(sandbox)).toThrow('must be wfp or container-shim');
	});

	it('rejects incomplete, ambiguous, and unsafe routes', () => {
		expect(() =>
			validateRouteTarget({ kind: 'sandbox', sandboxId: 'sandbox-1', processId: 'preview-1', port: 0, candidate: 'vinext' }),
		).toThrow('port');
		expect(() => validateRouteTarget({ kind: 'wfp', scriptName: 'UPPER', candidate: 'vinext' })).toThrow('scriptName');
		expect(() => validateRouteTarget({ kind: 'wfp', scriptName: 'worker', candidate: 'unknown' })).toThrow('candidate');
		expect(() => validateRouteTarget({ kind: 'container-shim', scriptName: 'shim', candidate: 'container' })).toThrow('unsupported fields');
		expect(() => validateRouteTarget({ kind: 'wfp', scriptName: 'worker', candidate: 'vinext', ownerPrincipalId })).toThrow(
			'unsupported fields',
		);
	});
});

describe('site fencing and authorization helpers', () => {
	it('publishes the lifecycle and exact retained-site cap', () => {
		expect(SITE_STATES).toEqual(['building', 'provisional', 'deploying', 'active', 'deleting', 'uncertain']);
		expect(MAX_SITES_PER_OWNER).toBe(5);
		expect(hasSiteCapacity(4)).toBe(true);
		expect(hasSiteCapacity(5)).toBe(false);
		expect(() => hasSiteCapacity(-1)).toThrow('nonnegative integer');
	});

	it('accepts only positive, bounded generation fences', () => {
		expect(validateSiteMutationFence({ siteId: siteId.toUpperCase(), ownerPrincipalId: ` ${ownerPrincipalId} `, generation: 1 })).toEqual({
			siteId,
			ownerPrincipalId,
			generation: INITIAL_SITE_GENERATION,
		});
		expect(validateGeneration(INITIAL_SITE_GENERATION)).toBe(INITIAL_SITE_GENERATION);
		expect(() => validateGeneration(0)).toThrow('generation');
		expect(() => validateGeneration(1.5)).toThrow('generation');
		expect(() => validateSiteMutationFence({ siteId, ownerPrincipalId, generation: 1, extra: true })).toThrow('unsupported fields');
	});

	it('allows only the first current-generation provisional write', () => {
		expect(canSetProvisional('building', 3, 3)).toBe(true);
		expect(canSetProvisional('building', 4, 3)).toBe(false);
		expect(canSetProvisional('provisional', 3, 3)).toBe(false);
	});

	it('validates an unambiguous dispatch lookup and dispatchable states', () => {
		expect(validateSiteDispatchSelector({ siteId: siteId.toUpperCase() })).toEqual({ siteId });
		expect(validateSiteDispatchSelector({ hostname: initialization.hostname })).toEqual({ hostname: initialization.hostname });
		expect(() => validateSiteDispatchSelector({ siteId, hostname: initialization.hostname })).toThrow('exactly one');
		expect(() => validateSiteDispatchSelector({ slug: initialization.slug })).toThrow('siteId or hostname');

		expect(SITE_STATES.filter(isDispatchableSiteState)).toEqual(['provisional', 'deploying', 'active']);
	});
});

describe('site record privacy', () => {
	it('exposes the required RPC surface without owner-reading runtime methods', () => {
		const methods = Object.getOwnPropertyNames(SiteRegistry.prototype);
		expect(methods).toEqual(
			expect.arrayContaining([
				'initializeSite',
				'list',
				'getAuthorized',
				'setProvisional',
				'beginPromotion',
				'completePromotion',
				'beginDelete',
				'completeDelete',
				'failDelete',
				'authorizeDispatch',
				'inspect',
			]),
		);
		expect(methods).not.toEqual(expect.arrayContaining(['readOwner', 'readAuthorized', 'readAll']));
	});

	it('removes owner identity and unrelated internal fields from public records', () => {
		const publicFields: SiteRecord = {
			siteId,
			runId,
			slug: initialization.slug,
			hostname: initialization.hostname,
			state: 'provisional',
			generation: 1,
			routeTarget: { kind: 'sandbox', sandboxId: 'sandbox-1', processId: 'preview-1', port: 3_000, candidate: 'vinext' },
			createdAt: '2026-09-08T12:00:00.000Z',
			updatedAt: '2026-09-08T12:01:00.000Z',
		};
		const publicRecord = redactSiteOwner({ ...publicFields, ownerPrincipalId, internalToken: 'secret' } as SiteRecord & {
			ownerPrincipalId: string;
		});

		expect(publicRecord).toEqual(publicFields);
		expect(publicRecord).not.toHaveProperty('ownerPrincipalId');
		expect(publicRecord).not.toHaveProperty('internalToken');
		expect(publicRecord.routeTarget).not.toBe(publicFields.routeTarget);
	});
});
