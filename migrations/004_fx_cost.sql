-- 004 · currency and the cost side.

-- PriceLabs returns currency CHF even for Bali villas and Elev8 mixes CHF and
-- IDR rows in one result, so a Swiss + Bali portfolio cannot be summed without
-- normalising. Rate is quoted as: 1 unit of base = rate units of quote.
create table fx_rate (
  day    date          not null,
  base   text          not null,
  quote  text          not null,
  rate   numeric(18,8) not null,
  source text          not null,   -- 'jisdor' (BI) for IDR, 'snb' for CHF
  primary key (day, base, quote)
);

-- Cost per turnover, in money. Elev8 knows minutes; the money has to come from
-- a confirmed rate. Effective-dated so a minimum-wage change (UMP/UMK, every
-- December) does not rewrite history.
create table cost_basis (
  entity_id      uuid        not null references entity(id) on delete cascade,
  effective_from date        not null,
  mode           cost_mode   not null,
  -- effort mode: minutes x minute_rate. flat mode: flat_amount per turnover.
  minute_rate    numeric(12,4),
  flat_amount    numeric(14,2),
  laundry        numeric(14,2) not null default 0,
  consumables    numeric(14,2) not null default 0,
  supervision    numeric(14,2) not null default 0,
  currency       text        not null,
  -- False until a human confirms the rate. Drives the "costs estimated" badge;
  -- an unconfirmed cost basis lowers confidence rather than blocking the basis.
  confirmed      boolean     not null default false,
  source_note    text,
  primary key (entity_id, effective_from),
  constraint cost_mode_shape check (
    (mode = 'effort' and minute_rate is not null) or
    (mode = 'flat'   and flat_amount is not null)
  )
);

-- Realised commercial stack per booking. Channex carries ota_commission and
-- taxes; net payout is NOT a documented field and has to be derived, so it is
-- stored as a derived column with its inputs kept beside it.
create table booking_economics (
  entity_id       uuid          not null references entity(id) on delete cascade,
  reservation_id  text          not null,
  channel         channel       not null,
  arrival         date          not null,
  departure       date          not null,
  nights          int           not null,
  gross_amount    numeric(14,2) not null,
  ota_commission  numeric(14,2),
  taxes_inclusive numeric(14,2) not null default 0,
  taxes_added     numeric(14,2) not null default 0,
  city_tax        numeric(14,2) not null default 0,
  collected_taxes numeric(14,2) not null default 0,
  services_total  numeric(14,2) not null default 0,
  currency        text          not null,
  -- Booked-at drives lead time and pace; it is the field Elev8 does have.
  booked_at       timestamptz,
  guest_country   text,
  guest_language  text,
  primary key (entity_id, reservation_id)
);

-- Per-night breakdown from Channex `days`. Realised ADR per night, which no
-- other source gives us.
create table booking_night (
  entity_id      uuid          not null references entity(id) on delete cascade,
  reservation_id text          not null,
  stay_date      date          not null,
  amount         numeric(14,2) not null,
  currency       text          not null,
  primary key (entity_id, reservation_id, stay_date)
);
