-- 009 · fix a real defect in 003.
--
-- dataset_freshness had `primary key (source, dataset, entity_id)`, which makes
-- entity_id implicitly NOT NULL. But some datasets are account-wide, not
-- per-room — the PriceLabs market panel and MDV's per-dataset sync state both
-- are — and staleDatasets() already queried `entity_id is null` for exactly
-- that case. That branch could never match, so the gate silently ignored every
-- global dataset.
--
-- NULLS NOT DISTINCT makes one null entity_id collide with another, which is
-- what we want: one row per (source, dataset) at account scope.
alter table dataset_freshness drop constraint dataset_freshness_pkey;
alter table dataset_freshness add column if not exists id bigserial primary key;
alter table dataset_freshness alter column entity_id drop not null;
create unique index dataset_freshness_scope_idx
  on dataset_freshness (source, dataset, entity_id) nulls not distinct;
