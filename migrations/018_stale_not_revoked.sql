-- 018 · a token that is behind is not a grant that is dead.
--
-- This corrects a mistake that cost days and pointed at the wrong party.
--
-- MDV's refresh tokens rotate on every use, so `invalid_grant` from their token
-- endpoint means ONE thing: the token we presented is not the current one — we
-- are a few rotations behind. It does not say the grant is gone. The provider
-- confirmed the grant was live throughout, with a successful exchange on it at
-- 24.08. 02:13 UTC, while this service was reporting "REVOKED and unrecoverable"
-- on its own readiness page and refusing to try.
--
-- The code turned a recoverable state into a permanent one, then required a human
-- and a newly minted credential to leave it. That is the worst shape a diagnosis
-- can take: stated more strongly than the evidence supports, and expensive to
-- disagree with.
--
-- So the two states get two sets of columns, because they have two remedies:
--
--   stale_since    we hold an old token. The chain is alive. The remedy is a
--                  current token, and the service can say exactly that.
--   revoked_at     the grant itself is gone — an unknown client, a withdrawn
--                  authorisation. The remedy is a new authorisation, and only
--                  then is "a human must act" true.
--
-- Nothing is migrated from one to the other. Any row currently marked revoked was
-- marked by the bug this migration exists to fix, so it is cleared: leaving it
-- would preserve exactly the false verdict being corrected.
alter table oauth_token add column if not exists stale_since  timestamptz;
alter table oauth_token add column if not exists stale_reason text;

-- Both at once is meaningless: a dead grant cannot also be merely behind.
alter table oauth_token drop constraint if exists oauth_token_one_bad_state;
alter table oauth_token
  add constraint oauth_token_one_bad_state
  check (stale_since is null or revoked_at is null);

-- The correction itself. Rows that were marked revoked on an `invalid_grant`
-- become stale, which is what they always were.
update oauth_token
   set stale_since = revoked_at,
       stale_reason = coalesce(revoked_reason, 'reclassified by migration 018'),
       revoked_at = null,
       revoked_reason = null
 where revoked_at is not null
   and (revoked_reason is null or revoked_reason ~* 'invalid_grant');

insert into oauth_event (provider, event, rotation, detail)
select provider, 'reclassified', rotation,
       'migration 018: invalid_grant is a stale token, not a revoked grant'
  from oauth_token where stale_since is not null;
