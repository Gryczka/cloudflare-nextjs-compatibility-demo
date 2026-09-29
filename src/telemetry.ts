/** Bounded Analytics Engine and D1 telemetry schemas for candidate cost modeling. */
import { COST_INTERACTIONS, COST_QUALITY_LABELS, COST_SCOPES, type CostInteraction, type CostQuality, type CostScope } from './costs';

export const TELEMETRY_SCHEMA_VERSION = 1;

export const ANALYTICS_ENGINE_POINT_LIMITS = {
	maxBlobs: 20,
	maxDoubles: 20,
	maxIndexes: 1,
	maxBlobBytes: 16 * 1024,
	maxIndexBytes: 96,
	maxPointsPerInvocation: 250,
} as const;

export const CANDIDATE_MEASUREMENT_POINT_SCHEMA = {
	blobs: ['schema_version', 'event_type', 'run_id', 'target', 'scope', 'metric', 'raw_unit', 'quality'],
	doubles: ['observed_at_ms', 'raw_units_or_zero', 'raw_units_available', 'sample_count'],
} as const;

export const USAGE_ROLLUP_POINT_SCHEMA = {
	blobs: ['schema_version', 'event_type', 'run_id', 'target', 'scope', 'interaction', 'meter', 'raw_unit', 'quality'],
	doubles: ['window_start_ms', 'window_end_ms', 'raw_units_or_zero', 'raw_units_available', 'sample_count'],
} as const;

export interface BoundedAnalyticsEnginePoint {
	indexes: readonly string[];
	blobs?: readonly string[];
	doubles?: readonly number[];
}

export interface ValidatedAnalyticsEnginePoint {
	indexes: string[];
	blobs: string[];
	doubles: number[];
}

export interface CandidateMeasurement {
	runId: string;
	target: string;
	scope: CostScope;
	metric: string;
	rawUnits: number | null;
	rawUnit: string;
	quality: CostQuality;
	sampleCount: number;
	observedAt: string;
}

export interface UsageRollup {
	runId: string;
	target: string;
	scope: CostScope;
	interaction: CostInteraction;
	meter: string;
	rawUnits: number | null;
	rawUnit: string;
	quality: CostQuality;
	sampleCount: number;
	windowStart: string;
	windowEnd: string;
	updatedAt: string;
}

export const CANDIDATE_MEASUREMENT_UPSERT_SQL = `
	INSERT INTO candidate_measurements (
		run_id, target, scope, metric, raw_units, raw_unit, quality, sample_count, observed_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (run_id, target, scope, metric) DO UPDATE SET
		raw_units = excluded.raw_units,
		raw_unit = excluded.raw_unit,
		quality = excluded.quality,
		sample_count = excluded.sample_count,
		observed_at = excluded.observed_at
	WHERE excluded.observed_at > candidate_measurements.observed_at
`;

export const USAGE_ROLLUP_UPSERT_SQL = `
	INSERT INTO usage_rollups (
		run_id, target, scope, interaction, meter, raw_units, raw_unit, quality,
		sample_count, window_start, window_end, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (run_id, target, scope, interaction, meter, window_start, window_end) DO UPDATE SET
		raw_units = excluded.raw_units,
		raw_unit = excluded.raw_unit,
		quality = excluded.quality,
		sample_count = excluded.sample_count,
		updated_at = excluded.updated_at
	WHERE excluded.updated_at > usage_rollups.updated_at
`;

export function validateAnalyticsEnginePoint(input: unknown): ValidatedAnalyticsEnginePoint {
	const point = record(input, 'Analytics Engine point');
	assertOnlyKeys(point, ['indexes', 'blobs', 'doubles'], 'Analytics Engine point');
	const indexes = stringArray(point.indexes, 'indexes');
	const blobs = point.blobs === undefined ? [] : stringArray(point.blobs, 'blobs');
	const doubles = point.doubles === undefined ? [] : numberArray(point.doubles, 'doubles');

	if (indexes.length !== ANALYTICS_ENGINE_POINT_LIMITS.maxIndexes) {
		throw new RangeError('Analytics Engine points require exactly one index');
	}
	if (utf8Bytes(indexes[0]) > ANALYTICS_ENGINE_POINT_LIMITS.maxIndexBytes) {
		throw new RangeError(`Analytics Engine index exceeds ${ANALYTICS_ENGINE_POINT_LIMITS.maxIndexBytes} UTF-8 bytes`);
	}
	if (blobs.length > ANALYTICS_ENGINE_POINT_LIMITS.maxBlobs) {
		throw new RangeError(`Analytics Engine point exceeds ${ANALYTICS_ENGINE_POINT_LIMITS.maxBlobs} blobs`);
	}
	if (doubles.length > ANALYTICS_ENGINE_POINT_LIMITS.maxDoubles) {
		throw new RangeError(`Analytics Engine point exceeds ${ANALYTICS_ENGINE_POINT_LIMITS.maxDoubles} doubles`);
	}
	const blobBytes = blobs.reduce((total, blob) => total + utf8Bytes(blob), 0);
	if (blobBytes > ANALYTICS_ENGINE_POINT_LIMITS.maxBlobBytes) {
		throw new RangeError(`Analytics Engine blobs exceed ${ANALYTICS_ENGINE_POINT_LIMITS.maxBlobBytes} UTF-8 bytes`);
	}

	return { indexes, blobs, doubles };
}

export function writeAnalyticsEnginePoint(dataset: AnalyticsEngineDataset | null | undefined, point: BoundedAnalyticsEnginePoint): boolean {
	const validated = validateAnalyticsEnginePoint(point);
	if (!dataset) return false;
	dataset.writeDataPoint(validated);
	return true;
}

export function writeAnalyticsEnginePoints(
	dataset: AnalyticsEngineDataset | null | undefined,
	points: readonly BoundedAnalyticsEnginePoint[],
): number {
	if (!Array.isArray(points)) throw new TypeError('Analytics Engine points must be an array');
	if (points.length > ANALYTICS_ENGINE_POINT_LIMITS.maxPointsPerInvocation) {
		throw new RangeError(`Analytics Engine invocation exceeds ${ANALYTICS_ENGINE_POINT_LIMITS.maxPointsPerInvocation} data points`);
	}
	const validated = points.map(validateAnalyticsEnginePoint);
	if (!dataset) return 0;
	for (const point of validated) dataset.writeDataPoint(point);
	return validated.length;
}

export function candidateMeasurementPoint(index: string, input: unknown): ValidatedAnalyticsEnginePoint {
	const measurement = validateCandidateMeasurement(input);
	return validateAnalyticsEnginePoint({
		indexes: [index],
		blobs: [
			String(TELEMETRY_SCHEMA_VERSION),
			'candidate_measurement',
			measurement.runId,
			measurement.target,
			measurement.scope,
			measurement.metric,
			measurement.rawUnit,
			measurement.quality,
		],
		doubles: [
			Date.parse(measurement.observedAt),
			measurement.rawUnits ?? 0,
			measurement.rawUnits === null ? 0 : 1,
			measurement.sampleCount,
		],
	});
}

export function usageRollupPoint(index: string, input: unknown): ValidatedAnalyticsEnginePoint {
	const rollup = validateUsageRollup(input);
	return validateAnalyticsEnginePoint({
		indexes: [index],
		blobs: [
			String(TELEMETRY_SCHEMA_VERSION),
			'usage_rollup',
			rollup.runId,
			rollup.target,
			rollup.scope,
			rollup.interaction,
			rollup.meter,
			rollup.rawUnit,
			rollup.quality,
		],
		doubles: [
			Date.parse(rollup.windowStart),
			Date.parse(rollup.windowEnd),
			rollup.rawUnits ?? 0,
			rollup.rawUnits === null ? 0 : 1,
			rollup.sampleCount,
		],
	});
}

export function validateCandidateMeasurement(input: unknown): CandidateMeasurement {
	const value = record(input, 'candidate measurement');
	assertOnlyKeys(
		value,
		['runId', 'target', 'scope', 'metric', 'rawUnits', 'rawUnit', 'quality', 'sampleCount', 'observedAt'],
		'candidate measurement',
	);
	const quality = qualityLabel(value.quality, 'candidate measurement quality');
	return {
		runId: identifier(value.runId, 'candidate measurement runId', 128),
		target: identifier(value.target, 'candidate measurement target', 128),
		scope: scope(value.scope, 'candidate measurement scope'),
		metric: identifier(value.metric, 'candidate measurement metric', 128),
		rawUnits: rawUnits(value.rawUnits, quality, 'candidate measurement rawUnits'),
		rawUnit: identifier(value.rawUnit, 'candidate measurement rawUnit', 64),
		quality,
		sampleCount: sampleCount(value.sampleCount, quality, 'candidate measurement sampleCount'),
		observedAt: timestamp(value.observedAt, 'candidate measurement observedAt'),
	};
}

export function validateUsageRollup(input: unknown): UsageRollup {
	const value = record(input, 'usage rollup');
	assertOnlyKeys(
		value,
		[
			'runId',
			'target',
			'scope',
			'interaction',
			'meter',
			'rawUnits',
			'rawUnit',
			'quality',
			'sampleCount',
			'windowStart',
			'windowEnd',
			'updatedAt',
		],
		'usage rollup',
	);
	const quality = qualityLabel(value.quality, 'usage rollup quality');
	const windowStart = timestamp(value.windowStart, 'usage rollup windowStart');
	const windowEnd = timestamp(value.windowEnd, 'usage rollup windowEnd');
	if (windowEnd < windowStart) throw new RangeError('usage rollup windowEnd must not precede windowStart');

	return {
		runId: identifier(value.runId, 'usage rollup runId', 128),
		target: identifier(value.target, 'usage rollup target', 128),
		scope: scope(value.scope, 'usage rollup scope'),
		interaction: interaction(value.interaction, 'usage rollup interaction'),
		meter: identifier(value.meter, 'usage rollup meter', 128),
		rawUnits: rawUnits(value.rawUnits, quality, 'usage rollup rawUnits'),
		rawUnit: identifier(value.rawUnit, 'usage rollup rawUnit', 64),
		quality,
		sampleCount: sampleCount(value.sampleCount, quality, 'usage rollup sampleCount'),
		windowStart,
		windowEnd,
		updatedAt: timestamp(value.updatedAt, 'usage rollup updatedAt'),
	};
}

export async function upsertCandidateMeasurement(database: D1Database | null | undefined, input: unknown): Promise<boolean> {
	const measurement = validateCandidateMeasurement(input);
	if (!database) return false;
	await database
		.prepare(CANDIDATE_MEASUREMENT_UPSERT_SQL)
		.bind(
			measurement.runId,
			measurement.target,
			measurement.scope,
			measurement.metric,
			measurement.rawUnits,
			measurement.rawUnit,
			measurement.quality,
			measurement.sampleCount,
			measurement.observedAt,
		)
		.run();
	return true;
}

export async function upsertUsageRollup(database: D1Database | null | undefined, input: unknown): Promise<boolean> {
	const rollup = validateUsageRollup(input);
	if (!database) return false;
	await database
		.prepare(USAGE_ROLLUP_UPSERT_SQL)
		.bind(
			rollup.runId,
			rollup.target,
			rollup.scope,
			rollup.interaction,
			rollup.meter,
			rollup.rawUnits,
			rollup.rawUnit,
			rollup.quality,
			rollup.sampleCount,
			rollup.windowStart,
			rollup.windowEnd,
			rollup.updatedAt,
		)
		.run();
	return true;
}

function record(input: unknown, name: string): Record<string, unknown> {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
	return input as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const allowedKeys = new Set(allowed);
	const extra = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (extra) throw new TypeError(`${name} contains unsupported field ${JSON.stringify(extra)}`);
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new TypeError(`Analytics Engine ${name} must be an array of strings`);
	}
	for (const item of value) {
		if (item.length === 0 || /[\u0000]/.test(item)) throw new TypeError(`Analytics Engine ${name} cannot contain empty or NUL strings`);
	}
	return [...value] as string[];
}

function numberArray(value: unknown, name: string): number[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
		throw new TypeError(`Analytics Engine ${name} must be an array of finite numbers`);
	}
	return [...value] as number[];
}

function identifier(value: unknown, name: string, maxBytes: number): string {
	if (
		typeof value !== 'string' ||
		!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ||
		utf8Bytes(value) > maxBytes ||
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		throw new TypeError(`${name} must be a bounded, trimmed opaque identifier`);
	}
	return value;
}

function qualityLabel(value: unknown, name: string): CostQuality {
	if (typeof value !== 'string' || !COST_QUALITY_LABELS.includes(value as CostQuality)) {
		throw new TypeError(`${name} must be measured, derived, estimated, or unavailable`);
	}
	return value as CostQuality;
}

function scope(value: unknown, name: string): CostScope {
	if (typeof value !== 'string' || !COST_SCOPES.includes(value as CostScope)) {
		throw new TypeError(`${name} must be build, deploy, or runtime`);
	}
	return value as CostScope;
}

function interaction(value: unknown, name: string): CostInteraction {
	if (typeof value !== 'string' || !COST_INTERACTIONS.includes(value as CostInteraction)) {
		throw new TypeError(`${name} must be request, browser_interaction, or none`);
	}
	return value as CostInteraction;
}

function rawUnits(value: unknown, quality: CostQuality, name: string): number | null {
	if (quality === 'unavailable') {
		if (value !== null) throw new TypeError(`${name} must be null when quality is unavailable`);
		return null;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a nonnegative finite number`);
	}
	return value;
}

function sampleCount(value: unknown, quality: CostQuality, name: string): number {
	if (!Number.isSafeInteger(value) || (quality === 'unavailable' ? (value as number) < 0 : (value as number) <= 0)) {
		throw new RangeError(`${name} must be ${quality === 'unavailable' ? 'nonnegative' : 'positive'} safe integer`);
	}
	return value as number;
}

function timestamp(value: unknown, name: string): string {
	if (typeof value !== 'string') throw new TypeError(`${name} must be an ISO timestamp`);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be an ISO timestamp`);
	return new Date(milliseconds).toISOString();
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
