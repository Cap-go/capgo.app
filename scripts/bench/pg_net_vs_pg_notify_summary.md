# pg_net vs pg_notify for database → edge function calls

Question: can `net.http_post` (pg_net) be replaced by `pg_notify`, and what do
we gain in speed, CPU and memory?

Reproduce: `bun scripts/bench_pg_net_vs_pg_notify.ts`
(`BENCH_SINK_DELAY_MS=50 BENCH_TOTAL_TX=5000 BENCH_CLIENTS=16` for the
endpoint-latency run). Raw numbers: `pg_net_vs_pg_notify_results.json`.

## What uses pg_net today

| Caller | When | Volume |
| --- | --- | --- |
| `process_function_queue()` | `process_all_cron_tasks` tick (10 s), only for queues holding messages | ≤ 10 POSTs per queue per tick |
| `wake_updates_cache_purge()` | once per transaction that changes `/updates` inputs (statement triggers on `channels`, `apps`, `app_versions`, `orgs`, `stripe_info`) + 10 s cron while purges are due | one per business write |

Both are fire-and-forget wakes: the endpoint drains pgmq / the purge table
itself, and the 10 s cron re-sends if a wake is lost.

## What `pg_notify` needs

`pg_notify` only reaches sessions that already run `LISTEN`. Nothing in
Postgres turns it into HTTP, so a switch needs an always-on relay holding a
direct (session, not Supavisor transaction mode) connection. Capgo has no
long-running process today: Cloudflare Workers and Supabase Edge Functions
cannot hold a `LISTEN`. Notifications sent while the relay is down or
reconnecting are lost. pg_net keeps them in `net.http_request_queue`.

## Setup

- Postgres: `public.ecr.aws/supabase/postgres:17.6.1.143` with pg_net 0.20.3,
  4 CPU / 4 GB container.
- Relay: Bun + `pg`, `LISTEN` → `fetch` POST, 1 CPU / 256 MB container.
- Sink: Bun HTTP server on the same Docker network (no host NAT).
- pgbench, 20 000 transactions per run, same body and headers as
  `process_function_queue`.
  - `enqueue_only`: one `SELECT net.http_post(...)` / `SELECT pg_notify(...)`.
  - `update_plus_enqueue`: `BEGIN; UPDATE` a row; enqueue; `COMMIT` (the
    trigger shape of the cache purge wake).
- Database CPU is the whole db container cgroup (includes the pg_net worker
  and the relay's backend). Baseline is the same transaction with no enqueue.

## Results

### Write path with an enqueue (`update_plus_enqueue`)

| Clients | Variant | TPS | Avg latency | DB CPU / tx |
| ---: | --- | ---: | ---: | ---: |
| 1 | baseline | 5 432 | 0.18 ms | 0.109 ms |
| 1 | pg_net | 3 576 | 0.28 ms | 0.287 ms |
| 1 | pg_notify | 4 404 | 0.23 ms | 0.160 ms |
| 16 | baseline | 27 727 | 0.58 ms | 0.134 ms |
| 16 | pg_net | 26 137 | 0.61 ms | 0.251 ms |
| 16 | **pg_notify** | **8 315** | **1.92 ms** | 0.206 ms |
| 64 | baseline | 30 354 | 2.11 ms | 0.137 ms |
| 64 | pg_net | 24 550 | 2.61 ms | 0.256 ms |
| 64 | **pg_notify** | **8 167** | **7.84 ms** | 0.229 ms |

With concurrent writers, `pg_notify` cuts write throughput by about 3× and
triples commit latency. During the 64-client run, 61 of 64 backends waited on
`Lock:object`: one `AccessExclusiveLock` on `pg_database` object 0. That is
the single, database-wide lock NOTIFY takes in `PreCommit_Notify`, and it stays
held through the commit's WAL flush. So every transaction that notifies commits
one at a time. pg_net only inserts a row into an unlogged table and has no
global lock.

### Enqueue alone (`enqueue_only`)

| Clients | Variant | TPS | Avg latency | DB CPU / tx |
| ---: | --- | ---: | ---: | ---: |
| 1 | pg_net | 8 986 | 0.111 ms | 0.200 ms |
| 1 | pg_notify | 19 948 | 0.050 ms | 0.060 ms |
| 16 | pg_net | 83 284 | 0.192 ms | 0.140 ms |
| 16 | pg_notify | 35 663 | 0.449 ms | 0.068 ms |
| 64 | pg_net | 64 575 | 0.991 ms | 0.161 ms |
| 64 | pg_notify | 41 096 | 1.557 ms | 0.069 ms |

### Resources and delivery

| | pg_net | pg_notify + relay |
| --- | --- | --- |
| DB CPU above baseline, per request | 0.12–0.18 ms | 0.04–0.09 ms |
| Worker CPU | pg_net worker ≈ 0.055 ms / request (1.1 s per 20k) | relay backend ≈ 0.01–0.02 ms / request in Postgres, relay process ≈ 0.025–0.065 ms / request outside it |
| Memory | pg_net worker ≈ 10 MB anon, inside Postgres | relay ≈ 40 MB (separate host) + one backend |
| WAL on the write path | +9 to +16 B / tx (the queue table is unlogged) | +0 to +2 B / tx |
| Table growth | ≈ 0.5 KB / request in `net._http_response` (10 MB per 20k), truncated hourly by `cleanup_net_http_response` | none |
| Delivery of a 20k burst | ≈ 100 s: about 200 req/s, `pg_net.batch_size` (200) per worker loop | < 1 s |
| Delivery of a 5k burst, 50 ms endpoint | 25.6 s | 0.9 s |
| Relay down | requests wait in the queue | notifications lost |

## Production impact

At production volume (a few wakes per second at peak, ≤ 10 per queue per 10 s
tick), the CPU saving is about 0.1 ms per request. At 10 requests/s that is
≈ 1 ms of CPU per second, about 0.1 % of one core. Memory saved inside
Postgres: ≈ 10 MB (the pg_net worker). `net._http_response` bloat is already
handled by the hourly truncate.

In exchange, `pg_notify` would:

- serialize commits of every write that fires the `/updates` cache purge
  trigger (≈ 3× lower throughput, ≈ 3× higher commit latency under
  concurrency);
- need a new always-on service, its deploy and monitoring, and a direct
  session connection to the primary;
- lose wakes while that service is down (the 10 s cron hides it, at up to
  10 s extra delay).

Delivery latency is the one clear gain (instant versus pg_net's ≈ 1 s poll and
200 req/s cap). Neither caller needs it: both are wakes for work the 10 s cron
also triggers.

## Decision

Keep pg_net. If the pg_net delivery rate ever becomes a bottleneck, raise
`pg_net.batch_size` before adding a relay. If pg_net worker CPU matters,
coalesce wakes (the cache purge already sends one per transaction).
