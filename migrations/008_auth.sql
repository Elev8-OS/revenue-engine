-- 008 · magic-link sessions.
--
-- Two users, one tenant, no passwords. The design constraints that matter:
--
--   * Only a HASH of the login token is stored. If the table leaks, nobody can
--     log in with it — a stored raw token is a stored password.
--   * Redemption is single-use and atomic. `update ... where used_at is null
--     returning` makes a double-click or a replayed link a no-op rather than a
--     second session.
--   * A request for a non-allowlisted address is silently dropped and answers
--     identically to an accepted one, so the endpoint cannot be used to find
--     out who has access.

create table login_token (
  -- sha256 of the token. The token itself exists only in the link we send.
  token_hash text        primary key,
  email      text        not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index login_token_email_idx on login_token (email, created_at desc);

create table session (
  id         text        primary key,   -- 256 bits of randomness, looked up, not signed
  email      text        not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create index session_email_idx on session (email);

-- Throttle. Without it, anyone who knows an allowlisted address can fill that
-- person's inbox, and a login mail is exactly the kind of thing people click.
create table login_attempt (
  id         bigserial   primary key,
  email      text        not null,
  at         timestamptz not null default now()
);

create index login_attempt_window_idx on login_attempt (email, at desc);
