-- 006 · findings, decisions and the write log.

create type gate_stage   as enum ('impressions', 'ctr', 'conversion', 'price');
create type gate_verdict as enum ('healthy', 'failing', 'unknown');
create type finding_state as enum ('open', 'accepted', 'rejected', 'expired', 'superseded');

create table finding (
  id           uuid          primary key default gen_random_uuid(),
  entity_id    uuid          not null references entity(id) on delete cascade,
  check_key    text          not null,
  check_version int          not null,
  severity     text          not null,
  headline     text          not null,
  window_from  date,
  window_to    date,
  -- Both bases are always computed; which one ranks follows the contract.
  amount_revenue numeric(14,2),
  amount_margin  numeric(14,2),
  band_low       numeric(14,2),
  band_high      numeric(14,2),
  currency       text,
  confidence     numeric(4,3),
  -- The first failing gate. Worst domain is DERIVED from this, never set by
  -- hand: a listing shown and not clicked has no price problem.
  first_failing  gate_stage,
  state          finding_state not null default 'open',
  expires_at     timestamptz,
  created_at     timestamptz   not null default now()
);

create index finding_open_idx on finding (entity_id, state) where state = 'open';

create table finding_gate (
  finding_id uuid        not null references finding(id) on delete cascade,
  stage      gate_stage  not null,
  verdict    gate_verdict not null,
  note       text,
  primary key (finding_id, stage)
);

-- Evidence, split into supporting and against. Against is REQUIRED: a check
-- that cannot argue its own counter-case is not ready to ship.
create table finding_evidence (
  id         bigserial primary key,
  finding_id uuid      not null references finding(id) on delete cascade,
  side       text      not null check (side in ('supporting', 'against', 'unknown')),
  family     text      not null,
  metric     text      not null,
  claim      text      not null,
  observed_at text
);

-- Every number that appears in the generated reasoning, with where it came
-- from. The persona may only use numbers present here, and each one is checked
-- against its source before the text is shown. This is what keeps a language
-- model from inventing a figure that reads plausible.
create table finding_number (
  finding_id uuid          not null references finding(id) on delete cascade,
  token      text          not null,
  value      numeric(18,6) not null,
  unit       text,
  source     source_system not null,
  source_field text        not null,
  observed_at timestamptz,
  primary key (finding_id, token)
);

create table decision (
  id         bigserial   primary key,
  finding_id uuid        not null references finding(id) on delete cascade,
  actor      text        not null,
  actor_type actor_kind  not null,
  verdict    text        not null check (verdict in ('accept', 'reject')),
  -- Structured reason. Adjusts thresholds, ceilings and prompt rules; it never
  -- trains a model, because fitting one operator's taste would cost the
  -- reproducibility the effect measurement depends on.
  reason     text,
  at         timestamptz not null default now()
);

-- The snapshot taken before a write: full prior state of every field touched.
-- Both the undo and the baseline the effect is measured against. Nothing is
-- sent to any provider before a row exists here.
create table write_snapshot (
  id         uuid        primary key default gen_random_uuid(),
  finding_id uuid        not null references finding(id) on delete cascade,
  entity_id  uuid        not null references entity(id) on delete cascade,
  prior      jsonb       not null,
  taken_at   timestamptz not null default now()
);

create table write_attempt (
  id           bigserial     primary key,
  finding_id   uuid          not null references finding(id) on delete cascade,
  snapshot_id  uuid          not null references write_snapshot(id),
  target       source_system not null,
  lever        text          not null,
  -- Unique: a retry must not double-apply. MDV replays on a repeated key.
  idempotency_key text       not null unique,
  -- True while the lever is in dry run: computed, diffed, logged, not sent.
  dry_run      boolean       not null default true,
  request      jsonb         not null,
  response     jsonb,
  http_status  int,
  -- Named blocked states rather than generic failure, because these are
  -- expected conditions: MDV writes_disabled (platform kill switch) and
  -- not_connected (co-host access missing).
  blocked_reason text,
  verified_at  timestamptz,
  created_at   timestamptz   not null default now()
);

create index write_attempt_finding_idx on write_attempt (finding_id, created_at desc);

-- Per lever and market: dry run, autonomy band, kill switch. A lever goes live
-- when its diff has been boring for two weeks, not when a sprint ends.
create table lever_policy (
  lever       text    not null,
  market      market  not null,
  dry_run     boolean not null default true,
  max_change_pct numeric(5,2),
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  primary key (lever, market)
);

-- Changes observed at a provider that we did not make. Named, not silently
-- reverted: with the revenue manager working in the tool, an external change is
-- information, not an error to fight.
create table drift_event (
  id         bigserial     primary key,
  entity_id  uuid          not null references entity(id) on delete cascade,
  source     source_system not null,
  field      text          not null,
  before_val text,
  after_val  text,
  actor      text,
  actor_type actor_kind    not null default 'external',
  detected_at timestamptz  not null default now()
);
