import app, { readJson } from './index';
export * from './index';

type StageEnv = Env & { STAGE_SCOPE: string; STAGE_URL: string; STAGE_VERSION: { id: string } };
export default {
	async fetch(request: Request, env: StageEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		let response: Response;
		if (env.STAGE_SCOPE !== 'isolated-staging' || url.origin !== env.STAGE_URL)
			response = Response.json({ error: 'Staging scope is unavailable' }, { status: 503 });
		else if (url.pathname === '/_stage/metadata' || url.pathname === '/health')
			response = Response.json({
				environmentScope: env.STAGE_SCOPE,
				url: env.STAGE_URL,
				version: env.STAGE_VERSION.id,
				sessionMode: 'public-demo',
				execution: 'disabled',
				sessionBootstrap: 'fail-closed-without-key',
				sharedProductionBindings: false,
			});
		else if (url.pathname === '/robots.txt')
			response = new Response('User-agent: *\nContent-Signal: search=yes,ai-input=yes,ai-train=no\nDisallow: /\n');
		else if (url.pathname === '/sitemap.xml')
			response = new Response('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>', {
				headers: { 'Content-Type': 'application/xml' },
			});
		else if (url.pathname === '/_stage/check/body' && request.method === 'POST') {
			try {
				await readJson(request, 4096);
				response = Response.json({ ok: true, fixture: 'body-only', workflowStarts: 0 });
			} catch (error) {
				response = Response.json(
					{ error: error instanceof Error ? error.message : 'Body rejected' },
					{ status: typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500 },
				);
			}
		} else if (url.pathname === '/_stage/check/access-session') {
			response = await app.fetch(
				new Request(`${env.STAGE_URL}/api/session`, request),
				{ ...env, PUBLIC_DEMO: 'false', REQUIRE_ACCESS: 'true' },
				ctx,
			);
		} else if (
			['/', '/styles.css', '/app.js', '/api/fixtures', '/api/session'].includes(url.pathname) &&
			(request.method === 'GET' || request.method === 'HEAD' || (request.method === 'POST' && url.pathname === '/api/session'))
		)
			response = await app.fetch(request, env, ctx);
		else response = Response.json({ error: 'Builds, Workflows and publishing are disabled in staging' }, { status: 503 });
		response = new Response(response.body, response);
		response.headers.set('X-Robots-Tag', 'noindex, nofollow');
		response.headers.set('Content-Signal', 'search=yes,ai-input=yes,ai-train=no');
		response.headers.set('X-Environment-Scope', 'isolated-staging');
		response.headers.set('X-Content-Type-Options', 'nosniff');
		if (response.headers.get('content-type')?.includes('text/html'))
			response = new HTMLRewriter()
				.on('link[rel="canonical"]', {
					element(element) {
						element.setAttribute('href', `${env.STAGE_URL}${url.pathname}`);
					},
				})
				.on('head', {
					element(element) {
						element.append('<meta name="robots" content="noindex,nofollow"><meta name="environmentScope" content="isolated-staging">', {
							html: true,
						});
					},
				})
				.on('body', {
					element(element) {
						element.prepend(
							`<aside><strong>ISOLATED STAGING</strong> · ${env.STAGE_URL} · Public metadata only; builds and publishing disabled.</aside>`,
							{ html: true },
						);
					},
				})
				.transform(response);
		return request.method === 'HEAD' ? new Response(null, response) : response;
	},
} satisfies ExportedHandler<StageEnv>;
