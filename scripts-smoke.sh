#!/usr/bin/env bash
# Recreates a throwaway database, applies every migration, runs the smoke tests.
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
