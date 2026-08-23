-- 010 · in-flight authorisation state.
--
-- The PKCE verifier has to survive the round trip to the provider and back, and
-- it must be usable exactly once: a replayed callback with the same state is
-- either a double-click or an attack, and both should get nothing.
--
-- `state` is the primary key rather than a column so a replayed value collides
-- rather than inserting a second row.
create table oauth_flow (
  state         text        primary key,
  provider      text        not null,
  code_verifier text        not null,
  redirect_uri  text        not null,
  -- Who started it, so a completed flow is attributable.
  started_by    text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);

create index oauth_flow_expiry_idx on oauth_flow (expires_at);
