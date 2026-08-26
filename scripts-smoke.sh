#!/usr/bin/env bash
# Recreates a throwaway database, applies every migration, runs the smoke test.
set -e
PORT=${PGPORT:-5433}
psql -h /tmp -p $PORT -U postgres -q -c "drop database if exists re" postgres
psql -h /tmp -p $PORT -U postgres -q -c "create database re" postgres
for f in migrations/*.sql; do
  psql -h /tmp -p $PORT -U postgres -d re -v ON_ERROR_STOP=1 -q -f "$f"
done
export DATABASE_URL="postgresql://postgres@/re?host=/tmp&port=$PORT"
npx tsx src/smoke.ts
npx tsx src/smoke-mdv.ts
npx tsx src/smoke-auth.ts
npx tsx src/smoke-oauth.ts
npx tsx src/smoke-sso.ts
npx tsx src/smoke-mdv-client.ts
npx tsx src/smoke-mdv-register.ts
npx tsx src/smoke-mdv-objects.ts
npx tsx src/smoke-mdv-funnel.ts
npx tsx src/smoke-import.ts
# Added because they were not in this list. Eleven suites existed and eight ran,
# which meant three of them were only ever green on the machine that wrote them.
npx tsx src/smoke-elev8.ts
npx tsx src/smoke-origin.ts
npx tsx src/smoke-retire.ts
# Last on purpose: it truncates the object tables to build its own fixture, so
# anything expecting the earlier suites' rows must run before it.
npx tsx src/smoke-pricelabs.ts
npx tsx src/smoke-checks.ts
# No database: it renders markup and asserts what a reader would otherwise have
# to notice by eye.
npx tsx src/smoke-render.ts
