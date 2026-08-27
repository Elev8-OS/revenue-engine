-- What the shape export showed, and four things I had claimed the opposite of.
--
-- The discovery pass exists to stop me writing mappers against remembered field
-- names. It also caught me stating four absences that were not absences:
--
--   1. "This account sends no search rank." It does — under
--      `property_breakdown[].rank` in /booking/performance/, plus a whole
--      `ranking_timeline` with a daily percentile. It is simply not in
--      /booking/ranking/, which is the only place I looked.
--   2. "Promotions carry no start or end date." They do — nested under
--      `attributes.bookDates.dates.from/to`, not as flat `start_date`.
--   3. "MDV performance only overlaps PriceLabs." It carries rank, guest
--      countries, stay-duration and group-size breakdowns, cancellation rate and
--      per-currency splits. None of that is in PriceLabs.
--   4. "Text and photos have no source." /airbnb/listings/ carries `image_url`.
--
-- ELIGIBLE, not just active. `eligible_promotions[]` on the Airbnb side lists
-- levers the channel would let us run and we do not. That is a different fact
-- from "off": off is a decision someone made, eligible-and-absent is a decision
-- nobody has made — and it is the cheapest action list on the whole account.

alter table channel_promotion
  add column if not exists eligible     boolean,
  add column if not exists price_factor numeric(8,4),
  add column if not exists price_change numeric(14,2),
  add column if not exists lead_days    integer,
  add column if not exists min_los      integer;

comment on column channel_promotion.eligible is
  'The channel offers this lever on this object. Distinct from active: '
  'eligible-and-inactive is a decision nobody has made.';

-- Per-object commercial terms. Numbers, so they could live in `snapshot` — but
-- they are not a time series in any useful sense and they are read as a SET: the
-- take-rate stack is multiplicative, and a commission without its markup and its
-- guest target beside it misstates the margin rather than rounding it.
create table channel_terms (
  entity_id        uuid not null references entity(id) on delete cascade,
  source           source_system not null,
  /** Base commission the channel charges, percent as the provider states it. */
  commission_pct   numeric(6,3),
  /** Negative means we are subsidising the guest price. */
  guest_target_pct numeric(6,3),
  /** What the channel manager adds on top before the channel sees it. */
  pms_markup_pct   numeric(6,3),
  observed_at      timestamptz,
  as_of_date       date not null,
  primary key (entity_id, source, as_of_date)
);

create index channel_terms_recent_idx on channel_terms (entity_id, as_of_date desc);
