import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInitialRun } from '../src/domain';
import worker from '../src/index';
import { coordinator, DEMO_LIMITS, PublicDemoCoordinator } from '../src/public-demo';
import { customerKeyForPrincipal } from '../src/wfp-environments';

const origin = 'https://example.com';
const secret = 'test-only-public-demo-session-key-never-deploy-this';
let testCoordinator = crypto.randomUUID();

beforeEach(() => {
	testCoordinator = crypto.randomUUID();
});

function demoEnv(): Env {
	return {
		...env,
		DEMO_COORDINATOR: { getByName: (name: string) => env.DEMO_COORDINATOR.getByName(`${name}:${testCoordinator}`) },
		PUBLIC_DEMO: 'true',
		DEMO_MUTATIONS_ENABLED: 'true',
		DEMO_SESSION_KEY: secret,
	} as Env;
}

function send(url: string, init?: RequestInit, demo = demoEnv()): Promise<Response> {
	return worker.fetch(new Request(new URL(url, origin), init), demo, {} as ExecutionContext);
}

async function visitor() {
	const home = await send('/');
	expect(home.status).toBe(200);
	const cookie = home.headers.get('Set-Cookie');
	expect(cookie).toMatch(/^__Host-compatibility-session=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=7200$/);
	if (!cookie) throw new Error('Expected a session cookie');
	const rawToken = cookie.split(';')[0].split('=')[1];
	const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken)))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return { cookie: cookie.split(';')[0], owner: `demo:${hash}` };
}

describe('anonymous demo HTTP boundary', () => {
	it('issues a secure session only on the landing page and session bootstrap, without exposing a principal', async () => {
		const unauthenticated = await send('/api/fixtures');
		expect(unauthenticated.status).toBe(401);
		const first = await visitor();
		const refresh = await send('/api/session', { headers: { Cookie: first.cookie } });
		expect(refresh.status).toBe(200);
		expect(refresh.headers.has('Set-Cookie')).toBe(false);
		expect(await refresh.json()).toMatchObject({
			mode: 'public-demo',
			limits: DEMO_LIMITS,
			mutationsEnabled: true,
			publishingAvailable: false,
		});
		const configured = await send('/api/session', { headers: { Cookie: first.cookie } }, { ...demoEnv(), WFP_API_TOKEN: 'test-token' });
		expect(await configured.json()).toMatchObject({ publishingAvailable: true });
		expect((await send('/app.js')).status).toBe(200);
	});

	it('isolates run snapshots, events and WebSocket upgrades, even with a forged internal owner header', async () => {
		const alice = await visitor();
		const bob = await visitor();
		const runId = crypto.randomUUID();
		await env.RUNS.getByName(runId).initialize(createInitialRun(runId, 'vinext', alice.owner, 'Demo visitor', new Date().toISOString()));
		const path = `/api/runs/${runId}`;
		const forged = { Cookie: bob.cookie, 'X-Compatibility-Run-Owner': alice.owner };
		for (const suffix of ['', '/events', '/ws', '/preview/']) {
			const response = await send(`${path}${suffix}`, { headers: forged });
			expect(response.status).toBe(404);
		}
		const own = await send(path, { headers: { Cookie: alice.cookie } });
		expect(own.status).toBe(200);
		expect(JSON.stringify(await own.json())).not.toContain(alice.owner);
		const crossOriginWs = await send(`${path}/ws`, {
			headers: { Cookie: alice.cookie, Upgrade: 'websocket', Origin: 'https://attacker.example' },
		});
		expect(crossOriginWs.status).toBe(403);
	});

	it('requires explicit same-origin requests for every public mutation', async () => {
		const user = await visitor();
		const run = {
			method: 'POST',
			headers: { Cookie: user.cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fixtureId: 'vinext' }),
		};
		expect((await send('/api/runs', run)).status).toBe(403);
		expect((await send('/api/runs', { ...run, headers: { ...run.headers, Origin: 'https://attacker.example' } })).status).toBe(403);
		const invalid = await send('/api/runs', {
			...run,
			headers: { ...run.headers, Origin: origin },
			body: JSON.stringify({ fixtureId: 'arbitrary-source' }),
		});
		expect(invalid.status).toBe(400);
		const publishing = await send('/api/wfp/environments', {
			...run,
			body: JSON.stringify({ slug: 'test', title: 'Test', description: 'Test' }),
		});
		expect(publishing.status).toBe(403);
		const runId = crypto.randomUUID();
		await env.RUNS.getByName(runId).initialize(createInitialRun(runId, 'vinext', user.owner, 'Demo visitor', new Date().toISOString()));
		expect((await send(`/api/runs/${runId}`, { method: 'DELETE', headers: { Cookie: user.cookie } })).status).toBe(403);
		expect(
			(await send('/api/runs', { ...run, headers: { ...run.headers, Origin: origin } }, { ...demoEnv(), DEMO_MUTATIONS_ENABLED: 'false' }))
				.status,
		).toBe(503);
		const paused = await send('/api/session', { headers: { Cookie: user.cookie } }, { ...demoEnv(), DEMO_MUTATIONS_ENABLED: 'false' });
		expect(await paused.json()).toMatchObject({ mutationsEnabled: false, publishingAvailable: false });
	});

	it('does not list or route another visitor’s published environment', async () => {
		const alice = await visitor();
		const bob = await visitor();
		const key = await customerKeyForPrincipal(alice.owner);
		const registry = env.ENVIRONMENT_REGISTRIES.getByName(key);
		const input = { slug: 'private-preview', title: 'Private preview', description: 'Fixed template' };
		const reservation = await registry.beginDeploy(input);
		if (!reservation.ok) throw new Error('Expected an environment reservation');
		await registry.completeDeploy(input.slug, reservation.operationId, new Date().toISOString());
		const demo = coordinator(demoEnv());
		expect(await demo.reserveEnvironment(alice.owner, input.slug, 'f'.repeat(64))).toEqual({ ok: true });
		await demo.confirmEnvironment(alice.owner, input.slug);
		const bobList = await send('/api/wfp/environments', { headers: { Cookie: bob.cookie } });
		expect(await bobList.json()).toEqual({ environments: [] });
		const forbidden = await send(`/customer-environments/${key}/${input.slug}/`, { headers: { Cookie: bob.cookie } });
		expect(forbidden.status).toBe(404);
	});
});

describe('deployment-wide demo coordinator', () => {
	it('serializes concurrent capacity reservations and holds them until teardown confirms', async () => {
		const demo = coordinator(demoEnv());
		const runs = Array.from({ length: DEMO_LIMITS.activeRuns + 2 }, (_, index) => ({
			id: crypto.randomUUID(),
			owner: `demo:${(index + 1).toString(16).padStart(64, '0')}`,
		}));
		const results = await Promise.all(
			runs.map((run, index) => demo.reserveRun(run.id, run.owner, (index + 1).toString(16).padStart(64, '0'), 'vinext')),
		);
		expect(results.filter((result) => result.ok)).toHaveLength(DEMO_LIMITS.activeRuns);
		expect(results.filter((result) => !result.ok)).toHaveLength(2);
		const accepted = runs.filter((_, index) => results[index].ok);
		await demo.requestRunCleanup(accepted[0].id);
		expect(await demo.canRun(accepted[0].id)).toBe(false);
		expect((await demo.reserveRun(crypto.randomUUID(), 'demo:' + 'b'.repeat(64), 'b'.repeat(64), 'vinext')).ok).toBe(false);
		await demo.releaseRun(accepted[0].id);
		expect((await demo.reserveRun(crypto.randomUUID(), 'demo:' + 'b'.repeat(64), 'b'.repeat(64), 'vinext')).ok).toBe(true);
	});

	it('enforces global limits across new sessions and IP addresses', async () => {
		const demo = coordinator(demoEnv());
		for (let index = 0; index < DEMO_LIMITS.runsPerHour; index += 1) {
			const id = crypto.randomUUID();
			const owner = `demo:${(index + 1).toString(16).padStart(64, '0')}`;
			expect(await demo.reserveRun(id, owner, (index + 51).toString(16).padStart(64, '0'), 'vinext')).toEqual({ ok: true });
			await demo.releaseRun(id);
		}
		const denied = await demo.reserveRun(crypto.randomUUID(), `demo:${'c'.repeat(64)}`, 'c'.repeat(64), 'vinext');
		expect(denied).toMatchObject({ ok: false, status: 429, retryAfterSeconds: expect.any(Number) });
	});

	it('keeps an expired run reserved when Workflow reconciliation or Sandbox teardown is unavailable', async () => {
		const demo = coordinator(demoEnv());
		const id = crypto.randomUUID();
		const owner = `demo:${'a'.repeat(64)}`;
		expect(await demo.reserveRun(id, owner, 'a'.repeat(64), 'opennext')).toEqual({ ok: true });
		await runInDurableObject(demo, async (_instance: PublicDemoCoordinator, state) => {
			state.storage.sql.exec('UPDATE demo_runs SET deadline = ? WHERE id = ?', Date.now() - 1, id);
		});
		expect(await runDurableObjectAlarm(demo)).toBe(true);
		expect(await demo.canRun(id)).toBe(false);
		expect((await demo.reserveRun(crypto.randomUUID(), owner, 'a'.repeat(64), 'vinext')).ok).toBe(false);
		const reservation = await runInDurableObject(demo, async (_instance: PublicDemoCoordinator, state) =>
			state.storage.sql.exec<{ fixture_id: string; state: string }>('SELECT fixture_id, state FROM demo_runs WHERE id = ?', id).one(),
		);
		expect(reservation).toEqual({ fixture_id: 'opennext', state: 'cleaning' });
	});

	it('retains an active reservation until teardown and then expires the run record', async () => {
		const demo = coordinator(demoEnv());
		const id = crypto.randomUUID();
		const owner = `demo:${'a'.repeat(64)}`;
		const run = env.RUNS.getByName(id);
		expect(await demo.reserveRun(id, owner, 'a'.repeat(64), 'vinext')).toEqual({ ok: true });
		await run.initialize(createInitialRun(id, 'vinext', owner, 'Demo visitor', new Date().toISOString()));
		expect(await demo.releaseRun(id)).toBe(false);
		const reserved = await runInDurableObject(
			demo,
			async (_instance, state) => state.storage.sql.exec('SELECT 1 FROM demo_runs WHERE id = ?', id).toArray().length,
		);
		expect(reserved).toBe(1);
		await run.markSandboxDestroyed(new Date().toISOString(), 'test teardown');
		expect(await demo.releaseRun(id)).toBe(true);
		expect(await demo.canRun(id)).toBe(false);
		const alarm = await runInDurableObject(run, async (_instance, state) => state.storage.getAlarm());
		expect(alarm).toBeTypeOf('number');
		expect(await runDurableObjectAlarm(run)).toBe(true);
		expect(await run.getSnapshot()).toBeNull();
		expect(await run.getEvents()).toEqual({ events: [], nextAfter: 0, hasMore: false });
	});

	it('blocks dispatch on an uncertain or expired environment without freeing its global slot', async () => {
		const demo = coordinator(demoEnv());
		const owner = `demo:${'d'.repeat(64)}`;
		const ip = 'd'.repeat(64);
		expect(await demo.reserveEnvironment(owner, 'limited-preview', ip)).toEqual({ ok: true });
		await demo.confirmEnvironment(owner, 'limited-preview');
		expect(await demo.canDispatch(owner, 'limited-preview')).toBe(true);
		await demo.beginEnvironmentDelete(owner, 'limited-preview');
		expect(await demo.canDispatch(owner, 'limited-preview')).toBe(false);
		await demo.failEnvironmentDelete(owner, 'limited-preview', true);
		expect(await demo.canDispatch(owner, 'limited-preview')).toBe(false);
		expect((await demo.reserveEnvironment(owner, 'second-preview', ip)).ok).toBe(false);
	});

	it('retries an expired environment when publishing credentials are missing instead of freeing capacity', async () => {
		const demo = coordinator(demoEnv());
		const owner = `demo:${'e'.repeat(64)}`;
		expect(await demo.reserveEnvironment(owner, 'expiry-preview', 'e'.repeat(64))).toEqual({ ok: true });
		await demo.confirmEnvironment(owner, 'expiry-preview');
		await runInDurableObject(demo, async (_instance: PublicDemoCoordinator, state) => {
			state.storage.sql.exec('UPDATE demo_environments SET expires_at = ? WHERE owner_id = ?', Date.now() - 1, owner);
		});
		expect(await runDurableObjectAlarm(demo)).toBe(true);
		expect(await demo.canDispatch(owner, 'expiry-preview')).toBe(false);
		expect((await demo.reserveEnvironment(owner, 'another-preview', 'e'.repeat(64))).ok).toBe(false);
	});
});
