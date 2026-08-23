-- 001 · enums and helpers.
-- Every enum here mirrors a decision already recorded in the project docs, so a
-- value cannot be invented later without the decision being revisited.

create extension if not exists "pgcrypto";

-- Sources. Booking and Airbnb are SEPARATE MDV namespaces: the two ids are not
-- joinable to each other, which is why they are distinct source values.
create type source_system as enum (
  'elev8', 'pricelabs', 'mdv_booking', 'mdv_airbnb', 'channex', 'nextpax'
);

-- What kind of thing the external id names. Needed because Channex alone has
-- three levels and PriceLabs uses a composite of two.
create type alias_kind as enum (
  'property', 'room', 'listing', 'rate_plan', 'reservation', 'group'
);

create type market as enum ('bali', 'ch', 'at');

-- Contract decides the objective. Mirrors ContractType in diagnosis.ts.
create type contract_type as enum (
  'guaranteed_rent', 'net_share', 'fixed_fee', 'gross_share'
);

-- Cost basis switch from the Standort decision: flat fee or by measured effort.
create type cost_mode as enum ('flat', 'effort');

-- Who caused a change. This is the field that keeps the reconciler from
-- fighting our own revenue manager: engine and human are both intent,
-- external is drift and gets named rather than silently reverted.
create type actor_kind as enum ('engine', 'human', 'external');

create type channel as enum ('booking', 'airbnb', 'direct', 'other');
