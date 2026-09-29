/** Bounded, fixed-template Workers for Platforms publisher and dispatcher. */
import { z } from 'zod';

export const WFP_DISPATCH_NAMESPACE = 'nextjs-compatibility-environments';
export const environmentInputSchema = z.object({
	slug: z
		.string()
		.min(2)
		.max(32)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must contain lowercase letters, numbers, and single hyphens'),
	title: z.string().trim().min(2).max(80),
	description: z.string().trim().min(2).max(240),
});

export type EnvironmentInput = z.infer<typeof environmentInputSchema>;

export interface CustomerEnvironment {
	slug: string;
	title: string;
	description: string;
	customerKey: string;
	scriptName: string;
	path: string;
	url: string;
}

export interface EnvironmentDeployment extends CustomerEnvironment {
	deployedAt: string;
	durationMs: number;
}

export interface WfpPublisherConfig {
	CLOUDFLARE_ACCOUNT_ID: string;
	WFP_API_TOKEN: string;
	WFP_DISPATCH_NAMESPACE: string;
}

type Fetcher = typeof fetch;

const USER_WORKER_COMPATIBILITY_DATE = '2026-09-02';
const SCRIPT_PREFIX = 'emdash';
const CUSTOMER_KEY_PATTERN = /^[a-f0-9]{32}$/;
const API_TIMEOUT_MS = 20_000;
const DISPATCH_LIMITS = { cpuMs: 50, subRequests: 5 } as const;

export class WfpPublisherError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly outcomeUnknown = false,
		readonly apiStatus?: number,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = 'WfpPublisherError';
	}
}

export async function describeEnvironment(principalId: string, input: EnvironmentInput, origin: string): Promise<CustomerEnvironment> {
	const customerKey = await customerKeyForPrincipal(principalId);
	const scriptName = scriptNameFor(customerKey, input.slug);
	const path = `/customer-environments/${customerKey}/${input.slug}/`;

	return {
		...input,
		customerKey,
		scriptName,
		path,
		url: new URL(path, origin).href,
	};
}

/** Upload only the platform-owned module and bounded, escaped metadata.
 * @param env - Account/namespace configuration and server-side token.
 * @param principalId - Authenticated Access user or demo session ID.
 * @param input - Validated metadata; never executable Worker source.
 * @param origin - Public control-plane origin for the returned route.
 * @param fetcher - Optional HTTP client for tests.
 * @returns Confirmed script path, timestamp, and upload duration.
 * @throws WfpPublisherError when API outcome is failed or uncertain.
 */
export async function deployEnvironment(
	env: WfpPublisherConfig,
	principalId: string,
	input: EnvironmentInput,
	origin: string,
	fetcher: Fetcher = fetch,
): Promise<EnvironmentDeployment> {
	assertPublisherConfiguration(env);
	const environment = await describeEnvironment(principalId, input, origin);
	const startedAt = Date.now();
	const deployedAt = new Date().toISOString();
	const form = new FormData();
	const metadata = {
		main_module: 'index.js',
		compatibility_date: USER_WORKER_COMPATIBILITY_DATE,
		tags: ['nextjs-compatibility-demo', `customer-${environment.customerKey}`, `environment-${environment.slug}`],
		bindings: [
			plainTextBinding('ENVIRONMENT_SLUG', environment.slug),
			plainTextBinding('ENVIRONMENT_TITLE', environment.title),
			plainTextBinding('ENVIRONMENT_DESCRIPTION', environment.description),
			plainTextBinding('CUSTOMER_KEY', environment.customerKey),
			plainTextBinding('PUBLISHED_AT', deployedAt),
		],
	};
	form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
	form.append('index.js', new Blob([USER_WORKER_SOURCE], { type: 'application/javascript+module' }), 'index.js');

	const result = await callWorkersApi<{ modified_on?: string }>(
		env,
		fetcher,
		'PUT',
		`/workers/dispatch/namespaces/${encodeURIComponent(env.WFP_DISPATCH_NAMESPACE)}/scripts/${encodeURIComponent(environment.scriptName)}`,
		form,
	);
	if (!result || typeof result !== 'object') {
		throw new WfpPublisherError('Cloudflare returned an invalid customer environment result', 502, true);
	}

	return {
		...environment,
		deployedAt: typeof result.modified_on === 'string' ? result.modified_on : deployedAt,
		durationMs: Date.now() - startedAt,
	};
}

/** Delete a tenant-owned script; a 404 counts only after verifying the namespace.
 * @param env - Account/namespace configuration and server-side token.
 * @param principalId - Authenticated tenant identity.
 * @param slug - Script slug within the tenant's derived prefix.
 * @param origin - Control-plane origin for the returned route.
 * @param fetcher - Optional HTTP client for tests.
 * @returns Descriptor of the removed environment.
 * @throws WfpPublisherError on an uncertain or rejected delete.
 */
export async function deleteEnvironment(
	env: WfpPublisherConfig,
	principalId: string,
	slug: string,
	origin: string,
	fetcher: Fetcher = fetch,
): Promise<CustomerEnvironment> {
	assertPublisherConfiguration(env);
	const parsedSlug = environmentInputSchema.shape.slug.safeParse(slug);
	if (!parsedSlug.success) throw new WfpPublisherError('Invalid customer environment slug', 400);
	const input: EnvironmentInput = {
		slug: parsedSlug.data,
		title: 'Deleted environment',
		description: 'Deleted environment',
	};
	const environment = await describeEnvironment(principalId, input, origin);

	try {
		await callWorkersApi(
			env,
			fetcher,
			'DELETE',
			`/workers/dispatch/namespaces/${encodeURIComponent(env.WFP_DISPATCH_NAMESPACE)}/scripts/${encodeURIComponent(environment.scriptName)}`,
			undefined,
		);
	} catch (error) {
		if (!(error instanceof WfpPublisherError) || error.apiStatus !== 404) throw error;
		// A script and its namespace both return 404; only converge when the namespace still exists.
		try {
			await callWorkersApi(env, fetcher, 'GET', `/workers/dispatch/namespaces/${encodeURIComponent(env.WFP_DISPATCH_NAMESPACE)}`);
		} catch (namespaceError) {
			if (namespaceError instanceof WfpPublisherError && namespaceError.apiStatus === 404) {
				throw new WfpPublisherError('WfP dispatch namespace is not configured', 503, true, 404);
			}
			throw namespaceError;
		}
	}

	return environment;
}

/** Forward only GET/HEAD to the authorized User Worker, without visitor headers.
 * @param request - Request to the public dispatcher.
 * @param namespace - Dedicated dispatch binding.
 * @param principalId - Authenticated visitor identity.
 * @param routeCustomerKey - Tenant key from the requested URL.
 * @param slug - Bounded environment slug.
 * @param rest - Remaining path segments to forward.
 * @returns Isolated Worker response, or a safe 404/405/502.
 */
export async function dispatchEnvironment(
	request: Request,
	namespace: DispatchNamespace,
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

	const scriptName = scriptNameFor(customerKey, slug);
	const target = new URL(request.url);
	target.pathname = `/${rest.join('/')}`;
	const forwarded = new Request(target, {
		method: request.method,
		headers: new Headers(),
		redirect: 'manual',
	});

	try {
		const worker = namespace.get(scriptName, {}, { limits: DISPATCH_LIMITS });
		return await worker.fetch(forwarded);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not found|worker not found/i.test(message)) return new Response('Customer environment not found', { status: 404 });
		console.error(JSON.stringify({ event: 'wfp.dispatch.failed', scriptName, error: message }));
		return new Response('Customer environment failed to start', { status: 502 });
	}
}

export function scriptNameFor(customerKey: string, slug: string): string {
	if (!CUSTOMER_KEY_PATTERN.test(customerKey) || !environmentInputSchema.shape.slug.safeParse(slug).success) {
		throw new WfpPublisherError('Invalid customer environment identifier', 400);
	}
	return `${SCRIPT_PREFIX}-${customerKey}-${slug}`;
}

export async function customerKeyForPrincipal(principalId: string): Promise<string> {
	const normalized = principalId.trim();
	if (!normalized) throw new WfpPublisherError('Authenticated principal is required', 401);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized)));
	return [...digest.slice(0, 16)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function assertPublisherConfiguration(env: WfpPublisherConfig) {
	if (env.WFP_DISPATCH_NAMESPACE !== WFP_DISPATCH_NAMESPACE) {
		throw new WfpPublisherError('WfP publisher namespace is not safely configured', 503);
	}
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.WFP_API_TOKEN) {
		throw new WfpPublisherError('WfP publisher credentials are not configured', 503);
	}
}

function plainTextBinding(name: string, text: string) {
	return { type: 'plain_text', name, text } as const;
}

async function callWorkersApi<T>(
	env: WfpPublisherConfig,
	fetcher: Fetcher,
	method: 'GET' | 'PUT' | 'DELETE',
	path: string,
	body?: FormData,
): Promise<T> {
	let response: Response;
	try {
		response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}${path}`, {
			method,
			headers: { Authorization: `Bearer ${env.WFP_API_TOKEN}` },
			body,
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});
	} catch (error) {
		console.error(
			JSON.stringify({ event: 'wfp.api.unavailable', method, path, error: error instanceof Error ? error.message : String(error) }),
		);
		throw new WfpPublisherError('Cloudflare could not be reached to update the customer environment', 502, true);
	}

	const payload = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null;
	if (
		response.ok &&
		method === 'DELETE' &&
		(response.status === 200 || response.status === 204) &&
		!payload &&
		!response.headers.get('Content-Type')?.includes('json')
	) {
		return undefined as T;
	}
	if (!response.ok || !payload?.success) {
		console.error(
			JSON.stringify({
				event: 'wfp.api.failed',
				method,
				path,
				status: response.status,
				codes: payload?.errors?.map((error) => error.code) ?? [],
			}),
		);
		const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
		throw new WfpPublisherError(
			response.status === 429 ? 'Cloudflare API rate limit reached; retry shortly' : 'Cloudflare rejected the customer environment update',
			response.status === 429 ? 429 : 502,
			response.status >= 500 || response.ok,
			response.status,
			retryAfterSeconds,
		);
	}
	return payload.result;
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

interface CloudflareEnvelope<T> {
	success: boolean;
	result: T;
	errors?: Array<{ code: number; message: string }>;
}

export const USER_WORKER_SOURCE = `
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\\\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT_SLUG, customer: env.CUSTOMER_KEY });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const html = "<!doctype html>" +
      "<html lang=\\"en\\"><head><meta charset=\\"utf-8\\">" +
      "<meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\">" +
      "<title>" + escapeHtml(env.ENVIRONMENT_TITLE) + "</title>" +
      "<style>" +
      "*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f3efe6;color:#171714;font-family:Arial,sans-serif}" +
      "main{width:min(100% - 32px,980px);margin:auto;padding:56px 0 72px}" +
      ".top{display:flex;justify-content:space-between;gap:24px;border-bottom:1px solid #171714;padding-bottom:18px}" +
      ".eyebrow,code{font:700 11px/1.4 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}" +
      ".live{display:flex;align-items:center;gap:8px}.dot{width:9px;height:9px;border-radius:50%;background:#16895c}" +
      "h1{max-width:780px;margin:80px 0 24px;font-size:clamp(52px,9vw,112px);line-height:.86;letter-spacing:-.07em}" +
      ".description{max-width:600px;color:#5a5852;font-size:18px;line-height:1.55}" +
      ".facts{display:grid;grid-template-columns:repeat(3,1fr);margin-top:72px;border:1px solid #171714}" +
      ".fact{padding:24px}.fact+.fact{border-left:1px solid #171714}.fact span{display:block;color:#6d6a62;font-size:11px;margin-bottom:10px}" +
      ".fact strong{font-size:15px;word-break:break-word}.accent{color:#b64716}" +
      "@media(max-width:620px){main{padding-top:30px}.top{align-items:flex-start;flex-direction:column}h1{margin-top:56px}.facts{grid-template-columns:1fr}.fact+.fact{border-left:0;border-top:1px solid #171714}}" +
      "</style></head><body><main>" +
      "<div class=\\"top\\"><span class=\\"eyebrow\\">Emdash customer delivery</span><span class=\\"live\\"><i class=\\"dot\\"></i><code>live on WfP</code></span></div>" +
      "<h1>" + escapeHtml(env.ENVIRONMENT_TITLE) + "</h1>" +
      "<p class=\\"description\\">" + escapeHtml(env.ENVIRONMENT_DESCRIPTION) + "</p>" +
      "<section class=\\"facts\\" aria-label=\\"Deployment facts\\">" +
      "<div class=\\"fact\\"><span>Environment</span><strong class=\\"accent\\">" + escapeHtml(env.ENVIRONMENT_SLUG) + "</strong></div>" +
      "<div class=\\"fact\\"><span>Customer key</span><strong>" + escapeHtml(env.CUSTOMER_KEY) + "</strong></div>" +
      "<div class=\\"fact\\"><span>Published</span><strong>" + escapeHtml(env.PUBLISHED_AT) + "</strong></div>" +
      "</section></main></body></html>";

    return new Response(request.method === "HEAD" ? null : html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
      }
    });
  }
};
`.trim();
