#!/bin/bash
# usage: [TICK_MS=100] bench.sh <pgmq|pgque> <load_multiplier> <duration_s> [longtx]
# Replays the prod-derived Capgo queue load (see setup.sql) against one engine and records
# DB-side cost counters. Needs psql + pgbench (PG17) and a Postgres container with pgmq and pgque.
set -euo pipefail
SYS=$1; LOAD=$2; DUR=$3; LONGTX=${4:-}
H="$(cd "$(dirname "$0")" && pwd)"
DB_URL=${BENCH_DB_URL:-postgresql://supabase_admin:postgres@localhost:55432/postgres}
CONTAINER=${BENCH_CONTAINER:-qbench}
P() { psql "$DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
TICK_MS=${TICK_MS:-100}
SUFFIX=""; if [ "$TICK_MS" != 100 ]; then SUFFIX="_tick${TICK_MS}"; fi
OUT=${BENCH_OUT:-$H/runs}/${SYS}_x${LOAD}${LONGTX:+_longtx}${SUFFIX}; rm -rf "$OUT"; mkdir -p "$OUT"
SCHEMA=$SYS
# Engine background jobs: pgque needs its ticker/maint jobs, pgmq needs nothing.
if [ "$SYS" = pgque ]; then P -Atc "select pgque.start()" -c "select pgque.set_tick_period_ms($TICK_MS)" >/dev/null 2>&1; else P -Atc "select pgque.stop()" >/dev/null 2>&1; fi
P -f $H/reset_engines.sql
P -c "vacuum analyze" -c "checkpoint" -c "select pg_stat_statements_reset()" >/dev/null
# Producer scripts: one per queue, pgbench weight = event rate (x10000).
rm -rf $OUT/scripts; mkdir -p $OUT/scripts
ARGS=()
TOTAL_EV=0
while IFS='|' read -r name rate burst; do
  if [ "$burst" -gt 1 ]; then
    # bursts follow the prod manifest-per-bundle distribution (mean ~784, max ~2700)
    printf '\\set k random_exponential(1, 3000, 3.4)\nselect bench.send_%s(%s, :k);\n' "$SYS" "'$name'" > $OUT/scripts/$name.sql
    ev=$(python3 -c "print($rate/$burst)")
  else
    printf 'select bench.send_%s(%s, 1);\n' "$SYS" "'$name'" > $OUT/scripts/$name.sql
    ev=$rate
  fi
  w=$(python3 -c "print(max(1,round($ev*10000)))")
  ARGS+=(-f "$OUT/scripts/$name.sql@$w")
  TOTAL_EV=$(python3 -c "print($TOTAL_EV+$ev)")
done < <(P -Atc "select name, msg_per_s_1x, burst_mean from bench.queues")
RATE=$(python3 -c "print(round($TOTAL_EV*$LOAD,4))")
CPU0=$(docker exec "$CONTAINER" cat /sys/fs/cgroup/cpu.stat | awk '/usage_usec/{print $2}')
P -At -F'|' -v schema=$SCHEMA -f $H/snapshot.sql > $OUT/snap0
# Dispatcher on pg_cron every 10 s, like process_all_cron_tasks -> process_function_queue.
P -Atc "select cron.schedule('bench_dispatch', '10 seconds', 'select bench.dispatch_$SYS()')" >/dev/null
# /queue_health polls every queue about every 24 s in prod.
( end=$(( $(date +%s) + DUR )); while [ $(date +%s) -lt $end ]; do P -Atc "select bench.health_$SYS()" >/dev/null; sleep 24; done ) &
HPID=$!
# Hourly cleanup_queue_messages / DLQ purge: run once per 300 s run (12x prod frequency).
( sleep $(( DUR / 2 )); P -Atc "select bench.cleanup_$SYS()" >/dev/null ) &
LPID=$!
if [ -n "$LONGTX" ]; then
  # Long reader holding the xmin horizon for the whole run (analytics query, pg_dump, lagging replica)
  ( P -c "begin isolation level repeatable read; select count(*) from pg_class; select pg_sleep($DUR + 30); commit;" >/dev/null 2>&1 & echo $! > $OUT/longtx.pid )
  sleep 1
fi
# Consumer: prod polls each queue every 10s (process_all_cron_tasks).
( end=$(( $(date +%s) + DUR )); while [ $(date +%s) -lt $end ]; do
    t0=$(python3 -c 'import time;print(time.time())'); P -c "call bench.consume_$SYS()"; t1=$(python3 -c 'import time;print(time.time())')
    echo "$t0 $t1" >> $OUT/consumer_polls; sleep 10; done ) &
CPID=$!
# Sample backlog every 10s
( end=$(( $(date +%s) + DUR )); while [ $(date +%s) -lt $end ]; do
    if [ $SYS = pgmq ]; then q="select sum(queue_length) from pgmq.metrics_all()"; else q="select coalesce(sum(pending_events),0) from pgque.get_consumer_info()"; fi
    echo "$(date +%s) $(P -Atc "$q") $(P -Atc "select coalesce(sum(n_dead_tup),0) from pg_stat_user_tables where schemaname='$SCHEMA'")" >> $OUT/backlog; sleep 10; done ) &
BPID=$!
pgbench -n --random-seed=42 -c 8 -j 4 -T $DUR -R $RATE -r -l --log-prefix=$OUT/pgb "${ARGS[@]}" "$DB_URL" > $OUT/pgbench.txt 2>&1 || true
wait $CPID $BPID $HPID $LPID 2>/dev/null || true
P -Atc "select cron.unschedule('bench_dispatch')" >/dev/null
CPU1=$(docker exec "$CONTAINER" cat /sys/fs/cgroup/cpu.stat | awk '/usage_usec/{print $2}')
P -At -F'|' -v schema=$SCHEMA -f $H/snapshot.sql > $OUT/snap1
[ -n "$LONGTX" ] && { P -Atc "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep%' and pid<>pg_backend_pid()" >/dev/null; }
echo "$CPU0 $CPU1 $RATE" > $OUT/cpu
P -At -F'|' -c "select left(regexp_replace(query,'\s+',' ','g'),90), calls, total_exec_time, mean_exec_time, max_exec_time, rows from pg_stat_statements where query ~* '(pgmq|pgque|bench)\.' order by total_exec_time desc limit 25" > $OUT/pgss
echo "done $OUT"
