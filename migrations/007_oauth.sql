-- 007 · OAuth token custody.
--
-- MDV issues a 1-hour access token against a ROTATING refresh token, and
-- reusing a spent refresh token revokes the entire grant — not the session, the
-- grant. So token custody is not a detail of the adapter, it is a concurrency
-- problem with a destructive failure mode, and it belongs in the database where
-- exactly one row can be the truth.
create table oauth_token (
  provider          text        primary key,
  client_id         text        not null,
  access_token      text        not null,
  access_expires_at timestamptz not null,
  refresh_token     text        not null,
  -- Increments on every successful refresh. If we read a rotation we did not
  -- write, another process rotated behind us and our refresh token is already
  -- spent — the one situation we must never turn into a request.
  rotation          int         not null default 0,
  refreshed_at      timestamptz not null default now(),
  -- Set when the provider answers invalid_grant. The grant is dead and only a
  -- human re-authorisation revives it, so nothing may retry automatically:
  -- an automatic retry against a re-authorised grant would kill that one too.
  revoked_at        timestamptz,
  revoked_reason    text
);

-- The audit trail. Kept separately from the token row because the row is
-- overwritten on every rotation and the history is what explains a revocation
-- after the fact.
create table oauth_event (
  id         bigserial   primary key,
  provider   text        not null,
  event      text        not null,   -- refreshed | reused_from_cache | invalid_grant | error
  rotation   int,
  detail     text,
  at         timestamptz not null default now()
);

create index oauth_event_provider_idx on oauth_event (provider, at desc);
