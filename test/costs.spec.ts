import { describe, expect, it } from 'vitest';
import {
	calculateGrossListPriceCosts,
	COST_METERS,
	GROSS_COST_EXCLUSIONS,
	GROSS_LIST_PRICE_RATE_CARD_2026_09_08,
	type GrossListPriceRate,
	type RawCostUsage,
	withGrossListPriceRates,
} from '../src/costs';
import {
	ANALYTICS_ENGINE_POINT_LIMITS,
	upsertCandidateMeasurement,
	validateAnalyticsEnginePoint,
	writeAnalyticsEnginePoints,
} from '../src/telemetry';

describe('gross public list-price costs', () => {
	it('prices raw Workers and Dynamic Worker units without allowances or base fees', () => {
		const result = calculateGrossListPriceCosts({
			rateCard: GROSS_LIST_PRICE_RATE_CARD_2026_09_08,
			usage: [
				usage({ meter: COST_METERS.workersRequests, rawUnit: 'request', rawUnits: 2_000_000 }),
				usage({ meter: COST_METERS.workersCpuMs, rawUnit: 'cpu_ms', rawUnits: 3_000_000 }),
				usage({
					scope: 'deploy',
					interaction: 'none',
					meter: COST_METERS.dynamicWorkerDays,
					rawUnit: 'unique_dynamic_worker_day',
					rawUnits: 4,
				}),
			],
			denominators: [{ target: 'vinext', requests: 2_000_000, allInInteractions: 10 }],
		});

		const target = result.targets[0];
		expect(target.runtime.usd).toBeCloseTo(0.66);
		expect(target.deploy.usd).toBeCloseTo(0.008);
		expect(target.oneTime.usd).toBeCloseTo(0.008);
		expect(target.allIn.usd).toBeCloseTo(0.668);
		expect(target.unitCosts.perRequest.usd).toBeCloseTo(0.66 / 2_000_000);
		expect(target.unitCosts.allInInteraction.usd).toBeCloseTo(0.668 / 10);
		expect(result.exclusions).toEqual(GROSS_COST_EXCLUSIONS);
		expect(result).not.toHaveProperty('baseFeeUsd');
	});

	it('computes request, browser, and all-in interaction values from separate runtime slices', () => {
		const browserRate: GrossListPriceRate = {
			meter: COST_METERS.browserRunMs,
			rawUnit: 'browser_ms',
			pricedUnitSize: 1_000,
			usdPerPricedUnit: 0.1,
			quality: 'estimated',
			sourceUrl: null,
		};
		const rateCard = withGrossListPriceRates(GROSS_LIST_PRICE_RATE_CARD_2026_09_08, {
			version: 'customer-supplied-2026-09-08.1',
			rates: [browserRate],
		});
		const result = calculateGrossListPriceCosts({
			rateCard,
			usage: [
				usage({ meter: COST_METERS.workersRequests, rawUnit: 'request', rawUnits: 1_000_000 }),
				usage({
					interaction: 'browser_interaction',
					meter: COST_METERS.browserRunMs,
					rawUnit: 'browser_ms',
					rawUnits: 4_000,
					quality: 'estimated',
				}),
			],
			denominators: [{ target: 'vinext', requests: 1_000_000, browserInteractions: 4, allInInteractions: 4 }],
		});

		const target = result.targets[0];
		expect(target.unitCosts.perRequest.usd).toBeCloseTo(0.3 / 1_000_000);
		expect(target.unitCosts.perBrowserInteraction.usd).toBeCloseTo(0.1);
		expect(target.unitCosts.perBrowserInteraction.quality).toBe('estimated');
		expect(target.unitCosts.allInInteraction.usd).toBeCloseTo(0.175);
	});

	it('propagates unavailable usage and rates instead of treating them as zero', () => {
		const result = calculateGrossListPriceCosts({
			rateCard: GROSS_LIST_PRICE_RATE_CARD_2026_09_08,
			usage: [
				usage({ meter: COST_METERS.workersRequests, rawUnit: 'request', rawUnits: 1_000_000 }),
				usage({
					meter: COST_METERS.containerVcpuSeconds,
					rawUnit: 'vcpu_second',
					rawUnits: 20,
				}),
				usage({
					meter: 'caller.missing_meter',
					rawUnit: 'operation',
					rawUnits: null,
					quality: 'unavailable',
				}),
			],
		});

		const runtime = result.targets[0].runtime;
		expect(runtime.usd).toBeNull();
		expect(runtime.knownUsd).toBeCloseTo(0.3);
		expect(runtime.quality).toBe('unavailable');
		expect(runtime.lines[1]).toMatchObject({ usd: null, quality: 'unavailable' });
		expect(runtime.lines[2]).toMatchObject({ usd: null, quality: 'unavailable' });
	});

	it('does not calculate unit costs for zero denominators', () => {
		const result = calculateGrossListPriceCosts({
			rateCard: GROSS_LIST_PRICE_RATE_CARD_2026_09_08,
			usage: [usage({ meter: COST_METERS.workersRequests, rawUnit: 'request', rawUnits: 1_000_000 })],
			denominators: [{ target: 'vinext', requests: 0, browserInteractions: 0, allInInteractions: 0 }],
		});

		expect(result.targets[0].unitCosts).toMatchObject({
			perRequest: { usd: null, quality: 'unavailable' },
			perBrowserInteraction: { usd: null, quality: 'unavailable' },
			allInInteraction: { usd: null, quality: 'unavailable' },
		});
	});

	it('keeps costs split by target without shared allocation', () => {
		const result = calculateGrossListPriceCosts({
			rateCard: GROSS_LIST_PRICE_RATE_CARD_2026_09_08,
			usage: [
				usage({ target: 'vinext', meter: COST_METERS.workersRequests, rawUnit: 'request', rawUnits: 1_000_000 }),
				usage({ target: 'opennext', meter: COST_METERS.workersRequests, rawUnit: 'request', rawUnits: 2_000_000 }),
			],
		});

		expect(result.targets.map(({ target, runtime }) => [target, runtime.usd])).toEqual([
			['vinext', 0.3],
			['opennext', 0.6],
		]);
		expect(result.exclusions).toContain('shared_allocation');
	});

	it('requires and propagates a new rate version when rates change', () => {
		expect(() =>
			withGrossListPriceRates(GROSS_LIST_PRICE_RATE_CARD_2026_09_08, {
				version: GROSS_LIST_PRICE_RATE_CARD_2026_09_08.version,
				rates: [],
			}),
		).toThrow('requires a new rate card version');

		const revised = withGrossListPriceRates(GROSS_LIST_PRICE_RATE_CARD_2026_09_08, {
			version: 'gross-public-list-price-2026-09-08.v2',
			rates: [
				{
					meter: COST_METERS.workersRequests,
					rawUnit: 'request',
					pricedUnitSize: 1_000_000,
					usdPerPricedUnit: 0.5,
					quality: 'estimated',
					sourceUrl: null,
				},
			],
		});
		const result = calculateGrossListPriceCosts({
			rateCard: revised,
			usage: [usage({ meter: COST_METERS.workersRequests, rawUnit: 'request', rawUnits: 1_000_000 })],
		});

		expect(result.rateVersion).toBe(revised.version);
		expect(result.targets[0].rateVersion).toBe(revised.version);
		expect(result.targets[0].runtime.lines[0]).toMatchObject({ rateVersion: revised.version, usd: 0.5 });
	});
});

describe('telemetry boundaries', () => {
	it('validates Analytics Engine limits before writing and tolerates an omitted binding', () => {
		const point = { indexes: ['run-1'], blobs: ['candidate_measurement'], doubles: [1] };
		const writes: AnalyticsEngineDataPoint[] = [];
		const dataset: AnalyticsEngineDataset = { writeDataPoint: (value) => writes.push(value ?? {}) };

		expect(writeAnalyticsEnginePoints(dataset, [point])).toBe(1);
		expect(writes).toEqual([point]);
		expect(writeAnalyticsEnginePoints(undefined, [point])).toBe(0);
		expect(() => validateAnalyticsEnginePoint({ ...point, indexes: ['x'.repeat(97)] })).toThrow('96 UTF-8 bytes');
		expect(() =>
			writeAnalyticsEnginePoints(
				undefined,
				Array.from({ length: ANALYTICS_ENGINE_POINT_LIMITS.maxPointsPerInvocation + 1 }, () => point),
			),
		).toThrow('250 data points');
	});

	it('rejects source content and raw principal fields from D1 measurement records', async () => {
		const measurement = {
			runId: '11111111-1111-4111-8111-111111111111',
			target: 'vinext',
			scope: 'build',
			metric: 'duration_ms',
			rawUnits: 120,
			rawUnit: 'ms',
			quality: 'measured',
			sampleCount: 1,
			observedAt: '2026-09-08T12:00:00.000Z',
		} as const;

		await expect(upsertCandidateMeasurement(undefined, measurement)).resolves.toBe(false);
		await expect(upsertCandidateMeasurement(undefined, { ...measurement, sourceContent: 'private source' })).rejects.toThrow(
			'unsupported field',
		);
		await expect(upsertCandidateMeasurement(undefined, { ...measurement, ownerPrincipalId: 'access-user:raw' })).rejects.toThrow(
			'unsupported field',
		);
	});
});

function usage(overrides: Partial<RawCostUsage>): RawCostUsage {
	return {
		target: 'vinext',
		scope: 'runtime',
		interaction: 'request',
		meter: COST_METERS.workersRequests,
		rawUnit: 'request',
		rawUnits: 1,
		quality: 'measured',
		...overrides,
	};
}
