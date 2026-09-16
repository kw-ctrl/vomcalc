#!/usr/bin/env bash
# Spin up a throwaway Postgres, apply the migration against a stubbed auth schema,
# and run the access-rule tests. Nothing here touches the real Supabase project.
set -euo pipefail

# macOS: without a valid locale the postmaster goes multithreaded during startup
# and refuses to boot ("postmaster became multithreaded during startup").
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LANG="${LANG:-en_US.UTF-8}"

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
if [ ! -x "$PGBIN/initdb" ]; then
  echo "postgres binaries not found at $PGBIN (brew install postgresql@16)" >&2
  exit 3
fi

WORK="$(mktemp -d /tmp/vom-pgtest-XXXXXX)"
PORT=55433
export PGDATA="$WORK/data"

cleanup() {
  "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "· initdb"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null

echo "· starting postgres on :$PORT"
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1" -w start >/dev/null

echo "· creating database"
"$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres vomtest

echo "· stubbing Supabase's auth schema"
"$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d vomtest -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique
);
-- Supabase ships this; the RLS policy in the migration references it.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
SQL

echo "· applying migration"
"$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d vomtest -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/../migrations/0001_init.sql"

echo "· running tests"
cd "$(dirname "$0")/../.."
TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/vomtest" node supabase/tests/access.test.mjs
