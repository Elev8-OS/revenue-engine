-- What the first live promotions pass reported as UNCLAIMED.
--
-- 500 rows came back and the resolver named five keys nothing had asked for:
-- `family`, `deactivated_at`, `category_id`, `created_at_booking`, `attributes`.
-- Three of them change what the page can say, so they get columns.
--
-- `family` is the one that fixes a display problem. The nine deal types on this
-- account — BASIC_DEAL, SECRET_DEAL, MOBILE_RATE, EARLY_BOOKER_DEAL,
-- LAST_MINUTE_DEAL, LIMITED_TIME_DEAL, COUNTRY_RATE, GETAWAY_CAMPAIGN,
-- LATE_ESCAPE_CAMPAIGN — are not nine independent switches; the provider groups
-- them, and rendering nine equal chips per listing hid that.
--
-- `deactivated_at` is the difference between "off" and "was on until Tuesday".
-- The pass reported no start or end date field, so this is the only time signal
-- the payload carries, and without it a switched-off lever has no history at all.

alter table channel_promotion
  add column if not exists family         text,
  add column if not exists category_id    text,
  add column if not exists deactivated_at timestamptz;

comment on column channel_promotion.family is
  'The provider''s own grouping of deal types. Transcribed, never mapped.';
comment on column channel_promotion.deactivated_at is
  'When the provider switched it off. The only time signal this payload carries.';
