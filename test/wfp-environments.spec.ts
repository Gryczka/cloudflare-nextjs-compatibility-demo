import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	ACCOUNT_API_CALL_BUDGET,
	DISPATCH_REQUESTS_PER_MINUTE,
	ENVIRONMENT_MUTATIONS_PER_MINUTE,
	MAX_ENVIRONMENTS_PER_PRINCIPAL,
} from '../src/environment-registry';
import { resolveAccessPrincipal } from '../src/index';
import {
	customerKeyForPrincipal,
	deleteEnvironment,
	deployEnvironment,
	describeEnvironment,
	dispatchEnvironment,
	USER_WORKER_SOURCE,
	WFP_DISPATCH_NAMESPACE,
	WfpPublisherError,
	type WfpPublisherConfig,
} from '../src/wfp-environments';

const input = {
	slug: 'customer-preview',
	title: 'Customer launch room',
	description: 'Validated in Emdash before customer delivery.',
};

const publisherConfig: WfpPublisherConfig = {
	CLOUDFLARE_ACCOUNT_ID: 'account-id',
	WFP_API_TOKEN: 'test-token',
	WFP_DISPATCH_NAMESPACE,
};

describe('Emdash WfP publisher', () => {
	it('derives stable tenant-owned names without exposing the Access identity', async () => {
		const first = await describeEnvironment('access-user:stable-uuid', input, 'https://platform.example');
		const second = await describeEnvironment('access-user:stable-uuid', input, 'https://platform.example');

		expect(first).toEqual(second);
		expect(first.customerKey).toMatch(/^[a-f0-9]{32}$/);
		expect(first.scriptName).toBe(`emdash-${first.customerKey}-customer-preview`);
		expect(first.path).toBe(`/customer-environments/${first.customerKey}/customer-preview/`);
		expect(first.url).toBe(`https://platform.example${first.path}`);
		expect(JSON.stringify(first)).not.toContain('stable-uuid');
	});

	it('uploads a fixed module and bounded metadata to the hard-allowlisted namespace', async () => {
		let capturedUrl = '';
		let capturedInit: RequestInit | undefined;
		const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return Response.json({ success: true, result: { modified_on: '2026-09-03T12:00:00.000Z' } });
		}) as typeof fetch;

		const deployment = await deployEnvironment(publisherConfig, 'access-user:stable-uuid', input, 'https://platform.example', fakeFetch);
		const form = capturedInit?.body;
		expect(capturedUrl).toBe(
			`https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/${WFP_DISPATCH_NAMESPACE}/scripts/${deployment.scriptName}`,
		);
		expect(capturedInit?.method).toBe('PUT');
		expect(new Headers(capturedInit?.headers).get('authorization')).toBe('Bearer test-token');
		expect(new Headers(capturedInit?.headers).has('content-type')).toBe(false);
		expect(form).toBeInstanceOf(FormData);
		if (!(form instanceof FormData)) throw new Error('Expected multipart body');

		const metadataPart = form.get('metadata');
		const sourcePart = form.get('index.js');
		if (!(metadataPart instanceof File) || !(sourcePart instanceof File)) throw new Error('Expected file parts');
		const metadata = JSON.parse(await metadataPart.text()) as {
			main_module: string;
			compatibility_date: string;
			tags: string[];
			bindings: Array<{ name: string; text: string }>;
		};
		const source = await sourcePart.text();

		expect(metadata.main_module).toBe('index.js');
		expect(metadata.compatibility_date).toBe('2026-09-02');
		expect(metadata.tags).toEqual(['nextjs-compatibility-demo', `customer-${deployment.customerKey}`, 'environment-customer-preview']);
		expect(metadata.bindings.find((binding) => binding.name === 'ENVIRONMENT_TITLE')?.text).toBe(input.title);
		expect(source).toBe(USER_WORKER_SOURCE);
		expect(source).not.toContain(input.title);
		expect(source).toContain("default-src 'none'");
		expect(deployment.deployedAt).toBe('2026-09-03T12:00:00.000Z');
	});

	it('fails closed before making an API call when the namespace changes', async () => {
		let called = false;
		const fakeFetch = (async () => {
			called = true;
			return Response.json({ success: true, result: {} });
		}) as typeof fetch;

		await expect(
			deployEnvironment(
				{ ...publisherConfig, WFP_DISPATCH_NAMESPACE: 'marketing-vibe-dev-patrick' },
				'access-user:stable-uuid',
				input,
				'https://platform.example',
				fakeFetch,
			),
		).rejects.toEqual(expect.objectContaining<WfpPublisherError>({ status: 503 }));
		expect(called).toBe(false);
	});

	it('does not mask a missing dispatch namespace as an absent script', async () => {
		const fakeFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
		await expect(
			deleteEnvironment(publisherConfig, 'access-user:stable-uuid', 'customer-preview', 'https://platform.example', fakeFetch),
		).rejects.toEqual(expect.objectContaining<WfpPublisherError>({ status: 503, outcomeUnknown: true, apiStatus: 404 }));
	});

	it('treats a missing script as deleted only after confirming the namespace exists', async () => {
		const methods: string[] = [];
		const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			methods.push(init?.method ?? 'GET');
			if (init?.method === 'DELETE') {
				return Response.json({ success: false, result: null, errors: [{ code: 10090, message: 'Worker not found' }] }, { status: 404 });
			}
			return Response.json({ success: true, result: { name: WFP_DISPATCH_NAMESPACE } });
		}) as typeof fetch;

		const environment = await deleteEnvironment(
			publisherConfig,
			'access-user:stable-uuid',
			'customer-preview',
			'https://platform.example',
			fakeFetch,
		);

		expect(methods).toEqual(['DELETE', 'GET']);
		expect(environment.slug).toBe('customer-preview');
	});

	it('marks transport failures as having an unknown API outcome', async () => {
		const fakeFetch = (async () => {
			throw new Error('connection reset');
		}) as typeof fetch;
		await expect(
			deployEnvironment(publisherConfig, 'access-user:stable-uuid', input, 'https://platform.example', fakeFetch),
		).rejects.toEqual(expect.objectContaining<WfpPublisherError>({ status: 502, outcomeUnknown: true }));
	});

	it('propagates Cloudflare API retry guidance without marking the upload uncertain', async () => {
		const fakeFetch = (async () =>
			Response.json(
				{ success: false, result: null, errors: [{ code: 10000, message: 'rate limited' }] },
				{ status: 429, headers: { 'Retry-After': '7' } },
			)) as typeof fetch;
		await expect(
			deployEnvironment(publisherConfig, 'access-user:stable-uuid', input, 'https://platform.example', fakeFetch),
		).rejects.toEqual(
			expect.objectContaining<WfpPublisherError>({ status: 429, outcomeUnknown: false, apiStatus: 429, retryAfterSeconds: 7 }),
		);
	});

	it('marks a malformed successful upload result as uncertain', async () => {
		const fakeFetch = (async () => Response.json({ success: true, result: null })) as typeof fetch;
		await expect(
			deployEnvironment(publisherConfig, 'access-user:stable-uuid', input, 'https://platform.example', fakeFetch),
		).rejects.toEqual(expect.objectContaining<WfpPublisherError>({ status: 502, outcomeUnknown: true }));
	});
});

describe('Emdash WfP dispatcher', () => {
	it('rewrites the route, strips control-plane credentials, and applies limits', async () => {
		let selectedName = '';
		let selectedOptions: DynamicDispatchOptions | undefined;
		let forwarded: Request | undefined;
		const namespace = {
			get(name: string, _args?: Record<string, unknown>, options?: DynamicDispatchOptions) {
				selectedName = name;
				selectedOptions = options;
				return {
					async fetch(request: Request) {
						forwarded = request;
						return new Response('dispatched');
					},
				} as Fetcher;
			},
		} satisfies DispatchNamespace;

		const principalId = 'access-user:stable-uuid';
		const customerKey = await customerKeyForPrincipal(principalId);
		const response = await dispatchEnvironment(
			new Request(`https://platform.example/customer-environments/${customerKey}/customer-preview/health?full=1`, {
				headers: {
					Authorization: 'Bearer browser-secret',
					'Proxy-Authorization': 'Basic proxy-secret',
					'Cf-Access-Jwt-Assertion': 'access-jwt',
					'Cf-Access-Token': 'access-token',
					'Cf-Access-Client-Id': 'service-client-id',
					'Cf-Access-Client-Secret': 'service-client-secret',
					Cookie: 'session=secret',
				},
			}),
			namespace,
			principalId,
			customerKey,
			'customer-preview',
			['health'],
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('dispatched');
		expect(selectedName).toBe(`emdash-${customerKey}-customer-preview`);
		expect(selectedOptions).toEqual({ limits: { cpuMs: 50, subRequests: 5 } });
		expect(forwarded?.url).toBe('https://platform.example/health?full=1');
		for (const header of [
			'authorization',
			'proxy-authorization',
			'cf-access-jwt-assertion',
			'cf-access-token',
			'cf-access-client-id',
			'cf-access-client-secret',
			'cookie',
		]) {
			expect(forwarded?.headers.has(header)).toBe(false);
		}
	});

	it('rejects invalid customer routes without touching the namespace', async () => {
		let called = false;
		const namespace = {
			get() {
				called = true;
				throw new Error('should not dispatch');
			},
		} satisfies DispatchNamespace;
		const response = await dispatchEnvironment(
			new Request('https://platform.example/customer-environments/00000000000000000000000000000000/customer-preview/'),
			namespace,
			'access-user:stable-uuid',
			'00000000000000000000000000000000',
			'customer-preview',
			[],
		);

		expect(response.status).toBe(404);
		expect(called).toBe(false);
	});

	it('rejects unsupported methods before dispatching', async () => {
		let called = false;
		const namespace = {
			get() {
				called = true;
				throw new Error('should not dispatch');
			},
		} satisfies DispatchNamespace;
		const principalId = 'access-user:stable-uuid';
		const customerKey = await customerKeyForPrincipal(principalId);
		const response = await dispatchEnvironment(
			new Request(`https://platform.example/customer-environments/${customerKey}/customer-preview/`, { method: 'POST', body: 'ignored' }),
			namespace,
			principalId,
			customerKey,
			'customer-preview',
			[],
		);

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD');
		expect(called).toBe(false);
	});
});

describe('Emdash WfP Access principal', () => {
	it('fails closed for missing or mistyped Access configuration', () => {
		expect(resolveAccessPrincipal(undefined)).toEqual({
			ok: false,
			status: 503,
			error: 'Cloudflare Access configuration is invalid',
		});
		expect(resolveAccessPrincipal('TRUE')).toEqual({
			ok: false,
			status: 503,
			error: 'Cloudflare Access configuration is invalid',
		});
	});

	it('requires a stable user or service-token identifier', () => {
		expect(resolveAccessPrincipal('true', { email: 'developer@example.com' })).toEqual({
			ok: false,
			status: 403,
			error: 'Cloudflare Access did not provide a stable principal',
		});
		expect(resolveAccessPrincipal('true', { email: 'developer@example.com', user_uuid: 'user-uuid' })).toEqual({
			ok: true,
			principal: { id: 'access-user:user-uuid', label: 'developer@example.com' },
		});
		expect(
			resolveAccessPrincipal('true', {
				service_token_status: true,
				service_token_id: 'service-token-id',
				common_name: 'automation.access',
			}),
		).toEqual({
			ok: true,
			principal: { id: 'access-service:service-token-id', label: 'automation.access' },
		});
		expect(resolveAccessPrincipal('true', { service_token_id: 'unverified-service-token' })).toEqual({
			ok: false,
			status: 403,
			error: 'Cloudflare Access provided an ambiguous principal',
		});
		expect(
			resolveAccessPrincipal('true', {
				user_uuid: 'user-uuid',
				service_token_status: true,
				service_token_id: 'service-token-id',
			}),
		).toEqual({ ok: false, status: 403, error: 'Cloudflare Access provided an ambiguous principal' });
	});

	it('allows only the explicit local-development bypass', () => {
		expect(resolveAccessPrincipal('false')).toEqual({
			ok: true,
			principal: { id: 'development:local-user', label: 'local-user' },
		});
	});
});

describe('Emdash WfP environment registry', () => {
	it('caps each principal and lists registered environments', async () => {
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(crypto.randomUUID());
		for (let index = 0; index < MAX_ENVIRONMENTS_PER_PRINCIPAL; index += 1) {
			const environment = { ...input, slug: `preview-${index}` };
			const reservation = await registry.beginDeploy(environment);
			expect(reservation.ok).toBe(true);
			if (!reservation.ok) throw new Error('Expected deployment reservation');
			expect(await registry.completeDeploy(environment.slug, reservation.operationId, '2026-09-03T12:00:00.000Z')).toBe(true);
		}

		expect(await registry.beginDeploy({ ...input, slug: 'over-quota' })).toEqual({ ok: false, reason: 'quota' });
		expect(await registry.list()).toHaveLength(MAX_ENVIRONMENTS_PER_PRINCIPAL);
	});

	it('serializes concurrent updates to the same environment', async () => {
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(crypto.randomUUID());
		const decisions = await Promise.all([registry.beginDeploy(input), registry.beginDeploy(input)]);

		expect(decisions.filter((decision) => decision.ok)).toHaveLength(1);
		expect(decisions.filter((decision) => !decision.ok)).toEqual([{ ok: false, reason: 'busy' }]);
	});

	it('rate-limits repeated mutations without consuming extra quota', async () => {
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(crypto.randomUUID());
		for (let index = 0; index < ENVIRONMENT_MUTATIONS_PER_MINUTE; index += 1) {
			const reservation = await registry.beginDeploy(input);
			expect(reservation.ok).toBe(true);
			if (!reservation.ok) throw new Error('Expected deployment reservation');
			await registry.completeDeploy(input.slug, reservation.operationId, '2026-09-03T12:00:00.000Z');
		}

		const limited = await registry.beginDeploy(input);
		expect(limited).toEqual(expect.objectContaining({ ok: false, reason: 'rate_limited' }));
	});

	it('handles an untracked delete locally and restores tracked state after API failure', async () => {
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(crypto.randomUUID());
		expect(await registry.beginDelete('missing-preview')).toEqual({ ok: true, absent: true });

		const deployment = await registry.beginDeploy(input);
		if (!deployment.ok) throw new Error('Expected deployment reservation');
		await registry.completeDeploy(input.slug, deployment.operationId, '2026-09-03T12:00:00.000Z');
		const deletion = await registry.beginDelete(input.slug);
		if (!deletion.ok || deletion.absent) throw new Error('Expected deletion reservation');
		await registry.failDelete(input.slug, deletion.operationId, false);

		expect(await registry.list()).toEqual([
			expect.objectContaining({ slug: input.slug, status: 'active', deployedAt: '2026-09-03T12:00:00.000Z' }),
		]);
	});

	it('removes uncertain environments from the active dispatch set', async () => {
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(crypto.randomUUID());
		const deployment = await registry.beginDeploy(input);
		if (!deployment.ok) throw new Error('Expected deployment reservation');
		await registry.completeDeploy(input.slug, deployment.operationId, '2026-09-03T12:00:00.000Z');
		expect(await registry.isActive(input.slug)).toBe(true);

		const deletion = await registry.beginDelete(input.slug);
		if (!deletion.ok || deletion.absent) throw new Error('Expected deletion reservation');
		expect(await registry.isActive(input.slug)).toBe(false);
		await registry.failDelete(input.slug, deletion.operationId, true);

		expect(await registry.isActive(input.slug)).toBe(false);
		expect(await registry.authorizeDispatch(input.slug)).toEqual({ ok: false, reason: 'inactive' });
		expect(await registry.list()).toEqual([expect.objectContaining({ slug: input.slug, status: 'uncertain' })]);
	});

	it('rate-limits dispatches for each principal', async () => {
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(crypto.randomUUID());
		const deployment = await registry.beginDeploy(input);
		if (!deployment.ok) throw new Error('Expected deployment reservation');
		await registry.completeDeploy(input.slug, deployment.operationId, '2026-09-03T12:00:00.000Z');

		for (let index = 0; index < DISPATCH_REQUESTS_PER_MINUTE; index += 1) {
			expect(await registry.authorizeDispatch(input.slug)).toEqual({ ok: true });
		}
		expect(await registry.authorizeDispatch(input.slug)).toEqual(
			expect.objectContaining({ ok: false, reason: 'rate_limited', retryAfterSeconds: expect.any(Number) }),
		);
	});

	it('reserves an account-wide budget below the Cloudflare API ceiling', async () => {
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(crypto.randomUUID());
		expect(await registry.reserveApiCalls(ACCOUNT_API_CALL_BUDGET - 1)).toEqual({ ok: true });
		expect(await registry.reserveApiCalls(2)).toEqual(expect.objectContaining({ ok: false, retryAfterSeconds: expect.any(Number) }));
		expect(await registry.reserveApiCalls(1)).toEqual({ ok: true });
		expect(await registry.reserveApiCalls(1)).toEqual(expect.objectContaining({ ok: false, retryAfterSeconds: expect.any(Number) }));
	});
});

describe('Emdash WfP HTTP contract', () => {
	it('renders the live publisher form', async () => {
		const response = await SELF.fetch('https://example.com/');
		const html = await response.text();

		expect(html).toContain('id="customerEnvironments"');
		expect(html).toContain('id="environmentForm"');
		expect(html).toContain('Emdash builds. WfP ships.');
	});

	it('validates environment writes before invoking the publisher', async () => {
		const invalid = await SELF.fetch('https://example.com/api/wfp/environments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: 'INVALID', title: 'Customer', description: 'Preview' }),
		});
		const crossOrigin = await SELF.fetch('https://example.com/api/wfp/environments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
			body: JSON.stringify(input),
		});

		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({
			error: 'slug, title, and description must match the documented customer environment contract',
		});
		expect(crossOrigin.status).toBe(403);
		expect(await crossOrigin.json()).toEqual({ error: 'Cross-origin customer environment updates are not allowed' });
	});

	it('lists no environments for the authenticated principal', async () => {
		const listed = await SELF.fetch('https://example.com/api/wfp/environments');

		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ environments: [] });
	});

	it('denies dispatch when the principal registry has no active environment', async () => {
		const customerKey = await customerKeyForPrincipal('development:local-user');
		const response = await SELF.fetch(`https://example.com/customer-environments/${customerKey}/untracked-preview/`);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Customer environment not found');
	});
});
