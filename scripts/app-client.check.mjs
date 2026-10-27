import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../public/app.client', import.meta.url), 'utf8');
for (const mode of ['public-demo', 'access']) {
	test(`${mode} actions use the established identity flow`, async () => {
		const calls = [];
		const element = () => ({
			value: 'example',
			classList: { add() {} },
			addEventListener() {},
			replaceChildren() {},
			querySelector: element,
			querySelectorAll: () => [],
		});
		const context = vm.createContext({
			document: { querySelector: element, createElement: element },
			fetch: async (path, options = {}) => {
				calls.push([path, options.method ?? 'GET']);
				if (path === '/api/session')
					return mode === 'access'
						? new Response(null, { status: 404 })
						: Response.json({ mode, limits: {}, mutationsEnabled: true, publishingAvailable: true });
				if (path === '/api/fixtures') return Response.json({ fixtures: [], comparison: null });
				return Response.json({ error: 'Mocked action boundary' }, { status: 503 });
			},
			console,
			setTimeout,
			clearTimeout,
		});
		vm.runInContext(source, context);
		await vm.runInContext('startRun()', context);
		await vm.runInContext('deployCustomerEnvironment({preventDefault(){}})', context);
		assert.equal(calls.filter(([path, method]) => path === '/api/session' && method === 'POST').length, mode === 'public-demo' ? 2 : 0);
		assert.ok(calls.some(([path, method]) => path === '/api/runs' && method === 'POST'));
		assert.ok(calls.some(([path, method]) => path === '/api/wfp/environments' && method === 'POST'));
	});
}
