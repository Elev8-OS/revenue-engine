-- 015 · Elev8 as the authority for rooms and for the OTA link.
--
-- Two tables and two columns, each for a reason the next reader will not guess.

-- A JWT from a password login is NOT an MDV refresh token, and putting it in
-- oauth_token would say it was. The difference is the whole operational story:
--   MDV   rotating, single-use, a spent one revokes the grant → refreshing is a
--         mutually exclusive operation and a mistake costs the integration.
--   Elev8 a login. Logging in again is free, idempotent, and costs nothing but
--         a request. No rotation, no revocation-by-reuse, nothing to lose.
-- Sharing a table would force one set of semantics onto both. So: its own table,
-- with only the fields a cheap-to-replace credential needs.
create table service_session (
  provider     text        primary key,
  token        text        not null,
  expires_at   timestamptz not null,
  obtained_at  timestamptz not null default now(),
  -- The last failure, kept so a broken login surfaces on /status instead of
  -- only in a log line nobody reads. Cleared on the next success.
  last_error   text,
  failures     integer     not null default 0
);

-- What the API actually returned, as a shape rather than as data.
--
-- The Postman collection carries 1'062 endpoints and ZERO response examples, so
-- every response shape below is unknown until something calls it. The choice is
-- to guess field paths and find out in production, or to look first and write
-- the mapper against what is there. This table is looking first.
--
-- Only keys, types and fill counts are stored — never values. A shape is safe to
-- keep and safe to show; a sample of live data is neither.
create table api_shape (
  id            bigserial   primary key,
  source        text        not null,
  endpoint      text        not null,
  observed_at   timestamptz not null default now(),
  -- How many objects the shape was derived from. A shape from one row is a
  -- hint; from fifty it is a fact, and the difference must stay visible.
  sample_count  integer     not null,
  -- [{ path, types[], filled, total }]
  shape         jsonb       not null,
  note          text,
  unique (source, endpoint, observed_at)
);

create index api_shape_latest_idx on api_shape (source, endpoint, observed_at desc);

-- The measured inputs to the band, kept beside the band itself.
--
-- Storing only the band would throw away the evidence: "2BR" cannot be
-- re-derived, re-banded, or audited, and when the banding rule changes there is
-- nothing to re-run it over. rooms is the count of rooms Elev8 holds; sleeps is
-- the bed capacity where the bed types carry a number, and null where they do
-- not — null meaning "not knowable from the source", never zero.
alter table entity add column if not exists rooms  integer;
alter table entity add column if not exists sleeps integer;

-- Zero rooms is not a studio. A listing whose room list came back empty has an
-- unfilled feature, not a room count of nothing, and the constraint says so
-- rather than leaving a plausible-looking 0 to be banded later.
alter table entity drop constraint if exists entity_rooms_positive;
alter table entity add constraint entity_rooms_positive
  check (rooms is null or rooms > 0);
alter table entity drop constraint if exists entity_sleeps_positive;
alter table entity add constraint entity_sleeps_positive
  check (sleeps is null or sleeps > 0);
