/** Versioned gross list-price modeling; missing meters stay explicitly unavailable. */
export const COST_QUALITY_LABELS = ['measured', 'derived', 'estimated', 'unavailable'] as const;
export type CostQuality = (typeof COST_QUALITY_LABELS)[number];

export const COST_SCOPES = ['build', 'deploy', 'runtime'] as const;
export type CostScope = (typeof COST_SCOPES)[number];

export const COST_INTERACTIONS = ['request', 'browser_interaction', 'none'] as const;
export type CostInteraction = (typeof COST_INTERACTIONS)[number];

export const GROSS_COST_EXCLUSIONS = ['plan_base_fees', 'included_allowances', 'shared_allocation'] as const;
export type GrossCostExclusion = (typeof GROSS_COST_EXCLUSIONS)[number];

export const COST_METERS = {
	workersRequests: 'workers.requests',
	workersCpuMs: 'workers.cpu_ms',
	dynamicWorkerDays: 'dynamic_workers.unique_worker_days',
	browserRunMs: 'browser_run.browser_ms',
	containerVcpuSeconds: 'containers.vcpu_seconds',
	containerMemoryGibSeconds: 'containers.memory_gib_seconds',
	containerDiskGbSeconds: 'containers.disk_gb_seconds',
} as const;

export interface RateCardSource {
	label: string;
	url: string;
}

export interface GrossListPriceRate {
	meter: string;
	rawUnit: string;
	pricedUnitSize: number | null;
	usdPerPricedUnit: number | null;
	quality: CostQuality;
	sourceUrl: string | null;
}

export interface GrossListPriceRateCard {
	version: string;
	asOf: string;
	currency: 'USD';
	basis: 'gross_public_list_price';
	exclusions: readonly GrossCostExclusion[];
	sources: readonly RateCardSource[];
	rates: readonly GrossListPriceRate[];
}

export interface RawCostUsage {
	target: string;
	scope: CostScope;
	interaction: CostInteraction;
	meter: string;
	rawUnit: string;
	rawUnits: number | null;
	quality: CostQuality;
}

export interface TargetCostDenominators {
	target: string;
	requests?: number | null;
	browserInteractions?: number | null;
	allInInteractions?: number | null;
}

export interface GrossCostInput {
	rateCard: GrossListPriceRateCard;
	usage: readonly RawCostUsage[];
	denominators?: readonly TargetCostDenominators[];
}

export interface CostLine {
	target: string;
	scope: CostScope;
	interaction: CostInteraction;
	meter: string;
	rawUnit: string;
	rawUnits: number | null;
	usageQuality: CostQuality;
	rateVersion: string;
	pricedUnitSize: number | null;
	usdPerPricedUnit: number | null;
	rateQuality: CostQuality;
	sourceUrl: string | null;
	usd: number | null;
	quality: CostQuality;
	reason: string | null;
}

export interface CostSubtotal {
	usd: number | null;
	knownUsd: number;
	quality: CostQuality;
	complete: boolean;
	reason: string | null;
	lines: readonly CostLine[];
}

export interface PerUnitCost {
	usd: number | null;
	denominator: number | null;
	quality: CostQuality;
	reason: string | null;
}

export interface TargetCostRollup {
	target: string;
	rateVersion: string;
	build: CostSubtotal;
	deploy: CostSubtotal;
	oneTime: CostSubtotal;
	runtime: CostSubtotal;
	allIn: CostSubtotal;
	unitCosts: {
		perRequest: PerUnitCost;
		perBrowserInteraction: PerUnitCost;
		allInInteraction: PerUnitCost;
	};
}

export interface GrossCostRollup {
	rateVersion: string;
	asOf: string;
	currency: 'USD';
	basis: 'gross_public_list_price';
	exclusions: readonly GrossCostExclusion[];
	targets: readonly TargetCostRollup[];
}

const WORKERS_PRICING_URL = 'https://developers.cloudflare.com/workers/platform/pricing/';
const DYNAMIC_WORKERS_PRICING_URL = 'https://developers.cloudflare.com/dynamic-workers/pricing/';

export const GROSS_LIST_PRICE_RATE_CARD_2026_09_08: GrossListPriceRateCard = {
	version: 'gross-public-list-price-2026-09-08',
	asOf: '2026-09-08',
	currency: 'USD',
	basis: 'gross_public_list_price',
	exclusions: GROSS_COST_EXCLUSIONS,
	sources: [
		{ label: 'Workers pricing', url: WORKERS_PRICING_URL },
		{ label: 'Dynamic Workers pricing', url: DYNAMIC_WORKERS_PRICING_URL },
	],
	rates: [
		{
			meter: COST_METERS.workersRequests,
			rawUnit: 'request',
			pricedUnitSize: 1_000_000,
			usdPerPricedUnit: 0.3,
			quality: 'measured',
			sourceUrl: WORKERS_PRICING_URL,
		},
		{
			meter: COST_METERS.workersCpuMs,
			rawUnit: 'cpu_ms',
			pricedUnitSize: 1_000_000,
			usdPerPricedUnit: 0.02,
			quality: 'measured',
			sourceUrl: WORKERS_PRICING_URL,
		},
		{
			meter: COST_METERS.dynamicWorkerDays,
			rawUnit: 'unique_dynamic_worker_day',
			pricedUnitSize: 1,
			usdPerPricedUnit: 0.002,
			quality: 'measured',
			sourceUrl: DYNAMIC_WORKERS_PRICING_URL,
		},
		{
			meter: COST_METERS.browserRunMs,
			rawUnit: 'browser_ms',
			pricedUnitSize: null,
			usdPerPricedUnit: null,
			quality: 'unavailable',
			sourceUrl: null,
		},
		{
			meter: COST_METERS.containerVcpuSeconds,
			rawUnit: 'vcpu_second',
			pricedUnitSize: null,
			usdPerPricedUnit: null,
			quality: 'unavailable',
			sourceUrl: null,
		},
		{
			meter: COST_METERS.containerMemoryGibSeconds,
			rawUnit: 'gib_second',
			pricedUnitSize: null,
			usdPerPricedUnit: null,
			quality: 'unavailable',
			sourceUrl: null,
		},
		{
			meter: COST_METERS.containerDiskGbSeconds,
			rawUnit: 'gb_second',
			pricedUnitSize: null,
			usdPerPricedUnit: null,
			quality: 'unavailable',
			sourceUrl: null,
		},
	],
};

export function withGrossListPriceRates(
	base: GrossListPriceRateCard,
	revision: {
		version: string;
		asOf?: string;
		rates: readonly GrossListPriceRate[];
		sources?: readonly RateCardSource[];
	},
): GrossListPriceRateCard {
	const validatedBase = validateRateCard(base);
	const version = boundedText(revision.version, 'rate card version', 128);
	if (version === validatedBase.version) throw new Error('A rate change requires a new rate card version');

	const rates = new Map(validatedBase.rates.map((rate) => [rate.meter, rate]));
	for (const rate of revision.rates) {
		const validated = validateRate(rate);
		rates.set(validated.meter, validated);
	}

	return validateRateCard({
		...validatedBase,
		version,
		asOf: revision.asOf ?? validatedBase.asOf,
		sources: revision.sources ?? validatedBase.sources,
		rates: [...rates.values()],
	});
}

export function calculateGrossListPriceCosts(input: GrossCostInput): GrossCostRollup {
	const rateCard = validateRateCard(input.rateCard);
	if (!Array.isArray(input.usage)) throw new TypeError('usage must be an array');
	if (input.denominators !== undefined && !Array.isArray(input.denominators)) {
		throw new TypeError('denominators must be an array');
	}

	const rates = new Map(rateCard.rates.map((rate) => [rate.meter, rate]));
	const usageByTarget = new Map<string, RawCostUsage[]>();
	for (const rawUsage of input.usage) {
		const usage = validateUsage(rawUsage);
		const targetUsage = usageByTarget.get(usage.target) ?? [];
		targetUsage.push(usage);
		usageByTarget.set(usage.target, targetUsage);
	}

	const denominatorsByTarget = new Map<string, Required<TargetCostDenominators>>();
	for (const rawDenominators of input.denominators ?? []) {
		const denominators = validateDenominators(rawDenominators);
		if (denominatorsByTarget.has(denominators.target)) {
			throw new Error(`Duplicate denominators for target ${JSON.stringify(denominators.target)}`);
		}
		denominatorsByTarget.set(denominators.target, denominators);
		if (!usageByTarget.has(denominators.target)) usageByTarget.set(denominators.target, []);
	}

	const targets = [...usageByTarget].map(([target, usage]) => {
		const lines = usage.map((item) => calculateLine(item, rateCard.version, rates.get(item.meter)));
		const build = subtotal(lines.filter((line) => line.scope === 'build'));
		const deploy = subtotal(lines.filter((line) => line.scope === 'deploy'));
		const runtime = subtotal(lines.filter((line) => line.scope === 'runtime'));
		const oneTime = subtotal([...build.lines, ...deploy.lines]);
		const allIn = subtotal(lines);
		const requestRuntime = subtotal(runtime.lines.filter((line) => line.interaction === 'request'));
		const browserRuntime = subtotal(runtime.lines.filter((line) => line.interaction === 'browser_interaction'));
		const denominators = denominatorsByTarget.get(target) ?? {
			target,
			requests: null,
			browserInteractions: null,
			allInInteractions: null,
		};

		return {
			target,
			rateVersion: rateCard.version,
			build,
			deploy,
			oneTime,
			runtime,
			allIn,
			unitCosts: {
				perRequest: perUnitCost(requestRuntime, denominators.requests),
				perBrowserInteraction: perUnitCost(browserRuntime, denominators.browserInteractions),
				allInInteraction: perUnitCost(allIn, denominators.allInInteractions),
			},
		} satisfies TargetCostRollup;
	});

	return {
		rateVersion: rateCard.version,
		asOf: rateCard.asOf,
		currency: 'USD',
		basis: 'gross_public_list_price',
		exclusions: GROSS_COST_EXCLUSIONS,
		targets,
	};
}

export function costPerUnit(totalUsd: number | null, denominator: number | null): number | null {
	if (totalUsd !== null && (!Number.isFinite(totalUsd) || totalUsd < 0)) {
		throw new RangeError('totalUsd must be a nonnegative finite number or null');
	}
	if (denominator !== null && (!Number.isFinite(denominator) || denominator < 0)) {
		throw new RangeError('denominator must be a nonnegative finite number or null');
	}
	return totalUsd !== null && denominator !== null && denominator > 0 ? totalUsd / denominator : null;
}

export function combineCostQuality(...qualities: readonly CostQuality[]): CostQuality {
	if (qualities.includes('unavailable')) return 'unavailable';
	if (qualities.includes('estimated')) return 'estimated';
	if (qualities.includes('derived')) return 'derived';
	return 'measured';
}

function calculateLine(usage: RawCostUsage, rateVersion: string, rate: GrossListPriceRate | undefined): CostLine {
	if (!rate) return unavailableLine(usage, rateVersion, null, `No rate is defined for meter ${JSON.stringify(usage.meter)}`);
	if (rate.rawUnit !== usage.rawUnit) {
		throw new Error(`Rate ${JSON.stringify(rate.meter)} consumes ${JSON.stringify(rate.rawUnit)}, not ${JSON.stringify(usage.rawUnit)}`);
	}
	if (usage.rawUnits === null || usage.quality === 'unavailable') {
		return unavailableLine(usage, rateVersion, rate, 'Raw usage is unavailable');
	}
	if (rate.pricedUnitSize === null || rate.usdPerPricedUnit === null || rate.quality === 'unavailable') {
		return unavailableLine(usage, rateVersion, rate, 'A numeric list-price rate is unavailable');
	}

	return {
		...usage,
		usageQuality: usage.quality,
		rateVersion,
		pricedUnitSize: rate.pricedUnitSize,
		usdPerPricedUnit: rate.usdPerPricedUnit,
		rateQuality: rate.quality,
		sourceUrl: rate.sourceUrl,
		usd: (usage.rawUnits / rate.pricedUnitSize) * rate.usdPerPricedUnit,
		quality: combineCostQuality(usage.quality, rate.quality, 'derived'),
		reason: null,
	};
}

function unavailableLine(usage: RawCostUsage, rateVersion: string, rate: GrossListPriceRate | null, reason: string): CostLine {
	return {
		...usage,
		usageQuality: usage.quality,
		rateVersion,
		pricedUnitSize: rate?.pricedUnitSize ?? null,
		usdPerPricedUnit: rate?.usdPerPricedUnit ?? null,
		rateQuality: rate?.quality ?? 'unavailable',
		sourceUrl: rate?.sourceUrl ?? null,
		usd: null,
		quality: 'unavailable',
		reason,
	};
}

function subtotal(lines: readonly CostLine[]): CostSubtotal {
	const knownUsd = lines.reduce((sum, line) => sum + (line.usd ?? 0), 0);
	const complete = lines.every((line) => line.usd !== null);
	return {
		usd: complete ? knownUsd : null,
		knownUsd,
		quality: complete ? combineCostQuality(...lines.map((line) => line.quality), 'derived') : 'unavailable',
		complete,
		reason: complete ? null : 'One or more cost lines are unavailable',
		lines,
	};
}

function perUnitCost(subtotalValue: CostSubtotal, denominator: number | null): PerUnitCost {
	if (denominator === null) {
		return { usd: null, denominator, quality: 'unavailable', reason: 'Denominator is unavailable' };
	}
	if (denominator <= 0) {
		return { usd: null, denominator, quality: 'unavailable', reason: 'Denominator must be greater than zero' };
	}
	if (subtotalValue.lines.length === 0) {
		return { usd: null, denominator, quality: 'unavailable', reason: 'Cost numerator is unavailable' };
	}
	if (subtotalValue.usd === null) {
		return { usd: null, denominator, quality: 'unavailable', reason: subtotalValue.reason };
	}
	return {
		usd: costPerUnit(subtotalValue.usd, denominator),
		denominator,
		quality: combineCostQuality(subtotalValue.quality, 'derived'),
		reason: null,
	};
}

function validateRateCard(rateCard: GrossListPriceRateCard): GrossListPriceRateCard {
	if (!rateCard || typeof rateCard !== 'object') throw new TypeError('rateCard is required');
	const version = boundedText(rateCard.version, 'rate card version', 128);
	const asOf = validateDate(rateCard.asOf, 'rate card asOf');
	if (rateCard.currency !== 'USD') throw new TypeError('rate card currency must be USD');
	if (rateCard.basis !== 'gross_public_list_price') throw new TypeError('rate card basis must be gross_public_list_price');
	if (!Array.isArray(rateCard.rates)) throw new TypeError('rate card rates must be an array');
	if (!Array.isArray(rateCard.sources)) throw new TypeError('rate card sources must be an array');

	const rates = rateCard.rates.map(validateRate);
	const seenMeters = new Set<string>();
	for (const rate of rates) {
		if (seenMeters.has(rate.meter)) throw new Error(`Duplicate rate for meter ${JSON.stringify(rate.meter)}`);
		seenMeters.add(rate.meter);
	}
	const sources = rateCard.sources.map((source) => ({
		label: boundedText(source.label, 'rate source label', 128),
		url: validateHttpsUrl(source.url, 'rate source URL'),
	}));

	return {
		version,
		asOf,
		currency: 'USD',
		basis: 'gross_public_list_price',
		exclusions: GROSS_COST_EXCLUSIONS,
		sources,
		rates,
	};
}

function validateRate(rate: GrossListPriceRate): GrossListPriceRate {
	if (!rate || typeof rate !== 'object') throw new TypeError('rate must be an object');
	const meter = boundedText(rate.meter, 'rate meter', 128);
	const rawUnit = boundedText(rate.rawUnit, 'rate rawUnit', 64);
	const quality = validateQuality(rate.quality, 'rate quality');
	const sourceUrl = rate.sourceUrl === null ? null : validateHttpsUrl(rate.sourceUrl, 'rate sourceUrl');
	const pricedUnitSize = nullableNonnegativeFinite(rate.pricedUnitSize, 'rate pricedUnitSize', false);
	const usdPerPricedUnit = nullableNonnegativeFinite(rate.usdPerPricedUnit, 'rate usdPerPricedUnit', true);
	const numericRate = pricedUnitSize !== null && usdPerPricedUnit !== null;
	if ((pricedUnitSize === null) !== (usdPerPricedUnit === null)) {
		throw new TypeError('pricedUnitSize and usdPerPricedUnit must both be numeric or both be null');
	}
	if (numericRate === (quality === 'unavailable')) {
		throw new TypeError('Unavailable rates must be null and numeric rates must not be labeled unavailable');
	}
	return { meter, rawUnit, pricedUnitSize, usdPerPricedUnit, quality, sourceUrl };
}

function validateUsage(usage: RawCostUsage): RawCostUsage {
	if (!usage || typeof usage !== 'object') throw new TypeError('usage entry must be an object');
	const target = boundedText(usage.target, 'usage target', 128);
	if (!COST_SCOPES.includes(usage.scope)) throw new TypeError('usage scope must be build, deploy, or runtime');
	if (!COST_INTERACTIONS.includes(usage.interaction)) {
		throw new TypeError('usage interaction must be request, browser_interaction, or none');
	}
	const meter = boundedText(usage.meter, 'usage meter', 128);
	const rawUnit = boundedText(usage.rawUnit, 'usage rawUnit', 64);
	const quality = validateQuality(usage.quality, 'usage quality');
	const rawUnits = nullableNonnegativeFinite(usage.rawUnits, 'usage rawUnits', true);
	if ((rawUnits === null) !== (quality === 'unavailable')) {
		throw new TypeError('Unavailable usage must have null rawUnits and available usage must have numeric rawUnits');
	}
	return { target, scope: usage.scope, interaction: usage.interaction, meter, rawUnit, rawUnits, quality };
}

function validateDenominators(input: TargetCostDenominators): Required<TargetCostDenominators> {
	if (!input || typeof input !== 'object') throw new TypeError('target denominators must be an object');
	return {
		target: boundedText(input.target, 'denominator target', 128),
		requests: optionalDenominator(input.requests, 'requests'),
		browserInteractions: optionalDenominator(input.browserInteractions, 'browserInteractions'),
		allInInteractions: optionalDenominator(input.allInInteractions, 'allInInteractions'),
	};
}

function optionalDenominator(value: number | null | undefined, name: string): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a nonnegative finite number or null`);
	return value;
}

function validateQuality(value: CostQuality, name: string): CostQuality {
	if (!COST_QUALITY_LABELS.includes(value)) throw new TypeError(`${name} must be measured, derived, estimated, or unavailable`);
	return value;
}

function nullableNonnegativeFinite(value: number | null, name: string, allowZero: boolean): number | null {
	if (value === null) return null;
	if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
		throw new RangeError(`${name} must be ${allowZero ? 'a nonnegative' : 'a positive'} finite number or null`);
	}
	return value;
}

function boundedText(value: string, name: string, maxLength: number): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maxLength ||
		value.trim() !== value ||
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		throw new TypeError(`${name} must be a trimmed string of 1 to ${maxLength} characters`);
	}
	return value;
}

function validateDate(value: string, name: string): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
		throw new TypeError(`${name} must be an ISO calendar date`);
	}
	return value;
}

function validateHttpsUrl(value: string, name: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError(`${name} must be an HTTPS URL`);
	}
	if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError(`${name} must be an HTTPS URL`);
	return url.href;
}
