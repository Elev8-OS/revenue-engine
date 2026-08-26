-- Bewertungen und kommerzielle Hebel.
--
-- Reviews need no table. A score and a count are measurements that move over
-- time, so they belong in `snapshot` like occupancy does — under names that
-- carry the channel, because both channels report the same concept about the
-- same object and snapshot's primary key has no source column. That lesson cost
-- a live bug: two channels writing one metric name, and the second overwriting
-- the first before anything read it.
--
-- Promotions are different in kind. "Genius is on, Mobile Discount is off,
-- Visibility Booster runs at 12% until the 30th" is not a time series, it is a
-- STATE with a shape: a type, a switch, a rate, a window. A numeric column per
-- programme would break the day the provider adds one, and a key/value bag would
-- lose the window and the rate. So: one row per promotion per pass.

create table channel_promotion (
  id          bigserial primary key,
  -- Nullable ON PURPOSE. MDV's promotions report is described as team-wide with
  -- no filter to specific ids, so some rows are about the account rather than
  -- about one object. A row we cannot attribute is still worth keeping and worth
  -- showing as unattributed — inventing an owner for it would be worse.
  entity_id   uuid references entity(id) on delete cascade,
  source      source_system not null,
  /** The promotion's own id where it has one. */
  external_id text,
  /**
   * The provider's own label, TRANSCRIBED and not interpreted. `genius`,
   * `mobile_discount`, `visibility_booster`, `preferred` — whatever the payload
   * says. Normalising these into our own vocabulary would mean deciding that two
   * provider labels mean the same thing, which is exactly the kind of guess this
   * project keeps paying for.
   */
  kind        text not null,
  /** Null when the payload has no switch, which is not the same as "off". */
  active      boolean,
  /** Percent as the provider states it, 0-100. Null when it names no rate. */
  discount_pct numeric(6,3),
  starts_on   date,
  ends_on     date,
  observed_at timestamptz,
  as_of_date  date not null,
  created_at  timestamptz not null default now()
);

-- One row per promotion per object per pass. `coalesce` in the index rather than
-- in the key because both entity_id and external_id are legitimately absent:
-- a team-wide row has no object, and a programme switch has no id of its own.
create unique index channel_promotion_key on channel_promotion
  (source, as_of_date, coalesce(entity_id::text, '-'), coalesce(external_id, kind));

create index channel_promotion_entity_idx on channel_promotion (entity_id, as_of_date desc);
