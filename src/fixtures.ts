/** Immutable fixture matrix; API callers can only select these three sources. */
import type { FixtureDefinition, FixtureId } from './domain';

export const fixtures: FixtureDefinition[] = [
	{
		id: 'vinext',
		name: 'Marketing launch',
		commit: '01 / app-router',
		description: 'A conventional App Router site with server rendering and no compiler extensions.',
		change: 'Initial Next.js 16 application',
		expectedTarget: 'vinext',
		marker: 'vinext-target-ok',
	},
	{
		id: 'opennext',
		name: 'Content pipeline',
		commit: '02 / custom-loader',
		description: 'Adds a Turbopack content loader. Vinext cannot compile it, while OpenNext preserves Next.js compilation.',
		change: '+ turbopack.rules + greeting-loader.cjs',
		expectedTarget: 'opennext',
		marker: 'opennext-fallback-ok',
	},
	{
		id: 'container',
		name: 'Runtime utility',
		commit: '03 / node-process',
		description: 'Adds a route that executes a child process. It builds for Workers but requires the full Node.js runtime.',
		change: '+ node:child_process runtime route',
		expectedTarget: 'container',
		marker: 'container-fallback-ok',
	},
];

export function getFixture(id: string): FixtureDefinition | undefined {
	return fixtures.find((fixture) => fixture.id === id);
}

export function isFixtureId(value: string): value is FixtureId {
	return getFixture(value) !== undefined;
}
