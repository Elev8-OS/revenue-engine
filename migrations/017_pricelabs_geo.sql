-- 017 · where a listing actually is.
--
-- Not decoration. The PriceLabs Revenue Estimator API is the only source in this
-- system that answers a COHORT question — "what do 2-bedroom listings around
-- here earn" — and it is addressed by latitude, longitude and bedroom count. No
-- coordinates, no cohort benchmark, and every finding that wants to say "below
-- the market" has nothing to compare against.
--
-- Both providers already hand them over and we were throwing them away: Elev8's
-- listing payload carries `latitude`/`longitude`, and the PriceLabs listing
-- carries them as strings.
--
-- Stored as numeric rather than a geography type on purpose. PostGIS is not
-- installed, nothing here does distance maths, and the one consumer wants two
-- decimal numbers in a query string.
alter table entity add column if not exists latitude  numeric(9,6);
alter table entity add column if not exists longitude numeric(9,6);

-- One coordinate is not a location. A row with a latitude and no longitude would
-- pass every "is it set" test and then produce a request that cannot be made, so
-- the pair is constrained together — the same reasoning as band and band_basis
-- in migration 013.
alter table entity drop constraint if exists entity_coords_together;
alter table entity add constraint entity_coords_together
  check ((latitude is null) = (longitude is null));

-- A coordinate outside the world is a parse accident, not a place. Both
-- providers send these as strings, and '0' is what a failed parse looks like —
-- so the range check is the cheap half of the defence and the importer refusing
-- exact (0, 0) is the other half.
alter table entity drop constraint if exists entity_coords_on_earth;
alter table entity add constraint entity_coords_on_earth
  check (latitude is null or (latitude between -90 and 90 and longitude between -180 and 180));

-- Which listing's coordinate a market panel was fetched with. Recorded because
-- a cohort benchmark is only as local as the point it was measured at, and
-- "Bali, 2BR" fetched from a coordinate in Canggu is not the same claim as the
-- same cohort fetched from Ubud. Without this the panel is unattributable.
alter table snapshot_market add column if not exists sampled_entity_id uuid
  references entity(id) on delete set null;
alter table snapshot_market add column if not exists sampled_from text;

-- A cancelled booking is not revenue, and it is not nothing either.
--
-- `booking_economics` had nowhere to put a status, which left two bad options:
-- write cancelled reservations and have them summed as earnings, or drop them
-- and make the cancellation rate unmeasurable. Both throw away something true.
-- PriceLabs returns `booking_status` and `cancelled_on` on every reservation, so
-- the row is kept and labelled, and every sum has to say which statuses it
-- counts.
alter table booking_economics add column if not exists status      text;
alter table booking_economics add column if not exists cancelled_on date;

create index if not exists booking_economics_status_idx
  on booking_economics (status) where cancelled_on is null;
