/** HTTP control plane for three fixed Next.js fixtures and a separate, fixed-template
 * Workers for Platforms example. Access and public-demo identities never mix.
 */
import { ContainerProxy, Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import { z } from 'zod';
import appScript from '../public/app.client';
import indexHtml from '../public/index.html';
import styles from '../public/styles.css';
import { CapacityDurableObject } from './build-capacity';
import { buildRunComparison } from './comparison';
import { createInitialRun, publicRunSnapshot, type RunEventInput } from './domain';
import { EnvironmentRegistry, type RegistryRejection } from './environment-registry';
import { fixtures, getFixture } from './fixtures';
import { authenticateDemo, coordinator, DEMO_LIMITS, isPublicDemo, PublicDemoCoordinator, rejected } from './public-demo';
import { RunDurableObject } from './run-durable-object';
import { destroyRunSandbox, isPreviewProcessRunning, proxyPreview } from './sandbox-runner';
import { SiteRegistry } from './site-registry';
import { UploadRunDurableObject } from './upload-run-durable-object';
import {
	customerKeyForPrincipal,
	deleteEnvironment,
	deployEnvironment,
	dispatchEnvironment,
	environmentInputSchema,
	scriptNameFor,
	WfpPublisherError,
} from './wfp-environments';
import { CompatibilityWorkflow } from './workflow';

/** Sandboxed fixture builder. Npm and container registries are allowlisted;
 * arbitrary visitor source is never passed to its command runner.
 */
export class Sandbox extends CloudflareSandbox<Env> {
	enableInternet = false;
	interceptHttps = true;
	allowedHosts = ['registry.npmjs.org', '*.docker.io', '*.docker.com', 'mirror.gcr.io'];
}

Sandbox.outbound = (request) => {
	const url = new URL(request.url);
	if (url.protocol !== 'https:' || (request.method !== 'GET' && request.method !== 'HEAD')) {
		return new Response('Sandbox egress denied', { status: 403 });
	}
	return fetch(request);
};

export {
	CapacityDurableObject,
	CompatibilityWorkflow,
	ContainerProxy,
	EnvironmentRegistry,
	RunDurableObject,
	PublicDemoCoordinator,
	SiteRegistry,
	UploadRunDurableObject,
};

const createRunSchema = z.object({ fixtureId: z.enum(['vinext', 'opennext', 'container']) });
const runIdSchema = z.uuid();

/** Authenticate before routing every stateful request; public-demo bootstrap is
 * limited to the app shell and explicit session endpoint.
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const requestId = crypto.randomUUID();
		try {
			const pathname = new URL(request.url).pathname;
			if (isPublicDemo(env) && request.method === 'GET') {
				if (pathname === '/health') return json({ ok: true });
				if (pathname === '/styles.css') return text(styles, 'text/css; charset=utf-8');
				if (pathname === '/app.js') return text(appScript, 'text/javascript; charset=utf-8');
			}
			const demo = isPublicDemo(env) ? await authenticateDemo(request, env) : null;
			if (demo instanceof Response) return demo;
			const auth = demo?.principal ?? (await authenticate(env, ctx));
			if (auth instanceof Response) return auth;
			const response = await routeRequest(request, env, auth);
			if (demo?.setCookie) response.headers.append('Set-Cookie', demo.setCookie);
			return response;
		} catch (error) {
			if (error instanceof WfpPublisherError) {
				return json(
					{ error: error.message },
					{
						status: error.status,
						headers: error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : undefined,
					},
				);
			}
			if (error instanceof HttpError) {
				return json({ error: error.message }, { status: error.status });
			}
			console.error(
				JSON.stringify({
					event: 'request.failed',
					requestId,
					method: request.method,
					path: new URL(request.url).pathname,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			return json({ error: 'Request failed', requestId }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function routeRequest(request: Request, env: Env, auth: AuthenticatedPrincipal): Promise<Response> {
	const url = new URL(request.url);
	const segments = url.pathname.split('/').filter(Boolean);
	if (request.method === 'GET' && url.pathname === '/') {
		return text(indexHtml, 'text/html; charset=utf-8', securityHeaders());
	}
	if (request.method === 'GET' && url.pathname === '/styles.css') {
		return text(styles, 'text/css; charset=utf-8');
	}
	if (request.method === 'GET' && url.pathname === '/app.js') {
		return text(appScript, 'text/javascript; charset=utf-8');
	}
	if (request.method === 'GET' && url.pathname === '/health') {
		return json({ ok: true });
	}
	if (request.method === 'GET' && url.pathname === '/api/session' && isPublicDemo(env)) {
		return json({
			mode: 'public-demo',
			visitor: 'anonymous',
			limits: DEMO_LIMITS,
			mutationsEnabled: demoMutationsEnabled(env),
			publishingAvailable: demoMutationsEnabled(env) && Boolean(env.WFP_API_TOKEN),
		});
	}
	if (request.method === 'GET' && url.pathname === '/api/fixtures') {
		return json({ fixtures, comparison: buildRunComparison(null) });
	}
	if (request.method === 'POST' && url.pathname === '/api/runs') {
		if (isPublicDemo(env) && !demoMutationsEnabled(env)) return json({ error: 'New demo operations are paused' }, { status: 503 });
		return createRun(request, env, auth);
	}
	if (request.method === 'GET' && url.pathname === '/api/wfp/environments') {
		return listCustomerEnvironments(request, env, auth.id);
	}
	if (request.method === 'POST' && url.pathname === '/api/wfp/environments') {
		if (isPublicDemo(env) && !demoMutationsEnabled(env)) return json({ error: 'New demo operations are paused' }, { status: 503 });
		return createCustomerEnvironment(request, env, auth);
	}
	if (request.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'wfp' && segments[2] === 'environments' && segments[3]) {
		return removeCustomerEnvironment(request, env, auth.id, segments[3]);
	}
	if (segments[0] === 'customer-environments' && segments[1] && segments[2]) {
		return dispatchRegisteredEnvironment(request, env, auth.id, segments[1], segments[2], segments.slice(3));
	}

	if (segments[0] === 'api' && segments[1] === 'runs' && segments[2]) {
		const runId = segments[2];
		if (!runIdSchema.safeParse(runId).success) {
			return json({ error: 'Invalid run ID' }, { status: 400 });
		}
		return handleRunRequest(request, env, auth, runId, segments.slice(3));
	}

	return json({ error: 'Not found' }, { status: 404 });
}

function demoMutationsEnabled(env: Env): boolean {
	const enabled: unknown = env.DEMO_MUTATIONS_ENABLED;
	return enabled === 'true';
}

async function dispatchRegisteredEnvironment(
	request: Request,
	env: Env,
	principalId: string,
	routeCustomerKey: string,
	slug: string,
	rest: string[],
): Promise<Response> {
	const customerKey = await customerKeyForPrincipal(principalId);
	if (routeCustomerKey !== customerKey || !environmentInputSchema.shape.slug.safeParse(slug).success) {
		return new Response('Customer environment not found', { status: 404 });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
	}
	if (isPublicDemo(env) && !(await coordinator(env).canDispatch(principalId, slug))) {
		return new Response('Customer environment not found', { status: 404 });
	}
	const authorization = await env.ENVIRONMENT_REGISTRIES.getByName(customerKey).authorizeDispatch(slug);
	if (!authorization.ok && authorization.reason === 'rate_limited') {
		return new Response('Customer environment request rate exceeded', {
			status: 429,
			headers: { 'Retry-After': String(authorization.retryAfterSeconds ?? 1) },
		});
	}
	if (!authorization.ok) {
		return new Response('Customer environment not found', { status: 404 });
	}
	return dispatchEnvironment(request, env.EMDASH_ENVIRONMENTS, principalId, routeCustomerKey, slug, rest);
}

async function listCustomerEnvironments(request: Request, env: Env, principalId: string): Promise<Response> {
	const customerKey = await customerKeyForPrincipal(principalId);
	const records = await env.ENVIRONMENT_REGISTRIES.getByName(customerKey).list();
	const demoEnvironments = isPublicDemo(env) ? await coordinator(env).listEnvironments(principalId) : null;
	const origin = new URL(request.url).origin;
	return json({
		environments: records.map((record) => {
			const path = `/customer-environments/${customerKey}/${record.slug}/`;
			return {
				...record,
				...(demoEnvironments
					? {
							status: demoEnvironments[record.slug]?.active ? record.status : 'deleting',
							expiresAt: demoEnvironments[record.slug]?.expiresAt ?? null,
						}
					: {}),
				customerKey,
				scriptName: scriptNameFor(customerKey, record.slug),
				path,
				url: new URL(path, origin).href,
			};
		}),
	});
}

async function createCustomerEnvironment(request: Request, env: Env, auth: AuthenticatedPrincipal): Promise<Response> {
	const validationError = validateJsonMutation(request, env, 'customer environment updates');
	if (validationError) return validationError;
	const principalId = auth.id;
	const parsed = environmentInputSchema.safeParse(await readJson(request, 2_048));
	if (!parsed.success) {
		return json({ error: 'slug, title, and description must match the documented customer environment contract' }, { status: 400 });
	}

	const customerKey = await customerKeyForPrincipal(principalId);
	const registry = env.ENVIRONMENT_REGISTRIES.getByName(customerKey);
	const demo = isPublicDemo(env);
	if (demo) {
		const decision = await coordinator(env).reserveEnvironment(principalId, parsed.data.slug, auth.ipHash ?? '');
		if (!decision.ok) return rejected(decision);
	}
	const reservation = await registry.beginDeploy(parsed.data);
	if (!reservation.ok) {
		if (demo) await coordinator(env).failEnvironment(principalId, parsed.data.slug, false);
		return registryRejection(reservation);
	}
	let budgetRejection: Response | null;
	try {
		budgetRejection = await reserveWfpApiBudget(env, 1);
	} catch (error) {
		await registry.failDeploy(parsed.data.slug, reservation.operationId, false);
		if (demo) await coordinator(env).failEnvironment(principalId, parsed.data.slug, false);
		throw error;
	}
	if (budgetRejection) {
		await registry.failDeploy(parsed.data.slug, reservation.operationId, false);
		if (demo) await coordinator(env).failEnvironment(principalId, parsed.data.slug, false);
		return budgetRejection;
	}

	let environment;
	try {
		environment = await deployEnvironment(env, principalId, parsed.data, new URL(request.url).origin);
	} catch (error) {
		try {
			await registry.failDeploy(parsed.data.slug, reservation.operationId, error instanceof WfpPublisherError && error.outcomeUnknown);
		} catch (registryError) {
			console.error(
				JSON.stringify({
					event: 'wfp.registry.deploy_cleanup_failed',
					slug: parsed.data.slug,
					error: registryError instanceof Error ? registryError.message : String(registryError),
				}),
			);
		}
		if (demo)
			await coordinator(env).failEnvironment(principalId, parsed.data.slug, error instanceof WfpPublisherError && error.outcomeUnknown);
		throw error;
	}
	let confirmed = false;
	try {
		confirmed = await registry.completeDeploy(parsed.data.slug, reservation.operationId, environment.deployedAt);
	} catch (error) {
		console.error(
			JSON.stringify({
				event: 'wfp.registry.deploy_confirmation_failed',
				slug: parsed.data.slug,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
	if (!confirmed) {
		if (demo) await coordinator(env).failEnvironment(principalId, parsed.data.slug, true);
		throw new WfpPublisherError('Customer environment uploaded but its registry could not be confirmed', 503, true, undefined, 120);
	}
	const expiresAt = demo ? new Date(await coordinator(env).confirmEnvironment(principalId, parsed.data.slug)).toISOString() : undefined;
	return json(
		{ environment: { ...environment, ...(expiresAt ? { expiresAt } : {}) } },
		{
			status: 201,
			headers: { Location: environment.path },
		},
	);
}

async function removeCustomerEnvironment(request: Request, env: Env, principalId: string, slug: string): Promise<Response> {
	const validationError = validateSameOriginMutation(request, env, 'customer environment updates');
	if (validationError) return validationError;
	const parsedSlug = environmentInputSchema.shape.slug.safeParse(slug);
	if (!parsedSlug.success) return json({ error: 'Invalid customer environment slug' }, { status: 400 });

	const customerKey = await customerKeyForPrincipal(principalId);
	const registry = env.ENVIRONMENT_REGISTRIES.getByName(customerKey);
	const demo = isPublicDemo(env);
	if (demo) {
		const decision = await coordinator(env).beginEnvironmentDelete(principalId, parsedSlug.data);
		if (!decision.ok) return rejected(decision);
	}
	const reservation = await registry.beginDelete(parsedSlug.data);
	if (!reservation.ok) {
		if (demo) await coordinator(env).failEnvironmentDelete(principalId, parsedSlug.data, false);
		return registryRejection(reservation);
	}
	let budgetRejection: Response | null;
	try {
		// Reserve the DELETE plus the namespace check required when the script is already absent.
		budgetRejection = await reserveWfpApiBudget(env, 2);
	} catch (error) {
		if (!('absent' in reservation)) await registry.failDelete(parsedSlug.data, reservation.operationId, false);
		if (demo) await coordinator(env).failEnvironmentDelete(principalId, parsedSlug.data, false);
		throw error;
	}
	if (budgetRejection) {
		if (!('absent' in reservation)) await registry.failDelete(parsedSlug.data, reservation.operationId, false);
		if (demo) await coordinator(env).failEnvironmentDelete(principalId, parsedSlug.data, false);
		return budgetRejection;
	}

	let environment;
	try {
		environment = await deleteEnvironment(env, principalId, parsedSlug.data, new URL(request.url).origin);
	} catch (error) {
		if (!('absent' in reservation)) {
			try {
				await registry.failDelete(parsedSlug.data, reservation.operationId, error instanceof WfpPublisherError && error.outcomeUnknown);
			} catch (registryError) {
				console.error(
					JSON.stringify({
						event: 'wfp.registry.delete_cleanup_failed',
						slug: parsedSlug.data,
						error: registryError instanceof Error ? registryError.message : String(registryError),
					}),
				);
			}
		}
		if (demo)
			await coordinator(env).failEnvironmentDelete(
				principalId,
				parsedSlug.data,
				error instanceof WfpPublisherError && error.outcomeUnknown,
			);
		throw error;
	}
	if ('absent' in reservation) {
		if (demo) await coordinator(env).releaseEnvironment(principalId, parsedSlug.data);
		return json({ deleted: true, environment });
	}
	let confirmed = false;
	try {
		confirmed = await registry.completeDelete(parsedSlug.data, reservation.operationId);
	} catch (error) {
		console.error(
			JSON.stringify({
				event: 'wfp.registry.delete_confirmation_failed',
				slug: parsedSlug.data,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
	if (!confirmed) {
		if (demo) await coordinator(env).failEnvironmentDelete(principalId, parsedSlug.data, true);
		throw new WfpPublisherError('Customer environment deleted but its registry could not be confirmed', 503, true, undefined, 120);
	}
	if (demo) await coordinator(env).releaseEnvironment(principalId, parsedSlug.data);
	return json({ deleted: true, environment });
}

async function reserveWfpApiBudget(env: Env, calls: number): Promise<Response | null> {
	const decision = await env.ENVIRONMENT_REGISTRIES.getByName('wfp-account-api-budget').reserveApiCalls(calls, isPublicDemo(env));
	return decision.ok
		? null
		: json(
				{ error: 'Customer environment API budget exhausted; retry shortly' },
				{ status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
			);
}

function registryRejection(decision: RegistryRejection): Response {
	if (decision.reason === 'rate_limited') {
		return json(
			{ error: 'Customer environment mutation rate exceeded; retry shortly' },
			{ status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds ?? 1) } },
		);
	}
	if (decision.reason === 'quota') {
		return json({ error: 'Customer environment quota reached; delete an environment before creating another' }, { status: 409 });
	}
	return json({ error: 'A customer environment update is already in progress' }, { status: 409 });
}

async function createRun(request: Request, env: Env, auth: AuthenticatedPrincipal): Promise<Response> {
	const validationError = validateJsonMutation(request, env);
	if (validationError) return validationError;

	const body = await readJson(request, 4_096);
	const parsed = createRunSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: 'fixtureId must be vinext, opennext, or container' }, { status: 400 });
	}

	const fixture = getFixture(parsed.data.fixtureId);
	if (!fixture) return json({ error: 'Unknown fixture' }, { status: 404 });

	const runId = crypto.randomUUID();
	if (isPublicDemo(env)) {
		const decision = await coordinator(env).reserveRun(runId, auth.id, auth.ipHash ?? '', fixture.id);
		if (!decision.ok) return rejected(decision);
	}
	const now = new Date().toISOString();
	const stub = env.RUNS.getByName(runId);
	let snapshot;
	try {
		snapshot = await stub.initialize(createInitialRun(runId, fixture.id, auth.id, auth.label, now));
	} catch (error) {
		if (isPublicDemo(env)) await coordinator(env).requestRunCleanup(runId);
		throw error;
	}

	const workflowOptions = {
		id: runId,
		params: { runId, fixtureId: fixture.id },
		retention: { successRetention: '7 days', errorRetention: '7 days' },
	} as const;
	try {
		await env.COMPATIBILITY_WORKFLOW.createBatch([workflowOptions]);
	} catch (firstError) {
		try {
			// createBatch is idempotent, so a lost response can be retried safely.
			await env.COMPATIBILITY_WORKFLOW.createBatch([workflowOptions]);
		} catch {
			try {
				await env.COMPATIBILITY_WORKFLOW.get(runId);
			} catch {
				const timestamp = new Date().toISOString();
				await stub.record(
					{
						key: 'run:start-failed',
						timestamp,
						type: 'run.failed',
						level: 'error',
						stage: null,
						message: 'Workflow could not be started',
					},
					{ status: 'failed' },
				);
				if (isPublicDemo(env)) await coordinator(env).requestRunCleanup(runId);
				throw firstError;
			}
		}
	}

	return json(
		{ run: publicRunSnapshot(snapshot), comparison: buildRunComparison(snapshot) },
		{
			status: 202,
			headers: { Location: `/api/runs/${runId}` },
		},
	);
}

function validateJsonMutation(request: Request, env: Env, action = 'run creation'): Response | null {
	if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
		return json({ error: 'Content-Type must be application/json' }, { status: 415 });
	}
	return validateSameOriginMutation(request, env, action);
}

function validateSameOriginMutation(request: Request, env: Env, action = 'run creation'): Response | null {
	const verb = action.endsWith('s') ? 'are' : 'is';
	const origin = request.headers.get('Origin');
	if (isPublicDemo(env) && !origin) return json({ error: `Origin is required for ${action}` }, { status: 403 });
	if (origin && origin !== new URL(request.url).origin) {
		return json({ error: `Cross-origin ${action} ${verb} not allowed` }, { status: 403 });
	}
	const fetchSite = request.headers.get('Sec-Fetch-Site')?.toLowerCase();
	if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		return json({ error: `Cross-site ${action} ${verb} not allowed` }, { status: 403 });
	}
	return null;
}

async function handleRunRequest(
	request: Request,
	env: Env,
	auth: AuthenticatedPrincipal,
	runId: string,
	rest: string[],
): Promise<Response> {
	const stub = env.RUNS.getByName(runId);
	const snapshot = await stub.getSnapshot();
	if (!snapshot || snapshot.ownerPrincipalId !== auth.id) return json({ error: 'Run not found' }, { status: 404 });

	if (request.method === 'GET' && rest.length === 0) {
		return json({ run: publicRunSnapshot(snapshot), comparison: buildRunComparison(snapshot) });
	}
	if (request.method === 'GET' && rest[0] === 'events') {
		const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
		return json(await stub.getEvents(Number.isFinite(after) ? after : 0));
	}
	if (request.method === 'GET' && rest[0] === 'ws') {
		if (isPublicDemo(env) && request.headers.get('Origin') !== new URL(request.url).origin) {
			return json({ error: 'Same-origin WebSocket required' }, { status: 403 });
		}
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
		}
		const headers = new Headers(request.headers);
		headers.set('X-Compatibility-Run-Owner', auth.id);
		return stub.fetch(new Request(request, { headers }));
	}
	if ((request.method === 'GET' || request.method === 'HEAD') && rest[0] === 'preview') {
		if (isPublicDemo(env) && !(await coordinator(env).canRun(runId))) return json({ error: 'Preview has expired' }, { status: 410 });
		if (snapshot.status !== 'succeeded' || snapshot.previewPort === null || snapshot.previewProcessId === null) {
			return json({ error: 'Preview is not ready' }, { status: 409 });
		}
		if (!(await isPreviewProcessRunning(env, runId, snapshot.previewProcessId))) {
			await markPreviewUnavailable(stub, env, runId);
			return json({ error: 'Preview is no longer available' }, { status: 410 });
		}
		const previewPath = `/${rest.slice(1).join('/')}`;
		try {
			return await proxyPreview(env, runId, request, previewPath === '/' ? '/' : previewPath, snapshot.previewPort);
		} catch (error) {
			if (!(await isPreviewProcessRunning(env, runId, snapshot.previewProcessId))) {
				await markPreviewUnavailable(stub, env, runId);
				return json({ error: 'Preview is no longer available' }, { status: 410 });
			}
			throw error;
		}
	}
	if (request.method === 'DELETE' && rest.length === 0) {
		const validationError = validateSameOriginMutation(request, env, 'run cancellation');
		if (validationError) return validationError;
		if (['succeeded', 'failed', 'cancelled'].includes(snapshot.status) && snapshot.sandboxDestroyedAt && !snapshot.previewPath) {
			if (isPublicDemo(env) && !(await coordinator(env).releaseRun(runId))) {
				return json({ error: 'Run cleanup is still in progress' }, { status: 503 });
			}
			return json({ run: publicRunSnapshot(snapshot), comparison: buildRunComparison(snapshot) });
		}
		await stub.cancel(new Date().toISOString());
		try {
			const workflowInstance = await env.COMPATIBILITY_WORKFLOW.get(runId);
			let workflowStatus = await workflowInstance.status();
			if (!['errored', 'terminated', 'complete'].includes(workflowStatus.status)) {
				try {
					await workflowInstance.terminate();
				} catch (error) {
					workflowStatus = await workflowInstance.status();
					if (!['errored', 'terminated', 'complete'].includes(workflowStatus.status)) throw error;
				}
			}
		} catch (error) {
			if (!isPublicDemo(env)) throw error;
			// An uncertain workflow start remains reserved for alarm-driven teardown.
			await coordinator(env).requestRunCleanup(runId);
			throw error;
		}
		try {
			await destroyRunSandbox(env, runId);
			const cleanedUp = await stub.markSandboxDestroyed(new Date().toISOString(), 'cancellation');
			if (isPublicDemo(env) && !(await coordinator(env).releaseRun(runId))) {
				return json({ error: 'Run cleanup is still in progress' }, { status: 503 });
			}
			return json({ run: publicRunSnapshot(cleanedUp), comparison: buildRunComparison(cleanedUp) });
		} catch (error) {
			if (isPublicDemo(env)) await coordinator(env).requestRunCleanup(runId);
			throw error;
		}
	}

	return json({ error: 'Method not allowed' }, { status: 405 });
}

async function markPreviewUnavailable(stub: DurableObjectStub<RunDurableObject>, env: Env, runId: string) {
	if (isPublicDemo(env)) await coordinator(env).requestRunCleanup(runId);
	const timestamp = new Date().toISOString();
	await stub.record(
		{
			key: 'preview:unavailable',
			timestamp,
			type: 'preview.expired',
			level: 'warning',
			stage: 'publish',
			message: 'Live preview became unavailable',
		},
		{
			previewPath: null,
			previewProcessId: null,
			previewPort: null,
			stage: { name: 'publish', summary: 'Live preview is no longer available' },
		},
	);
}

/** Identity resolved from Cloudflare Access or the server-side demo session;
 * never construct this from a client-provided owner header.
 */
export interface AuthenticatedPrincipal {
	id: string;
	label: string;
	ipHash?: string;
}

type PrincipalResolution = { ok: true; principal: AuthenticatedPrincipal } | { ok: false; status: number; error: string };

/** Translate Access identity to a stable tenant key (no email fallback).
 * @param requireAccess - Explicit mode flag; false permits local development only.
 * @param identity - Verified identity supplied by Cloudflare Access.
 * @returns Principal or denial when identity/configuration is ambiguous.
 */
export function resolveAccessPrincipal(requireAccess: unknown, identity?: CloudflareAccessIdentity): PrincipalResolution {
	if (requireAccess === 'false') return { ok: true, principal: { id: 'development:local-user', label: 'local-user' } };
	if (requireAccess !== 'true') return { ok: false, status: 503, error: 'Cloudflare Access configuration is invalid' };
	if (!identity) return { ok: false, status: 403, error: 'Cloudflare Access is required' };

	const userUuid = identityField(identity, 'user_uuid');
	const serviceTokenId = identityField(identity, 'service_token_id');
	const isServiceToken = identity.service_token_status === true;
	if (isServiceToken) {
		if (userUuid) return { ok: false, status: 403, error: 'Cloudflare Access provided an ambiguous principal' };
		const stableServiceTokenId = serviceTokenId ?? identityField(identity, 'common_name');
		if (!stableServiceTokenId) return { ok: false, status: 403, error: 'Cloudflare Access did not provide a stable principal' };
		return {
			ok: true,
			principal: {
				id: `access-service:${stableServiceTokenId}`,
				label: identityField(identity, 'common_name') ?? 'Access service token',
			},
		};
	}
	if (serviceTokenId) return { ok: false, status: 403, error: 'Cloudflare Access provided an ambiguous principal' };
	if (userUuid) {
		return {
			ok: true,
			principal: { id: `access-user:${userUuid}`, label: identity.email?.trim() || identity.name?.trim() || 'Access user' },
		};
	}

	return { ok: false, status: 403, error: 'Cloudflare Access did not provide a stable principal' };
}

async function authenticate(env: Env, ctx: ExecutionContext): Promise<AuthenticatedPrincipal | Response> {
	const requireAccess: unknown = env.REQUIRE_ACCESS;
	let identity: CloudflareAccessIdentity | undefined;
	if (requireAccess === 'true' && ctx.access) identity = await ctx.access.getIdentity();
	const resolution = resolveAccessPrincipal(requireAccess, identity);
	return resolution.ok ? resolution.principal : json({ error: resolution.error }, { status: resolution.status });
}

function identityField(identity: CloudflareAccessIdentity, name: string): string | null {
	const value = identity[name];
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readJson(request: Request, limit: number): Promise<unknown> {
	const contentLength = Number(request.headers.get('Content-Length') ?? 0);
	if (contentLength > limit) throw new HttpError('Request body is too large', 413);
	if (!request.body) return null;

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > limit) {
			await reader.cancel('Request body is too large');
			throw new HttpError('Request body is too large', 413);
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new HttpError('Request body must be valid JSON', 400);
	}
}

class HttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

function json(data: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers);
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');
	return Response.json(data, { ...init, headers });
}

function text(body: string, contentType: string, extraHeaders?: HeadersInit) {
	const headers = new Headers(extraHeaders);
	headers.set('Content-Type', contentType);
	headers.set('Cache-Control', 'no-store');
	return new Response(body, { headers });
}

function securityHeaders(): HeadersInit {
	return {
		'Content-Security-Policy':
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
	};
}
