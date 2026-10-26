# pgque vs pgmq for Capgo queues

Should Capgo replace [pgmq](https://github.com/pgmq/pgmq) (1.5.1, today) with
[pgque](https://github.com/NikolayS/pgque) (0.2.2, PgQ rebuilt in PL/pgSQL)?
This page answers with production load numbers and a benchmark that replays that
load against both engines. The harness lives in
[`scripts/bench/queue_engine/`](../../scripts/bench/queue_engine/README.md).

**Short answer: not now.** pgque writes about 57% less WAL, does about 67% fewer
tuple writes and leaves almost no dead tuples, and it does not degrade when the
xmin horizon is pinned. But at Capgo's real load it uses **more** database CPU
than pgmq (2× at 1×, 1.8× at 10×, 1.25× at 50×; about equal at 100×, and only
once tuned). Its batch model also conflicts with how `queue_consumer.ts` works
(see [Migration blockers](#migration-blockers)). At today's volume pgmq's bloat
is not causing problems: autovacuum keeps every queue table at 0–50 dead tuples.

## 1. Production load (measured 2026-10-26, read-only)

Source: `pg_stat_user_tables` for the `pgmq` schema on the prod primary, 59.4
days after the last restart, plus `pg_stat_statements` (24 days). The queries
are in [`prod_load.sql`](../../scripts/bench/queue_engine/prod_load.sql).

| Metric | Value |
|---|---|
| Messages enqueued (all `q_*`) | 21.29 M in 59.4 days, **4.15 msg/s on average** |
| Live 3-minute sample | 2.1 msg/s; per-minute range 0.1–6 msg/s |
| `on_manifest_create` | 16.44 M (77% of all messages, 3.2 msg/s), sent in bursts of one message per manifest row: per bundle p50 472, mean 784, p90 1,703, max 2,685 |
| Next largest | `on_channel_update` 0.18/s, `webhook_dispatcher` 0.18/s, `cron_stat_app` 0.12/s, `channel_device_counts` 0.10/s, `on_version_update` 0.10/s, `cron_sync_sub` 0.10/s, `cron_stat_org` 0.09/s |
| Tuple writes per message | ~3.2 (INSERT + `read` UPDATE + `mass_edit_queue_messages_cf_ids` UPDATE + DELETE; `on_version_update` ≈ 4 because of retries) |
| pgmq share of all DB row writes | 69.4 M of 217 M = **32%** |
| pgmq autovacuum runs | 119 k in 59 days (~2,000/day) |
| Dead tuples right now | 0–46 per queue table; largest table `q_on_version_update` 33 MB, nearly empty |
| `pgmq.read` | 446 k calls, mean 0.96 ms, max 263 ms, 5.6 GB WAL in 24 days |

The consumer polls every 10 s (`process_all_cron_tasks` → `queue_consumer`), with
batch sizes 950 for manifests, 40 for `on_version_update`, 100 for most queues
and 10 for the per-minute cron queues.

## 2. Benchmark

**Setup.** Isolated container from `public.ecr.aws/supabase/postgres:17.6.1.143`
(same image family as prod 17.6.1.155) limited to 4 vCPU and 8 GB, with
`shared_buffers=2GB`. pgmq 1.5.1 and pgque 0.2.2 are installed side by side.
Only the engine under test runs its background jobs: pgque's pg_cron ticker,
retry and maintenance jobs are stopped during pgmq runs.

**Load model** ([`setup.sql`](../../scripts/bench/queue_engine/setup.sql)):

- 11 queues with the prod rates above. Manifest bursts follow the prod size
  distribution, payload sizes match the prod rows (`to_jsonb(NEW)` plus
  wrapper), and failure rates reproduce prod reads per message.
- The pgmq consumer is today's code path: `read` → commit → cf_ids rewrite →
  commit → `delete` for successes → commit. Failures are re-read after the
  visibility timeout.
- The pgque consumer is the closest equivalent: `next_batch` → fetch events →
  commit → `nack` the failures (retry, then DLQ after 5 attempts, matching the
  5-retry hard rule) → `ack`. Events are immutable, so the cf_ids rewrite has no
  pgque equivalent.
- Producers are `pgbench` scripts weighted by queue rate (8 clients, rate
  limited, `--random-seed=42`). The consumer polls every 10 s, as in prod. Each
  run lasts 300 s.
- Load levels: 1× (prod average), 10× (a busy-day peak), 50× and 100×
  (headroom). The longtx runs add a REPEATABLE READ transaction that pins the
  xmin horizon for the whole run, the way a long analytics query, `pg_dump` or
  a lagging replica slot would.
- pgque runs at its default 10 ticks/s and also at 1 tick/s (`tick1000`). The
  slower rate is enough because Capgo only polls every 10 s.

**Results** (CPU = whole container, cgroup `usage_usec`, divided by messages
sent; raw data in [`results.json`](../../scripts/bench/queue_engine/results.json)):

| Run | msgs | DB CPU ms / 1k msgs | WAL B / msg | tuple writes / msg | max dead tuples | vacuums | send p99 ms | consumer poll avg / max s |
|---|---|---|---|---|---|---|---|---|
| pgmq 1× | 3,649 | **1,172** | 3,996 | 3.08 | 6,267 | 6 | 14.7 | 0.06 / 0.09 |
| pgque 1× | 3,649 | 3,658 | 2,152 | 1.35 | 180 | 5 | 14.3 | 0.08 / 0.19 |
| pgque 1× tick 1 s | 3,649 | 2,508 | 2,131 | 1.31 | 158 | 5 | 17.5 | 0.07 / 0.28 |
| pgmq 10× | 17,398 | **408** | 3,937 | 3.16 | 13,081 | 48 | 15.6 | 0.07 / 0.11 |
| pgque 10× | 16,269 | 1,034 | 1,792 | 1.20 | 412 | 6 | 15.8 | 0.11 / 0.27 |
| pgque 10× tick 1 s | 17,322 | 737 | 1,795 | 1.18 | 400 | 6 | 15.6 | 0.09 / 0.23 |
| pgmq 50× | 69,537 | **257** | 3,902 | 3.21 | 29,172 | 55 | 15.0 | 0.10 / 0.17 |
| pgque 50× | 69,909 | 369 | 1,672 | 1.07 | 520 | 6 | 14.3 | 0.17 / 0.60 |
| pgque 50× tick 1 s | 71,127 | 321 | 1,674 | 1.07 | 518 | 6 | 14.5 | 0.16 / 0.34 |
| pgmq 100× | 129,786 | 248 | 3,911 | 3.23 | 60,010 | 55 | 13.9 | 0.14 / 0.20 |
| pgque 100× | 131,169 | 260 | 1,648 | 1.05 | 436 | 6 | 13.7 | 0.21 / 0.55 |
| pgque 100× tick 1 s | 133,383 | **237** | 1,651 | 1.05 | 422 | 6 | 14.0 | 0.21 / 0.55 |
| pgmq 50× + pinned xmin | 71,428 | 278 | 3,826 | 3.21 | **156,367** | 55 | 14.9 | 0.14 / 0.27 |
| pgque 50× + pinned xmin | 72,176 | 361 | 1,679 | 1.07 | 2,172 | 5 | 14.8 | 0.16 / 0.35 |
| pgque 50× + pinned xmin, tick 1 s | 75,282 | 313 | 1,682 | 1.06 | 2,130 | 6 | 14.7 | 0.16 / 0.38 |

Statement-level view (pg_stat_statements, mean ms):

- `send` costs the same on both engines: 0.05–0.08 ms.
- `pgmq.read` slows down as dead tuples pile up: 0.44 ms at 1×, 0.88 ms at 50×
  and **2.06 ms at 50× with a pinned xmin** (max 41 ms).
- `pgque.nack` costs 1.1–6 ms **per failed message**, because it writes the
  retry queue and later re-inserts the event. A pgmq failure costs nothing at
  failure time; the message is simply not deleted.
- Idle (120 s, 11 empty queues) costs the same on both engines: about 1.0 s of
  CPU. pgque writes 185 KB of WAL in that time, pgmq 601 KB.

### Reading the numbers

1. **WAL and write amplification: pgque wins clearly.** pgque writes about
   1.7 KB of WAL per message against 3.9 KB, and about 1.1 tuple writes against
   3.2, at every load level. Scaled to prod's 4.15 msg/s, that is roughly
   1.4 GB/day of WAL with pgmq against 0.6 GB/day with pgque. That saving
   matters for replication, PITR storage and the read replicas.
2. **Bloat: pgque wins clearly, but prod doesn't currently suffer from it.**
   With a pinned xmin, pgmq piled up 156 k dead tuples in 5 minutes, the
   engine's footprint grew to 282 MB against 136 MB, and `read` latency
   doubled. pgque stayed flat. In prod today autovacuum keeps up: 0–46 dead
   tuples per queue, at the cost of about 2,000 autovacuum runs per day.
3. **CPU: pgmq wins at Capgo's load.** pgque has fixed costs per tick and per
   batch, and an expensive `nack`. Capgo's retry rate is high (14–33% on the
   cron and version queues), so `nack` is a big part of the bill. pgque only
   catches up at about 100× today's load, with the ticker slowed to 1 s.
4. **Latency is the same for Capgo.** Send p99 is about 14 ms on both (most of
   that is the pgbench round trip). pgque's ≤100 ms delivery delay (≤1 s with
   tuned ticks) disappears inside the 10 s poll interval.
5. **pgque's footprint grows with retention, not bloat.** Events stay until
   table rotation (2 h by default, three tables), so at 100× the pgque schema
   holds about 240 MB of live events. That size is bounded and reclaimed by
   `TRUNCATE`, but at steady state it is larger than pgmq's near-empty tables.

## Migration blockers

Moving to pgque is more than a rename. These Capgo behaviours do not map
cleanly:

1. **Batch size is not controllable.** pgque returns the whole tick window
   ("complete batch or error"). All events from one transaction land in the
   same batch, and a single bundle upload enqueues up to ~2,700 manifest rows in
   one transaction. That breaks the 950-message cap, which exists to stay under
   Cloudflare's 1,000-subrequest limit. Workaround: page the batch with
   `get_batch_cursor` across several HTTP calls and ack only at the end. That
   adds new consumer state, and a crash redelivers the whole batch.
2. **No competing consumers on one cursor.** pgmq's visibility timeout lets
   overlapping `queue_consumer` runs take disjoint messages. With pgque, a
   second `next_batch` for the same consumer returns the **same** active
   batch, so two concurrent runs would process the same events twice. The
   options are serialising per queue (advisory lock) or using cooperative
   subconsumers, which are marked experimental in 0.2.
3. **Messages are immutable.** `mass_edit_queue_messages_cf_ids` rewrites
   messages in place to record Cloudflare request ids. That would need a side
   table or would move to logs.
4. **No delayed send.** `webhook.ts` uses `pgmq.send(queue, msg, delay)` for
   delayed webhook retries. pgque has no equivalent: we would have to abuse
   `event_retry` or add a scheduled table.
5. **Retry timing is coarse.** `nack` retries are re-injected by
   `maint_retry_events`, a pg_cron job that runs every 30 s, so per-queue
   visibility timeouts (60 s for manifests, longer for versions) become "at
   least 30 s". The 5-retry cap with a dead-letter queue maps well to Capgo's
   hard rule, though.
6. **Operational surface.**
   - pgque is a 6,000-line SQL install with no extension versioning. Upgrades
     mean re-running the file in a migration.
   - Its ticker permanently occupies one pg_cron slot. Prod runs
     `cron.max_running_jobs=32` with `cron.log_run=on`, so pgque's four jobs add
     about 100 k `cron.job_run_details` rows per day.
   - We would lose the Supabase Queues dashboard.
   - Everything that reads `pgmq.q_*` or `pgmq.a_*` directly would need
     rewriting: `/queue_health`, `cleanup_queue_messages`, the swap and vacuum
     ops scripts, about 20 Vitest suites and 15 pgTAP files, and about 78
     `pgmq.send` call sites across migrations.
   - pgque is at 0.2.x and its README positions it as an event log rather than a
     job queue.

## Recommendation

- **Keep pgmq.** At 4 msg/s its CPU cost is lower. Its bloat is real (32% of all
  DB row writes, about 2 k autovacuums a day, `read` latency sensitive to a
  pinned xmin), but it is handled today.
- **Cheaper wins first, inside pgmq:**
  1. Drop the cf_ids in-place rewrite and log the ids instead. That removes one
     UPDATE per message, about a third of pgmq's tuple writes and dead tuples.
  2. Coalesce `on_manifest_create`, which is 77% of all queue volume: one
     message per bundle or per chunk instead of one per manifest row. That
     cuts total queue writes by roughly 3–4×, more than switching engines
     would.
  3. Keep watching for long transactions and replica-slot lag, since that is
     the scenario where pgmq degrades.
- **Revisit pgque if:**
  - sustained volume grows past roughly 100× (about 400 msg/s), or
  - xmin-pinning incidents start hurting `pgmq.read` in prod, or
  - pgque ships delayed send, bounded or pageable batches and stable
    cooperative consumers.

## Reproduce

```bash
git clone https://github.com/NikolayS/pgque /tmp/pgque
scripts/bench/queue_engine/start_container.sh /tmp/pgque
scripts/bench/queue_engine/run_matrix.sh   # ~85 min, writes runs/ + prints the table
```
