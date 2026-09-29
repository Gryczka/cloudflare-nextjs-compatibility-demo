PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
	site_id TEXT PRIMARY KEY,
	site_key TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	framework TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_index (
	run_id TEXT PRIMARY KEY,
	site_id TEXT,
	run_kind TEXT NOT NULL,
	fixture_id TEXT,
	status TEXT NOT NULL,
	selected_target TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	terminal_at TEXT,
	FOREIGN KEY (site_id) REFERENCES sites (site_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS candidate_measurements (
	run_id TEXT NOT NULL,
	target TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('build', 'deploy', 'runtime')),
	metric TEXT NOT NULL,
	raw_units REAL,
	raw_unit TEXT NOT NULL,
	quality TEXT NOT NULL CHECK (quality IN ('measured', 'derived', 'estimated', 'unavailable')),
	sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
	observed_at TEXT NOT NULL,
	PRIMARY KEY (run_id, target, scope, metric),
	FOREIGN KEY (run_id) REFERENCES run_index (run_id) ON DELETE CASCADE,
	CHECK (
		(quality = 'unavailable' AND raw_units IS NULL)
		OR (quality <> 'unavailable' AND raw_units IS NOT NULL AND raw_units >= 0)
	)
);

CREATE TABLE IF NOT EXISTS usage_rollups (
	run_id TEXT NOT NULL,
	target TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('build', 'deploy', 'runtime')),
	interaction TEXT NOT NULL CHECK (interaction IN ('request', 'browser_interaction', 'none')),
	meter TEXT NOT NULL,
	raw_units REAL,
	raw_unit TEXT NOT NULL,
	quality TEXT NOT NULL CHECK (quality IN ('measured', 'derived', 'estimated', 'unavailable')),
	sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
	window_start TEXT NOT NULL,
	window_end TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (run_id, target, scope, interaction, meter, window_start, window_end),
	FOREIGN KEY (run_id) REFERENCES run_index (run_id) ON DELETE CASCADE,
	CHECK (window_end >= window_start),
	CHECK (
		(quality = 'unavailable' AND raw_units IS NULL)
		OR (quality <> 'unavailable' AND raw_units IS NOT NULL AND raw_units >= 0)
	)
);

CREATE TABLE IF NOT EXISTS rate_cards (
	rate_version TEXT NOT NULL,
	as_of TEXT NOT NULL,
	basis TEXT NOT NULL CHECK (basis = 'gross_public_list_price'),
	currency TEXT NOT NULL CHECK (currency = 'USD'),
	meter TEXT NOT NULL,
	raw_unit TEXT NOT NULL,
	priced_unit_size REAL,
	usd_per_priced_unit REAL,
	quality TEXT NOT NULL CHECK (quality IN ('measured', 'derived', 'estimated', 'unavailable')),
	source_url TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (rate_version, meter),
	CHECK (
		(
			quality = 'unavailable'
			AND priced_unit_size IS NULL
			AND usd_per_priced_unit IS NULL
		)
		OR (
			quality <> 'unavailable'
			AND priced_unit_size > 0
			AND usd_per_priced_unit >= 0
		)
	)
);

CREATE TABLE IF NOT EXISTS cost_rollups (
	run_id TEXT NOT NULL,
	target TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('build', 'deploy', 'runtime')),
	interaction TEXT NOT NULL CHECK (interaction IN ('request', 'browser_interaction', 'none')),
	meter TEXT NOT NULL,
	window_start TEXT NOT NULL,
	window_end TEXT NOT NULL,
	rate_version TEXT NOT NULL,
	raw_units REAL,
	raw_unit TEXT NOT NULL,
	usage_quality TEXT NOT NULL CHECK (usage_quality IN ('measured', 'derived', 'estimated', 'unavailable')),
	priced_unit_size REAL,
	usd_per_priced_unit REAL,
	cost_usd REAL,
	quality TEXT NOT NULL CHECK (quality IN ('measured', 'derived', 'estimated', 'unavailable')),
	calculated_at TEXT NOT NULL,
	PRIMARY KEY (run_id, target, scope, interaction, meter, window_start, window_end, rate_version),
	FOREIGN KEY (run_id) REFERENCES run_index (run_id) ON DELETE CASCADE,
	FOREIGN KEY (rate_version, meter) REFERENCES rate_cards (rate_version, meter),
	CHECK (window_end >= window_start),
	CHECK (
		(usage_quality = 'unavailable' AND raw_units IS NULL)
		OR (usage_quality <> 'unavailable' AND raw_units IS NOT NULL AND raw_units >= 0)
	),
	CHECK (priced_unit_size IS NULL OR priced_unit_size > 0),
	CHECK (usd_per_priced_unit IS NULL OR usd_per_priced_unit >= 0),
	CHECK (cost_usd IS NULL OR cost_usd >= 0),
	CHECK (
		(quality = 'unavailable' AND cost_usd IS NULL)
		OR (quality <> 'unavailable' AND cost_usd IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_sites_updated_at ON sites (updated_at);
CREATE INDEX IF NOT EXISTS idx_run_index_site_created_at ON run_index (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_index_status_updated_at ON run_index (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidate_measurements_run_target ON candidate_measurements (run_id, target);
CREATE INDEX IF NOT EXISTS idx_candidate_measurements_metric_observed_at ON candidate_measurements (metric, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_rollups_run_target_window ON usage_rollups (run_id, target, window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_usage_rollups_meter_window ON usage_rollups (meter, window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_rate_cards_meter_as_of ON rate_cards (meter, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_run_target_rate ON cost_rollups (run_id, target, rate_version);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_window ON cost_rollups (window_start, window_end);

INSERT OR IGNORE INTO rate_cards (
	rate_version,
	as_of,
	basis,
	currency,
	meter,
	raw_unit,
	priced_unit_size,
	usd_per_priced_unit,
	quality,
	source_url,
	created_at
) VALUES
	(
		'gross-public-list-price-2026-09-08',
		'2026-09-08',
		'gross_public_list_price',
		'USD',
		'workers.requests',
		'request',
		1000000,
		0.30,
		'measured',
		'https://developers.cloudflare.com/workers/platform/pricing/',
		'2026-09-08T00:00:00.000Z'
	),
	(
		'gross-public-list-price-2026-09-08',
		'2026-09-08',
		'gross_public_list_price',
		'USD',
		'workers.cpu_ms',
		'cpu_ms',
		1000000,
		0.02,
		'measured',
		'https://developers.cloudflare.com/workers/platform/pricing/',
		'2026-09-08T00:00:00.000Z'
	),
	(
		'gross-public-list-price-2026-09-08',
		'2026-09-08',
		'gross_public_list_price',
		'USD',
		'dynamic_workers.unique_worker_days',
		'unique_dynamic_worker_day',
		1,
		0.002,
		'measured',
		'https://developers.cloudflare.com/dynamic-workers/pricing/',
		'2026-09-08T00:00:00.000Z'
	),
	(
		'gross-public-list-price-2026-09-08',
		'2026-09-08',
		'gross_public_list_price',
		'USD',
		'browser_run.browser_ms',
		'browser_ms',
		NULL,
		NULL,
		'unavailable',
		NULL,
		'2026-09-08T00:00:00.000Z'
	),
	(
		'gross-public-list-price-2026-09-08',
		'2026-09-08',
		'gross_public_list_price',
		'USD',
		'containers.vcpu_seconds',
		'vcpu_second',
		NULL,
		NULL,
		'unavailable',
		NULL,
		'2026-09-08T00:00:00.000Z'
	),
	(
		'gross-public-list-price-2026-09-08',
		'2026-09-08',
		'gross_public_list_price',
		'USD',
		'containers.memory_gib_seconds',
		'gib_second',
		NULL,
		NULL,
		'unavailable',
		NULL,
		'2026-09-08T00:00:00.000Z'
	),
	(
		'gross-public-list-price-2026-09-08',
		'2026-09-08',
		'gross_public_list_price',
		'USD',
		'containers.disk_gb_seconds',
		'gb_second',
		NULL,
		NULL,
		'unavailable',
		NULL,
		'2026-09-08T00:00:00.000Z'
	);
