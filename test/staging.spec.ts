import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import staging from '../src/staging';

it('exposes public policy while denying bootstrap without configuration and Access without identity', async () => {
	const configured = {
		...env,
		STAGE_SCOPE: 'isolated-staging',
		STAGE_URL: 'https://stage.example',
		STAGE_VERSION: { id: 'fixture' },
		PUBLIC_DEMO: 'true',
		DEMO_MUTATIONS_ENABLED: 'false',
		REQUIRE_ACCESS: 'true',
		DEMO_SESSION_KEY: undefined,
	} as Parameters<typeof staging.fetch>[1];
	const send = (path: string, init?: RequestInit) =>
		staging.fetch(new Request(`${configured.STAGE_URL}${path}`, init), configured, {} as ExecutionContext);
	expect(await (await send('/api/session')).json()).toMatchObject({ mode: 'public-demo', mutationsEnabled: false });
	expect(
		(
			await send('/api/session', {
				method: 'POST',
				headers: { Origin: configured.STAGE_URL, 'Content-Type': 'application/json' },
				body: '{}',
			})
		).status,
	).toBe(503);
	expect((await send('/_stage/check/access-session')).status).toBe(403);
	const create = vi.fn(() => {
		throw new Error('Workflow start prohibited');
	});
	Object.assign(configured, { COMPATIBILITY_WORKFLOW: { create } });
	expect((await send('/api/runs', { method: 'POST', body: '{}' })).status).toBe(503);
	expect(create).not.toHaveBeenCalled();
	expect((await send('/_stage/check/body', { method: 'POST', body: 'x'.repeat(4097) })).status).toBe(413);
	const home = await send('/');
	expect(home.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
	expect(await home.text()).toContain('ISOLATED STAGING');
});
