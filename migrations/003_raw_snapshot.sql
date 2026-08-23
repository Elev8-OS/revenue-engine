-- 003 · raw landing zone and the as-of archive.

-- Keep raw payloads. Too much of these APIs is undocumented (MDV price_test,
-- Channex is_expired) to decide at ingest time what matters. Deriving later from
-- kept raw is cheap; re-fetching a forward-looking series is impossible.
create table raw_payload (
  id         bigserial     primary key,
  source     source_system not null,
  endpoint   text          not null,
  entity_id  uuid          references entity(id) on delete set null,
  -- The external id as fetched, so a payload stays traceable even when the
  -- alias could not be resolved.
  external_id text,
  fetched_at timestamptz   not null default now(),
  status     int,
  body       jsonb         not null
);

create index raw_payload_lookup_idx on raw_payload (source, endpoint, fetched_at desc);
create index raw_payload_entity_idx on raw_payload (entity_id, fetched_at desc);

-- THE ARCHIVE. Every forward-looking series is only ever "as of today" at the
-- provider; without a nightly snapshot, pickup and pace are never computable,
-- not even retroactively. This is the one table whose absence causes permanent
-- loss, which is why it ships before anything else.
create table snapshot (
  entity_id  uuid          not null references entity(id) on delete cascade,
  metric     text          not null,
  -- The date the value is ABOUT.
  stay_date  date          not null,
  -- The date we OBSERVED it. The pair is what makes pickup computable.
  as_of_date date          not null,
  value      numeric(18,6) not null,
  currency   text,
  source     source_system not null,
  -- When the provider says it observed the value, where it tells us
  -- (MDV data_as_of / sync_state.metrics). Distinct from as_of_date, which is
  -- when WE looked.
  observed_at timestamptz,
  primary key (entity_id, metric, stay_date, as_of_date)
);

create index snapshot_metric_idx on snapshot (metric, stay_date, as_of_date desc);

-- Market-level series live per cohort, not per entity: the PriceLabs panel is
-- segmented by market and bedroom band, so pulling it per listing would fetch
-- the same ~207k characters many times over.
create table snapshot_market (
  market     market        not null,
  band       text          not null,
  metric     text          not null,
  stay_date  date          not null,
  as_of_date date          not null,
  value      numeric(18,6) not null,
  currency   text,
  primary key (market, band, metric, stay_date, as_of_date)
);

-- Per-dataset freshness. A single "last check" hides a real spread: on the live
-- account five MDV datasets were 20 minutes old while property_core was 25
-- hours behind. A stale dataset must block its findings, not decorate them.
create table dataset_freshness (
  source      source_system not null,
  dataset     text          not null,
  entity_id   uuid          references entity(id) on delete cascade,
  observed_at timestamptz,
  fetched_at  timestamptz   not null default now(),
  status      text,
  error       text,
  primary key (source, dataset, entity_id)
);
