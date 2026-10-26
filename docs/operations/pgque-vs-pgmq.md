# pgque vs pgmq for Capgo queues

Should Capgo replace [pgmq](https://github.com/pgmq/pgmq) (1.5.1, today) with
[pgque](https://github.com/NikolayS/pgque) (0.2.2, PgQ rebuilt in PL/pgSQL)?
This page answers with production load numbers and a benchmark that replays that
load. The benchmark covers the **whole queue system**, not just the two
engines:

- producers;
- the 10 s dispatcher (`process_function_queue` via pg_net);
- consumers;
- `/queue_health`;
- the hourly cleanup;
- the pg_cron run log that each scheduled job writes.

The harness lives in
[`scripts/bench/queue_engine/`](../../scripts/bench/queue_engine/README.md).

## TL;DR

At today's load (about 4 msg/s), the whole system on pgque compares to pgmq
like this:

- **WAL: about 33% less** (≈1.06 GB/day against ≈1.58 GB/day).
- **Row writes: about 22% fewer** (≈0.94 M/day against ≈1.20 M/day). Most of
  pgque's per-message savings are eaten by the pg_cron run logs of its
  1-second ticker.
- **Dead tuples: almost none.** pgque also stays flat when a long transaction
  pins the xmin horizon, while pgmq `read`, dispatch and health checks slow
  down 2–3×.
- **Worker calls: 2–3× fewer at 50–100× load**, and about the same at today's
  load.
- **DB CPU: a fixed cost of about 2% of one vCPU more** (~28 CPU-minutes/day).
  The CPU cost per message is the same on both engines.

All of these numbers are small at today's volume. The decision is therefore
about resilience and migration risk, not current cost.

Cloudflare raised the paid Workers subrequest limit to 10,000 per invocation
([changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)).
That removes the main batch-size blocker: pgque batches can't be capped, but
the largest observed manifest burst is ~2,700 messages. The other blockers
remain:

- concurrent consumers;
- immutable messages;
- no delayed send;
- cron-tick dedupe;
- coarse retry timing.

**Recommendation:** no big-bang migration. Fix two pgmq-side inefficiencies
first. If we want pgque's resilience, pilot it on `on_manifest_create` only:
that queue carries 77% of the volume and uses none of the blocked features
(see [Recommendation](#recommendation)).

## 1. Production load (measured 2026-10-26, read-only)

Sources:

- `pg_stat_user_tables` for the `pgmq` schema, 59.4 days since the last
  restart;
- `pg_stat_statements` (24 days);
- `cron.job_run_details`.

The queries are in
[`prod_load.sql`](../../scripts/bench/queue_engine/prod_load.sql).

| Metric | Value |
|---|---|
| Messages enqueued (all `q_*`) | 21.29 M in 59.4 days, **4.15 msg/s on average** (≈358 k/day) |
| Live 3-minute sample | 2.1 msg/s; per-minute range 0.1–6 msg/s |
| `on_manifest_create` | 16.44 M (77%, 3.2 msg/s). One message per manifest row, in bursts per bundle: p50 472, mean 784, p90 1,703, max 2,685 |
| Next largest | `on_channel_update` 0.18/s, `webhook_dispatcher` 0.18/s, `cron_stat_app` 0.12/s, `channel_device_counts` 0.10/s, `on_version_update` 0.10/s, `cron_sync_sub` 0.10/s, `cron_stat_org` 0.09/s |
| Row writes per message | ~3.2: INSERT + `read` UPDATE + `mass_edit_queue_messages_cf_ids` UPDATE + DELETE. ≈4 on `on_version_update` because of retries |
| pgmq share of all DB row writes | 69.4 M of 217 M = **32%** |
| pgmq autovacuum runs | 119 k in 59 days (~2,000/day) |
| Dead tuples right now | 0–46 per queue table: autovacuum keeps up |
| `process_all_cron_tasks` (every 10 s) | 206 k calls in 24 days, mean 52 ms, **3 h of DB time**. Each run also writes 1 INSERT + 4 UPDATE statements to `cron.job_run_details` |
| `/queue_health` | Two `COUNT(*)` scans per queue (`q_*` and `a_*`) about every 24 s per queue |

## 2. What changes around the engine

Each piece of the queue system has to change if we swap engines. The benchmark
models every row of this table.

| Piece | pgmq today | pgque equivalent |
|---|---|---|
| Producers (triggers, `manifest_persist.ts`, `webhook.ts`) | `pgmq.send` | `pgque.send` (same cost) |
| Dispatcher (`process_function_queue`, every 10 s) | `count(*)` on `q_<name>` (also counts invisible retrying messages), then up to 10 pg_net calls per queue | `get_consumer_info().pending_events` (index lookups), then 1 pg_net call per 10 k events |
| Consumer (`queue_consumer.ts`) | `read` → cf_ids rewrite → `delete`; failures wait for the visibility timeout | `next_batch` → events → `nack` the failures → `ack`; no cf_ids rewrite (events are immutable) |
| Retry / poison handling | `read_ct` ≤ 5, then `pgmq.archive` + `cleanup_queue_messages` | `nack` (DLQ after 5 attempts) + `pgque.maint_retry_events` every 30 s |
| Hourly cleanup (`cleanup_queue_messages`) | DELETE from `a_*` older than 2 days and `q_*` with `read_ct > 5` | `pgque.dlq_purge`; event tables are TRUNCATE-rotated by `pgque.maint` |
| `/queue_health` | COUNT scans of `q_*` and `a_*` | `get_queue_info`, `get_consumer_info`, counts on `retry_queue` and `dead_letter` |
| pg_cron jobs | `process_all_cron_tasks` (10 s) | same, **plus** `pgque_ticker` (1 s, holds one pg_cron connection), `pgque_rotate_step2` (10 s), `pgque_maint` (30 s), `pgque_retry_events` (30 s) |
| pg_cron run log | ~8.6 k runs/day | **+~104 k runs/day** (≈520 k row writes/day in `cron.job_run_details`) |
| Cron-tick dedupe (`enqueue_cron_tick`) | `EXISTS` on `q_*` where `read_ct = 0` | needs a side table or a `pending_events` check (not modelled; negligible volume) |

## 3. Benchmark

**Setup.** An isolated container from
`public.ecr.aws/supabase/postgres:17.6.1.143` (same image family as prod
17.6.1.155), limited to 4 vCPU and 8 GB with `shared_buffers=2GB`. pgmq 1.5.1,
pgque 0.2.2, pg_cron and pg_net are installed side by side. Only the engine
under test runs its background jobs.

**Load model** ([`setup.sql`](../../scripts/bench/queue_engine/setup.sql)):

- 11 queues with the prod rates above. Manifest bursts follow the prod size
  distribution, payload sizes match prod rows, and failure rates reproduce prod
  reads per message.
- Producers are `pgbench` scripts weighted by queue rate: 8 clients, rate
  limited, `--random-seed=42`.
- The pipeline runs at prod cadence:
  - dispatcher on pg_cron every 10 s (real `net.http_post` calls);
  - consumer every 10 s;
  - `/queue_health` queries every 24 s;
  - cleanup once per run, which is 12× prod frequency and biased against pgmq.
- Each run lasts 300 s. Load levels are 1× (prod average), 10× (busy-day peak),
  50× and 100× (headroom). The longtx runs add a REPEATABLE READ transaction
  that pins the xmin horizon for the whole run, as a long analytics query,
  `pg_dump` or a lagging replica slot would.
- pgque runs at its default 10 ticks/s and also tuned to 1 tick/s (`tick1000`).
  The slower rate is enough because Capgo polls every 10 s.

**Metrics:**

- **CPU:** the whole container (cgroup `usage_usec`).
- **WAL:** whole-database LSN delta.
- **All DB writes:** row inserts, updates and deletes across every schema
  (engine, `cron`, `net`, bench). pg_cron's log is counted as 5 writes per run,
  as observed in prod.
- **Worker calls:** pg_net requests the dispatcher made.

Raw data is in
[`results.json`](../../scripts/bench/queue_engine/results.json).

| Run | msgs | DB CPU s | WAL MB | engine writes / msg | all DB writes / msg | pg_cron log writes | Worker calls | max dead tuples | send p99 ms | consumer poll avg / max s |
|---|---|---|---|---|---|---|---|---|---|---|
| pgmq 1× | 3,649 | **4.9** | 14.0 | 3.08 | 3.22 | 155 | **128** | 6,234 | 16.0 | 0.06 / 0.10 |
| pgque 1× | 3,649 | 15.6 | 7.4 | 1.35 | 2.01 | 1,965 | 151 | 162 | 16.0 | 0.08 / 0.09 |
| pgque 1× tick 1 s | 3,649 | 10.8 | **7.3** | 1.33 | **1.99** | 1,960 | 150 | **154** | 19.8 | 0.07 / 0.18 |
| pgmq 10× | 17,858 | **8.4** | 67.2 | 3.16 | 3.22 | 155 | 309 | 7,505 | 12.2 | 0.07 / 0.12 |
| pgque 10× | 16,360 | 16.9 | 28.0 | 1.21 | 1.38 | 1,965 | **276** | **376** | 11.0 | 0.10 / 0.28 |
| pgque 10× tick 1 s | 16,729 | 13.5 | 28.5 | 1.20 | **1.37** | 1,965 | 316 | 382 | 11.9 | 0.11 / 0.25 |
| pgmq 50× | 73,975 | **17.8** | 276.8 | 3.20 | 3.23 | 155 | 754 | 40,396 | 11.2 | 0.10 / 0.17 |
| pgque 50× | 67,078 | 25.4 | **106.5** | 1.07 | 1.12 | 1,965 | 331 | 446 | 10.3 | 0.16 / 0.59 |
| pgque 50× tick 1 s | 70,357 | 21.3 | 112.2 | 1.07 | **1.11** | 1,960 | **329** | **436** | 10.0 | 0.15 / 0.42 |
| pgmq 100× | 133,048 | **26.6** | 493.7 | 3.22 | 3.25 | 155 | 1,135 | 59,434 | 10.7 | 0.15 / 0.35 |
| pgque 100× | 133,504 | 34.1 | 210.2 | 1.05 | 1.07 | 1,960 | 332 | **440** | 10.6 | 0.19 / 0.52 |
| pgque 100× tick 1 s | 129,837 | 31.8 | **203.7** | 1.05 | **1.07** | 1,960 | **327** | 494 | 10.2 | 0.21 / 0.64 |
| pgmq 50× + pinned xmin | 74,932 | **19.0** | 273.8 | 3.20 | 3.23 | 155 | 691 | **160,574** | 10.2 | 0.14 / 0.34 |
| pgque 50× + pinned xmin | 69,852 | 23.9 | 111.5 | 1.07 | 1.11 | 1,960 | 332 | 2,180 | 9.5 | 0.18 / 0.49 |
| pgque 50× + pinned xmin, tick 1 s | 69,770 | 21.8 | **111.4** | 1.07 | **1.11** | 1,965 | **333** | **2,126** | 10.3 | 0.15 / 0.32 |

The 1× run sent 3,649 messages in 300 s (12 msg/s) rather than the prod average
of 4.15 msg/s. A few large manifest bursts landed in that window.

Statement-level view (pg_stat_statements, mean ms):

| | pgmq 50× | pgmq 50× + pinned xmin | pgque 50× tick 1 s | pgque 50× + pinned xmin, tick 1 s |
|---|---|---|---|---|
| dispatcher run | 12.1 | **35.2** | 6.9 | 6.4 |
| `/queue_health` run | 14.7 | **20.5** | 6.4 | — |
| consumer `read` | 0.91 | **2.18** | — | — |
| `pgque.nack` (per failed message) | — | — | 1.26 | 1.28 |
| pgque ticker run | — | — | 5.2 | 5.5 |

At the default 10 ticks/s, each `pgque_ticker` run is a ~930 ms loop. It keeps
one pg_cron connection busy almost permanently, and prod has
`cron.max_running_jobs=32`.

### Projected to prod's 4.15 msg/s

Fitting fixed + per-message cost to the 1× and 100× runs (pgque tuned to
1 tick/s):

| Per day | pgmq | pgque | Difference |
|---|---|---|---|
| WAL | ≈1.58 GB (0.26 GB fixed + 3.7 KB/msg) | ≈1.06 GB (0.50 GB fixed + 1.6 KB/msg) | **−33%** |
| Row writes | ≈1.20 M (≈1.15 M queue + ≈0.04 M pg_cron log) | ≈0.94 M (≈0.38 M queue + ≈0.56 M pg_cron log) | **−22%** |
| DB CPU | baseline | +≈1,700 CPU-s/day fixed (≈2% of one vCPU); same marginal cost per message (≈0.17 ms) | pgmq cheaper |
| Worker calls | about equal at 1× | about equal at 1×; 2–3× fewer from 50× | pgque at scale |
| Dead tuples / autovacuum | ~2,000 autovacuums/day, 32% of DB row writes are queue churn | ~none | pgque |

pgque has a higher fixed cost (ticker, rotation and pg_cron logging) and a
lower cost per message. Its advantage therefore grows with load. At today's
load it is modest in WAL and writes, and slightly negative on CPU.

## 4. Impact of the 10 k subrequest limit

`queue_consumer.ts` caps reads at 950 messages "to stay under 1,000 fetches".
On the paid plan the default is now 10,000 subrequests per invocation, and it
can be raised through `limits.subrequests` in `wrangler.jsonc`.

- **For pgque:** batch size can't be capped, because all events from one
  transaction are delivered together. The largest observed manifest burst is
  ~2,700 messages, which now fits in one invocation. The consumer can stop
  between batches to stay under 10 k per call. The only remaining edge case is
  a single transaction that enqueues more than 10 k events, such as a bundle
  with more than 10 k changed files. It would need `get_batch_cursor` paging
  or a raised `limits.subrequests`.
- **For pgmq:** the same change lets us raise `DEFAULT_BATCH_SIZE` from 950
  toward ~9,500. That reduces `read`/`delete` calls and dispatcher fan-out
  (fewer pg_net calls, since today `calls_needed = ceil(count / batch_size)`
  capped at 10). This is a free win on the current engine, bounded by Worker
  CPU and wall time.

## 5. Remaining migration blockers

1. **Competing consumers.** The dispatcher fires up to 10 parallel Worker calls
   per queue, and pgmq's visibility timeout gives each call disjoint messages.
   With pgque, concurrent `next_batch` calls for the same consumer return the
   **same** batch. We would have to serialise with an advisory lock (one call
   per queue at a time) or use cooperative subconsumers, which are
   experimental in 0.2.
2. **Messages are immutable.** `mass_edit_queue_messages_cf_ids` rewrites
   messages to record Cloudflare request ids. That would move to logs or a
   side table.
3. **No delayed send.** `webhook.ts` uses `pgmq.send(queue, msg, delay)`.
4. **Coarse retry timing.** `nack` retries are re-injected by
   `maint_retry_events` every 30 s, so per-queue visibility timeouts (120 s or
   900 s today) become "next maintenance pass after the delay". The 5-retry cap
   with a DLQ matches Capgo's hard rule.
5. **Cron-tick dedupe.** `enqueue_cron_tick` looks inside `q_*` for an unread
   identical message. pgque needs a different dedupe mechanism.
6. **Operational surface.**
   - pgque is a 6,000-line SQL install with no extension versioning. Upgrades
     mean re-running the file.
   - Its jobs occupy pg_cron slots and add the ~104 k runs/day to the cron log.
   - We would lose the Supabase Queues dashboard.
   - Everything that reads `pgmq.q_*` or `pgmq.a_*` would need rewriting:
     `/queue_health`, `cleanup_queue_messages`, `enqueue_cron_tick`, the ops
     scripts, about 20 Vitest suites, about 15 pgTAP files and about 78
     `pgmq.send` call sites.
   - pgque is at 0.2.x.

## Recommendation

1. **Cheap wins on pgmq now:**
   - Raise consumer batch sizes for the 10 k subrequest limit.
   - Make the dispatcher count only visible messages (`WHERE vt <= now()`), so
     retrying messages stop triggering empty Worker calls.
   - Drop the cf_ids in-place rewrite (log the ids instead). That removes one
     UPDATE per message, about a third of pgmq churn.
   - Coalesce `on_manifest_create` to one message per bundle or chunk instead
     of one per manifest row. That cuts total queue writes about 3–4×.
2. **If we want pgque's resilience** (no dead tuples, immune to a pinned
   xmin), pilot it on `on_manifest_create` only:
   - It is 77% of the volume.
   - It has no delayed sends and no cf_ids rewrite, retries only 0.3% of
     messages, and its bursts fit the new 10 k limit.
   - Run pgque at 1 tick/s, and serialise its consumer with an advisory lock.
   - Keep pgmq for the low-volume queues that use delays, dedupe or edits.
3. **Full migration** becomes worth revisiting if:
   - sustained volume grows past roughly 50–100× (200–400 msg/s), where the
     write, WAL and Worker-call savings dominate; or
   - xmin-pinning incidents start hurting dispatch, health checks or `read` in
     prod.

## Reproduce

```bash
git clone https://github.com/NikolayS/pgque /tmp/pgque
scripts/bench/queue_engine/start_container.sh /tmp/pgque
scripts/bench/queue_engine/run_matrix.sh   # ~85 min, writes runs/ + prints the table
```
