-- 014 · a record of every import, and a guarantee that only one runs at a time.
--
-- The engine has no shell. Whoever operates it has a browser and a Railway
-- variables page, so an import has to be startable from a page and its outcome
-- has to be readable from one too. A row per run gives both, plus the thing an
-- in-memory variable could never give: an answer to "when did these objects
-- last change, and what did that run actually do".
create table import_run (
  id          bigserial   primary key,
  source      text        not null,
  started_by  text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  -- The ImportReport, verbatim. Stored rather than summarised because the
  -- interesting number is usually the one nobody thought to summarise.
  report      jsonb,
  error       text
);

-- At most one unfinished run, enforced by the database rather than by a check
-- in the handler. A double-click is the normal case, not the exotic one, and two
-- concurrent imports would race on entity creation.
create unique index import_run_one_at_a_time on import_run ((true)) where finished_at is null;

create index import_run_recent_idx on import_run (started_at desc);
