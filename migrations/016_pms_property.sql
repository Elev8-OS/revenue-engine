-- 016 · the building an object sits in, as an attribute rather than a key.
--
-- Corrects a modelling mistake that a failing test exposed.
--
-- 015's importer wrote the Channex PROPERTY id into entity_alias. That table's
-- primary key is (source, kind, external_id), so a property id can point at
-- exactly one entity — which is right for a room and wrong for a property. In
-- the live account "The R Villa Merapi" is ONE Channex property with TWO rooms,
-- and "1 - 3 Plunge Pool" is one property with three units. The alias therefore
-- recorded whichever unit happened to be imported first and dropped the rest
-- through `on conflict do nothing`: an arbitrary winner, stored as if it were a
-- fact, and then used to resolve prices.
--
-- The distinction that fixes it:
--   pms_room_id      one room is one unit          → a KEY, stays in entity_alias
--   pms_listing_id   one property, many units      → an ATTRIBUTE, lives here
--
-- As a column it is also the multi-unit structure made explicit. That structure
-- was previously inferred from coordinates — 71 listings sharing 36 coordinate
-- pairs — which identified the building but could not say which units belonged
-- to it. Units in one building are now exactly the rows sharing this value.
alter table entity add column if not exists pms_property_id text;

-- Not unique, deliberately: several units share one property, and that is the
-- whole point of moving it out of the alias table.
create index if not exists entity_pms_property_idx
  on entity (pms_property_id) where pms_property_id is not null;

-- Aliases written by 015 under the property kind are removed: each one is either
-- an arbitrary winner among the units of a multi-unit property, or a redundant
-- duplicate of information now held on the entity. The room aliases stay — those
-- are genuine one-to-one keys and they are what PriceLabs resolution needs.
delete from entity_alias where source = 'channex' and kind = 'property'
  and matched_by = 'elev8_pms_field';
