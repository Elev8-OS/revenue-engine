-- 005 · cohorts. The yardstick is our own cohort, never "the market": no
-- provider sells competitor funnel data, so a cohort comparison labelled
-- "market" would sell a precision that does not exist.

create table cohort (
  id       uuid primary key default gen_random_uuid(),
  market   market  not null,
  band     text    not null,
  channel  channel not null,
  unique (market, band, channel)
);

create table cohort_member (
  cohort_id uuid not null references cohort(id) on delete cascade,
  entity_id uuid not null references entity(id) on delete cascade,
  primary key (cohort_id, entity_id)
);

-- Minimum viable cohort size. At 62 listings across four markets and two
-- channels a cohort empties fast, so below the floor the answer is
-- "not assessable" rather than a weak number.
create table cohort_policy (
  id            int primary key default 1,
  min_members   int not null default 5,
  constraint singleton check (id = 1)
);
insert into cohort_policy (id) values (1) on conflict do nothing;

-- Rooms a check could not reach, with the missing signal named.
create table not_assessable (
  entity_id uuid        not null references entity(id) on delete cascade,
  as_of     date        not null,
  reason    text        not null,
  primary key (entity_id, as_of)
);
