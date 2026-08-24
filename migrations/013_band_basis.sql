-- 013 · the cohort band, honestly named.
--
-- `bedroom_band` was named for the dimension we expected to have. We do not have
-- it: MDV documents `bedrooms` but leaves it empty on this account, and Channex
-- has no bedroom field at all — its room types carry occupancy
-- (`occ_adults`, `default_occupancy`, `capacity`) instead.
--
-- Writing an occupancy figure into a column called `bedroom_band` would be a
-- lie that survives in every query and every screen that reads it. So the column
-- becomes `band`, which is what `cohort.band` has always been called, and a
-- second column records WHAT the band measures.
--
-- That second column is not bookkeeping. "cap 4" and "2BR" are different
-- yardsticks, and a reader comparing two rooms needs to know which one they are
-- looking at before the comparison means anything.
--
-- The rename is guarded rather than bare. The first version of this file failed
-- in production — it added the constraint without backfilling, so every existing
-- row with a band and no basis violated it instantly and took the whole database
-- to "unreachable". A migration that has already failed once in the wild is
-- exactly the one that must be safe to re-run from any partial state.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'entity' and column_name = 'bedroom_band'
  ) then
    alter table entity rename column bedroom_band to band;
  end if;
end $$;

alter table entity add column if not exists band_basis text;

-- BACKFILL BEFORE CONSTRAINING. Everything that carries a band today was
-- entered as a bedroom count, so that is what it is recorded as. Guessing here
-- is safe only because the guess is checkable: the demo seed is the only writer
-- so far, and it writes bedroom bands.
update entity set band_basis = 'bedrooms'
 where band is not null and band_basis is null;

alter table entity drop constraint if exists entity_band_basis_known;
alter table entity
  add constraint entity_band_basis_known
  check (band_basis is null or band_basis in ('bedrooms', 'occupancy'));

-- A band without a basis is unreadable; a basis without a band is meaningless.
-- Both null or both set — which is all the earlier, muddled version was trying
-- to say before an `or` clause made it say something else.
alter table entity drop constraint if exists entity_band_and_basis_together;
alter table entity
  add constraint entity_band_and_basis_together
  check ((band is null) = (band_basis is null));
