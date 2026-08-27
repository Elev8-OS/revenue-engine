-- 025 · the tenant's own grouping, kept as the tenant maintains it.
--
-- `market` is ours: a box drawn round coordinates, four values wide, invented
-- here because something had to carry "Basel is not Bali". PriceLabs already
-- holds a grouping the tenant curates by hand, and it is the one they think in:
--
--   ID                86085     the Bali portfolio
--   CH - Urban        99998
--   CH - Semi Urban  100268
--   CH - Rural/Nature 100269
--   MiHome           120104     a separate operator's set
--   Zermattstays     126321
--   Peak & Pine      126655
--
-- Those are not markets. "CH - Urban" and "CH - Semi Urban" are one market and
-- two commercial situations, and MiHome and Zermattstays are different owners
-- inside one account. A page filtered only by market cannot ask "how is
-- Zermattstays doing", which is a question somebody has every week.
--
-- STORED, NOT DERIVED, and stored under the provider's name. This is PriceLabs'
-- grouping — if it is renamed there it must change here on the next import, and
-- a copy we massaged into our own vocabulary could not do that. Hence the
-- `pms_` prefix and the id beside the name: the name is what a reader sees, the
-- id is what survives a rename.
alter table entity add column if not exists pms_group    text;
alter table entity add column if not exists pms_group_id integer;

-- Subgroup is null on every listing on this account today. Carried anyway,
-- because the field exists in the payload and an empty column that fills itself
-- is better than a schema change the day somebody starts using it.
alter table entity add column if not exists pms_subgroup text;

-- Not unique: a group has many units, which is the point of a group.
create index if not exists entity_pms_group_idx
  on entity (pms_group) where pms_group is not null;
