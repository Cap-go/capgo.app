#!/bin/bash
# Starts an isolated Postgres 17 (Supabase image, same family as prod) with pgmq + pgque installed.
# usage: start_container.sh <path-to-pgque-checkout>   (git clone https://github.com/NikolayS/pgque)
set -euo pipefail
PGQUE_DIR=${1:?path to a pgque checkout}
CONTAINER=${BENCH_CONTAINER:-qbench}
IMAGE=${BENCH_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}
DB_URL=${BENCH_DB_URL:-postgresql://supabase_admin:postgres@localhost:55432/postgres}
H="$(cd "$(dirname "$0")" && pwd)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --cpus=4 --memory=8g --shm-size=1g -p 55432:5432 \
  -e POSTGRES_PASSWORD=postgres "$IMAGE" postgres -c config_file=/etc/postgresql/postgresql.conf \
  -c shared_buffers=2GB -c max_connections=200 -c autovacuum_naptime=60 >/dev/null
until psql "$DB_URL" -Atc 'select 1' >/dev/null 2>&1; do sleep 2; done
P() { psql "$DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
P -c "create extension if not exists pgmq" -c "create extension if not exists pg_stat_statements" -c "create extension if not exists pg_cron"
(cd "$PGQUE_DIR" && psql "$DB_URL" -v ON_ERROR_STOP=1 -q --single-transaction -f sql/pgque.sql >/dev/null)
P -c "alter system set pg_stat_statements.track = 'all'" -c "select pg_reload_conf()" >/dev/null
P -f "$H/setup.sql"
echo "ready: pgmq $(P -Atc "select extversion from pg_extension where extname='pgmq'"), pgque $(P -Atc 'select pgque.version()')"
