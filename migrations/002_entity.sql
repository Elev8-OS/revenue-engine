-- 002 · the canonical key. This table is the first product, not the dashboard.
-- Six systems name the same apartment differently; until this maps them, every
-- cross-source claim is name matching.

create table entity (
  id            uuid primary key default gen_random_uuid(),
  -- Human label. Deliberately NOT a key: names are duplicated up to 3x in Elev8
  -- (one villa name covers five separately-cleaned unit rows).
  label         text        not null,
  market        market      not null,
  -- Bedroom band and location type form the cohort. Nullable until resolved,
  -- because an unresolved cohort must produce "not assessable", never a guess.
  bedroom_band  text,
  location_type text,
  -- Location resolved to official codes (BPS/UMK region for Bali, commune for CH).
  -- Drives which minimum wage and which macro adapter applies.
  location_code text,
  contract      contract_type,
  -- Excluded from writes. A holdout that gets written to is not a control arm.
  in_holdout    boolean     not null default false,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index entity_market_idx on entity (market) where active;

-- One row per foreign key. The unique constraint is the point: an external id
-- resolves to exactly one canonical entity, and a second claim on it is an
-- error we want loudly at write time rather than quietly at report time.
create table entity_alias (
  entity_id   uuid          not null references entity(id) on delete cascade,
  source      source_system not null,
  kind        alias_kind    not null,
  external_id text          not null,
  -- Kept for the cases where the only join available is by name. Recording it
  -- makes a name-based match auditable instead of invisible.
  matched_by  text          not null default 'explicit',
  created_at  timestamptz   not null default now(),
  primary key (source, kind, external_id)
);

create index entity_alias_entity_idx on entity_alias (entity_id);

-- Aliases we could not resolve. Feeds the "N rooms not assessable" line, which
-- is what stops a portfolio with eight findings reading as healthy while a
-- dozen rooms were never assessed.
create table unresolved_alias (
  id          bigserial primary key,
  source      source_system not null,
  kind        alias_kind    not null,
  external_id text          not null,
  label       text,
  reason      text          not null,
  first_seen  timestamptz   not null default now(),
  last_seen   timestamptz   not null default now(),
  unique (source, kind, external_id)
);
