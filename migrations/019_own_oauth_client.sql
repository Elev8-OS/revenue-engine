-- 019 · our own OAuth client, so two services stop spending each other's tokens.
--
-- Observed today, minutes apart: the revenue engine adopted the newly issued
-- refresh token, ran an import, and rotated the chain. The next call through the
-- `mydatavalue-mcp` server answered `invalid_grant` — its stored copy was now a
-- rotation behind. It works in both directions. Whichever service refreshes
-- last leaves the other holding a spent token, forever, alternating.
--
-- This is not a bug in either service. It is one grant being used by two, and
-- `src/sources/mdv/auth.ts` has documented the resolution since the file was
-- written: a SECOND client via RFC 7591 dynamic registration. Two clients, two
-- grants, neither able to spend the other's.
--
-- MDV confirmed the route in as many words: "Register any client with any
-- redirect URI you like there, any time — no need to come to us." They also
-- confirmed the existing self-registered client expires on 9 September, which
-- makes owning the registration the difference between a service that renews
-- itself and one that needs a human every few weeks.
--
-- The client SECRET is stored because a dynamically registered client is issued
-- one and there is nowhere else to put it. Same custody rules as the refresh
-- token in `oauth_token`: never logged, never in a report, never in a page.
create table oauth_client (
  provider          text        primary key,
  client_id         text        not null,
  -- Null for a public client. Present for the confidential ones MDV issues.
  client_secret     text,
  -- Recorded because the grant is bound to it: a callback that arrives for a
  -- different redirect URI is a different registration, not a retry.
  redirect_uri      text        not null,
  registered_at     timestamptz not null default now(),
  -- RFC 7591 `client_secret_expires_at`. 0 means "does not expire" in the spec,
  -- which is stored as null here rather than as the epoch.
  secret_expires_at timestamptz,
  -- RFC 7592 management credentials, kept so the registration can be read back
  -- or rotated without registering a second one.
  registration_access_token text,
  registration_client_uri   text,
  note              text
);

-- One row per provider, and the primary key already says so. The comment is here
-- because the temptation later will be to keep a history of registrations, and
-- the reason not to is that a spare client with a live grant is a credential
-- nobody is watching.
