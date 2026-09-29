import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MIN_LEASE_TTL_MS } from '../src/build-capacity';

const ownerPrincipalId = 'access-user:pipeline-owner';

describe('pipeline Durable Object bindings', () => {
	it('serializes three-slot run leases through the configured capacity binding', async () => {
		const stub = env.BUILD_CAPACITY.getByName(crypto.randomUUID());
		const now = Date.now();
		const firstRunId = crypto.randomUUID();
		const secondRunId = crypto.randomUUID();

		const first = await stub.acquire({ runId: firstRunId, ownerPrincipalId, slots: 3, now, ttlMs: MIN_LEASE_TTL_MS });
		const second = await stub.acquire({ runId: secondRunId, ownerPrincipalId, slots: 3, now, ttlMs: MIN_LEASE_TTL_MS });

		expect(first.status).toBe('granted');
		expect(second).toMatchObject({ status: 'queued', position: 1 });
		if (first.status !== 'granted') throw new Error('Expected the first capacity lease to be granted');
		await stub.release(firstRunId, first.lease.leaseId);

		const grantedSecond = await stub.acquire({
			runId: secondRunId,
			ownerPrincipalId,
			slots: 3,
			now: now + 1,
			ttlMs: MIN_LEASE_TTL_MS,
		});
		expect(grantedSecond.status).toBe('granted');
	});

	it('persists an owner-bound upload run and redacts private identity', async () => {
		const runId = crypto.randomUUID();
		const stub = env.UPLOAD_RUNS.getByName(runId);
		await stub.initialize({
			runId,
			ownerPrincipalId,
			requestedBy: 'Pipeline owner',
			siteId: crypto.randomUUID(),
			siteHostname: 'site.preview.example.com',
			generation: 1,
			sourceR2Key: `runs/${runId}/source/upload.zip`,
			createdAt: '2026-09-08T12:00:00.000Z',
		});

		const snapshot = await stub.getPublicSnapshot(ownerPrincipalId);
		expect(snapshot).toMatchObject({ runId, kind: 'upload', status: 'queued', requestedBy: 'Pipeline owner' });
		expect(snapshot).not.toHaveProperty('ownerPrincipalId');
		expect(await stub.getPublicSnapshot('access-user:other')).toBeNull();
	});

	it('switches from the first provisional candidate to the ranked final candidate', async () => {
		const registry = env.SITE_REGISTRIES.getByName(crypto.randomUUID());
		const initialized = await registry.initializeSite({
			ownerPrincipalId,
			runId: crypto.randomUUID(),
			slug: 'pipeline-site',
			hostname: 'pipeline-site.preview.example.com',
		});
		if (!initialized.ok) throw new Error(`Site initialization failed: ${initialized.reason}`);
		const { site } = initialized;
		const provisional = await registry.setProvisional(site.siteId, ownerPrincipalId, site.generation, {
			kind: 'sandbox',
			sandboxId: 'sandbox-opennext',
			processId: 'preview-opennext',
			port: 3_000,
			candidate: 'opennext',
		});
		expect(provisional?.routeTarget?.candidate).toBe('opennext');

		const deploying = await registry.beginPromotion(site.siteId, ownerPrincipalId, site.generation);
		expect(deploying).toMatchObject({ state: 'deploying', generation: site.generation + 1 });
		if (!deploying) throw new Error('Expected site promotion to begin');
		const active = await registry.completePromotion(site.siteId, ownerPrincipalId, deploying.generation, {
			kind: 'wfp',
			scriptName: 'pipeline-site-vinext',
			candidate: 'vinext',
		});

		expect(active).toMatchObject({ state: 'active', routeTarget: { kind: 'wfp', candidate: 'vinext' } });
	});
});
