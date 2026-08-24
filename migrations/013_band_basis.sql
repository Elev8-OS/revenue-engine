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
alter table entity rename column bedroom_band to band;

alter table entity add column if not exists band_basis text;

alter table entity
  add constraint entity_band_basis_known
  check (band_basis is null or band_basis in ('bedrooms', 'occupancy'));

-- A band without a basis is unreadable; a basis without a band is meaningless.
alter table entity
  add constraint entity_band_and_basis_together
  check ((band is null) = (band_basis is null) or band is not null and band_basis is not null);
