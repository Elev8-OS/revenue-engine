-- 024 · an Elev8 room is a bookable unit, not a bedroom.
--
-- Reto looked at the dashboard and said the room and bed counts were wrong. They
-- were, and the mistake is a category error rather than an arithmetic one.
--
-- Elev8's own hierarchy is Tenant → Property → Room → Listing, and a Room is
-- "a single bookable unit within a property" — it is the BILLING unit. So
-- `GET /api/v1/listing/:id/room` returns the separately rentable units under a
-- listing. 015's rooms pass took that array's length and wrote it as a bedroom
-- band, which turns five rentable rooms into "5BR".
--
-- Measured on the live account:
--
--   The R Villa Merapi        5 Elev8 rooms → shown as 5BR.
--                             Named "ROOM 1-4" and "Room 5", maximum_capacity 2.
--                             Five separately let rooms, each sleeping two.
--   4 - 7 Studio              4 units → "4BR". PriceLabs no_of_bedrooms = 1.
--   8 - 11 Mezzanine Apt      4 units → "4BR". PriceLabs no_of_bedrooms = 1.
--   1 - 3 Plunge Pool         3 units → "3BR". PriceLabs no_of_bedrooms = 1.
--
-- Worse, the evidence was already in this repo: 016 states in its own header
-- that Merapi is one property with several rooms and that "1 - 3 Plunge Pool is
-- one property with three units". The rooms pass measured the same structure and
-- called it something else.
--
-- WHERE THE REAL BEDROOM COUNT COMES FROM. PriceLabs `no_of_bedrooms`, which is
-- populated for 48 of 59 listings and agrees with the bedroom count stated in
-- the listing name on all nine listings where the name states one (5BR→5, 4BR→4,
-- 3BR→3 ×3, 2BR→2 ×4). Its unusable values are sentinels, already refused:
-- 0 on four listings and -1 on three.
--
-- WHERE CAPACITY COMES FROM. Elev8 `maximum_capacity`, filled on every listing,
-- plus the bed configuration on the rooms where the bed types carry a number.
-- Capacity bands stay coarser than bedroom bands on purpose: a sofa bed is not
-- a bedroom, so claiming equal precision would be false confidence.

-- The column measured units all along. Naming it for what it holds is the whole
-- point — the dashboard never read it, so this rename costs nothing and removes
-- the invitation to make the same mistake again.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'entity' and column_name = 'rooms'
  ) then
    alter table entity rename column rooms to units;
  end if;
end $$;

alter table entity add column if not exists units integer;

alter table entity drop constraint if exists entity_rooms_positive;
alter table entity drop constraint if exists entity_units_positive;
alter table entity add constraint entity_units_positive
  check (units is null or units > 0);

-- The bedroom count stored beside the band it produced, for the same reason
-- `units` and `sleeps` are: a band alone cannot be re-derived, cannot be
-- audited, and leaves nothing to re-run when the banding rule changes.
alter table entity add column if not exists bedrooms integer;

-- Zero is not a studio and -1 is not a basement. Both are "the channel manager
-- never said", and the reader that lets them through is the reader that invents
-- a cohort out of absent data.
alter table entity drop constraint if exists entity_bedrooms_positive;
alter table entity add constraint entity_bedrooms_positive
  check (bedrooms is null or bedrooms > 0);

-- EVERY BEDROOM BAND IS CLEARED, including the ones that happen to be right.
--
-- Nothing recorded which source wrote a given band, so there is no way to keep
-- the correct ones and drop the wrong ones. The choice is between one import
-- cycle with fewer cohorts and an unknown number of rows asserting a bedroom
-- count that is really a unit count — and a wrong band is worse than no band,
-- because "not assessable" is honest and "2BR" is a claim.
--
-- The next PriceLabs pass rewrites the real ones from `no_of_bedrooms`, and the
-- next Elev8 pass writes capacity bands where no bedroom count exists.
update entity
   set band = null, band_basis = null, updated_at = now()
 where band_basis = 'bedrooms';
