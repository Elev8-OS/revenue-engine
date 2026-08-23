# revenue-engine

The Elev8 Revenue Engine as a standalone service. Reads MyDataValue, PriceLabs,
Channex and Elev8; produces one recommendation per room with its evidence; writes
back to the provider that owns each lever.

Built outside the Elev8 frontend deliberately: all four sources are external
APIs, so the engine is decoupled from the Channex to NextPax cutover. **The
engine reads, the cutover writes** — which means this can be live and proving
value before the PriceLabs partner certification lands.

## Status

Foundation only. `migrations/` and the modules under `src/` are the parts that
need no credentials. Nothing here talks to a live provider yet.

## What is here

| Path | What it is |
|---|---|
| `migrations/001_base.sql` | Enums. Each mirrors a recorded decision — note that `mdv_booking` and `mdv_airbnb` are separate sources because the two ids are **not** joinable. |
| `migrations/002_entity.sql` | The canonical key and `entity_alias`. The first product, not the dashboard. |
| `migrations/003_raw_snapshot.sql` | Raw landing zone plus the as-of archive and per-dataset freshness. |
| `migrations/004_fx_cost.sql` | FX, the two-mode cost basis, and realised booking economics including per-night amounts. |
| `migrations/005_cohort.sql` | Cohorts with a minimum size, and `not_assessable`. |
| `migrations/006_findings.sql` | Findings, gates, evidence, `finding_number`, decisions, write snapshots and the write log. |
| `src/fx/index.ts` | Converts at the **booking day's** rate, refuses on stale rates rather than guessing. |
| `src/entity/resolve.ts` | Alias resolution. Name matching allowed, never silent; ambiguity stays unresolved. |
| `src/snapshot/write.ts` | The nightly archive, `pickup()`, and the freshness gate. |
| `src/scheduler/budget.ts` | One budget across all sources, plus the market-panel dedupe that removes most of the PriceLabs cost. |
| `src/server.ts` | Entrypoint: migrate at boot, then serve the readiness page and `/healthz`. |

## Three rules the code enforces

**Nothing is written before a snapshot exists.** `write_snapshot` holds the full
prior state of every field a change touches. It is both the undo and the baseline
the effect is measured against, so a partial failure is always recoverable.

**A stale dataset does not argue.** `dataset_freshness` carries one timestamp per
dataset, not one per run. On the live MDV account five datasets were 20 minutes
old while `property_core` was 25 hours behind — a single "last check" stamp hides
exactly that. `staleDatasets()` is the gate.

**Exactly one process refreshes MDV tokens.** Their refresh tokens rotate and
reusing a spent one revokes the *entire* grant, not just the session. `MDV_MODE`
is `mcp` (delegate to the already-deployed `mydatavalue-mcp`) or `own` (this
worker, holding the advisory lock). Never both.

## Setup

```bash
npm install
npm run build
npm start           # applies migrations, then serves on $PORT
```

Configuration is names only — values live in Railway variables. See
`.env.example`. Nothing in this repo logs a secret value; the readiness page and
`loadConfig()` both report missing variable *names* and never partial values.

## Deployment

Railway builds with `npm run build` and starts with `npm start`. The service
boots **even when nothing is configured yet**: a crash-loop on a missing variable
tells you nothing, while a page naming exactly which of the four sources is still
missing turns the deploy into visible progress on the onboarding checklist.

- `/` — readiness page: database state, and per source whether it is connected
  or which variable names are still unset.
- `/healthz` — the same as JSON. Returns 200 whenever the process is up. A
  missing credential is a configuration state, not a failure; treating it as one
  would have Railway restart the service forever while waiting for something only
  a human can supply.

Migrations run at boot and are idempotent, so a redeploy costs nothing. Verified:
first boot applies six migrations and reports 25 tables, second boot reports the
same and applies none.

**One thing to do once, locally:** `package-lock.json` is not in the repo.
Generating it needs a real install, and its sha512 integrity hashes cannot be
hand-transcribed safely — a single wrong character breaks `npm ci` with a
misleading error. Run `npm install`, commit the lockfile, and Railpack stops
warning about non-deterministic installs.

## Verifying it

`./scripts-smoke.sh` drops and recreates a throwaway database, applies every
migration and runs `src/smoke.ts`, which asserts the invariants rather than the
happy path. On its first run it caught a real bug: `writeSnapshots` was binding
seven placeholders for eight columns. The typecheck was green; the database was
not.

## Not built yet, and why

- **Live adapters** — need credentials (steps 1-5 of the onboarding checklist).
- **Cohort assignment** — needs the confirmed market and band per entity.
- **Writes** — the schema is ready (`lever_policy` defaults every lever to
  `dry_run = true`); the adapters are not.
- **Elasticity** — not available from any of the four sources. Any statement
  about price sensitivity stays an assumption.
- **Our own year-over-year** — PriceLabs returns the sentinel `-2` for every
  `stly_*` field and syncs from 2026-06-22; Elev8 starts May 2026. Market versus
  last year *is* defensible, ours is not. The open question is how far
  `booking_revisions` reaches back in Channex.
