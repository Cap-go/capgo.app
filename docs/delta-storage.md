# Delta storage

Delta (manifest) bundles store each file once per app in R2 and reference it from
every version that ships it. This replaces the per-file-per-version
`public.manifest` table and the separate R2 inventory system (PlanetScale
database, `capgo-r2-inventory` worker, five queues, bucket notifications,
reservations and leases).

## Data model

| Table | Rows | Purpose |
| --- | --- | --- |
| `delta_files` | one per unique `(s3_path, file_name, file_hash)` | path, hash, size. Deduplicated across versions through `entry_key`. |
| `delta_sessions` | one per `(app_id, session)` | Upload session bytes, referenced by `delta_files.path_session_id`. |
| `version_files` | one per version | `file_ids bigint[]`: the ordered `delta_files` ids of the version. Written once, never rewritten. |
| `version_manifest` (view) | per version entry | Console, CLI, download links and preview read one version through RLS. |
| `manifest` (view) | per version entry | Compatibility only: published CLIs read it (AI version bump). Users can only read it. |
| `delta_gc_state` | one per app | GC schedule, listing cursor, delete lease. Primary only. |

The `public.manifest` table is gone. The migration copied every row into the
new tables and replaced the table by a view with the same columns (`id` is now
the `delta_files` id). `INSTEAD OF` triggers keep the previous workers working
while a deploy rolls out: an insert becomes a shared `delta_files` row appended
to the version's list (and queues its size lookup if unsized), an update fills a
missing size, and a delete is ignored (GC owns file removal).

An upload writes one `version_files` row plus only the files the app never
stored before, instead of one `manifest` row per file. `delta_files` and
`version_files` use default replica identity and replicate to the read replicas;
their secondary indexes and the GIN index stay on the primary
(`REPLICA_EXCLUDED_INDEXES`).

Physical paths are unchanged: `orgs/<org>/apps/<app>/delta/[<session>/]<sha>_<name>`.
Every published CLI, including the oldest supported one, keeps uploading
through `bundle/upsert` or the PostgREST `app_versions` upsert,
`request_manifest_upload`, `/files/read` existence checks, TUS and
`set_manifest`. Only the server side changed: `request_manifest_upload` always
returns the deterministic paths and never reserves anything.

Plugin reads (`/updates`, `/updates/manifest_size`) serve a version's list only
when its `version_files` row and all of its `delta_files` rows are visible on
the replica. The response format is unchanged.

## Compact rows

About 70% of a `delta_files` row used to be two hex strings: `s3_path` repeats
the org, the app id, the upload session (encrypted bundles, up to ~470
characters) and the file name, and `file_hash` is hex text (64 or ~512
characters). A row in the usual shape is stored as parts:

```
s3_path   = 'orgs/<path_org>/apps/<app_id>/delta/[<hex path_session>/]<hex path_sha>_<file_name>'
file_hash = encode(file_hash_bin, 'hex')
```

with `s3_path` / `file_hash` set to `''`. Every other shape keeps its text:
legacy `orgs/<org>/apps/<app>/<version>/<file>` paths, `demo/` paths, a file
name that does not end the path, upper-case hex, base64 hashes. A row is only
compacted when the rebuilt value equals the stored one, so the rule is
lossless for any path. On production data (3% sample) 99.6% of paths and
99.95% of hashes compact, and the two columns shrink from about 688 to 316
bytes per row.

Readers always go through the rebuild: `public.delta_file_s3_path(...)` and
`public.delta_file_hash(...)` on the primary (views `version_manifest` and
`manifest`, GC, restore and compatibility triggers), and the same expressions
inlined in `utils/version_manifest_sql.ts` on the replicas, which have no
functions. The size lookup worker reads the path from the row, not from the
queued message.

Writers keep inserting text. The `delta_files_compact` cron task (every
10 seconds, 2,000 rows) compacts new rows in id order once they are 10 minutes
old; its cursor is `backfill_progress` (`job_name = 'delta_files_compact'`).
The initial catch-up is complete on production. The old
`delta_files_compact_all` procedure is removed because PostgreSQL procedures
that commit cannot also pin `search_path`. New installations catch up through
the scheduled task, or repeatedly call `SELECT public.delta_files_compact(20000)`
from separate transactions. Compaction requires the Vault setting
`CAPGO_DELTA_FILES_COMPACT_ENABLED`; enable it after all readers support
compacted rows. Progress is in `backfill_progress`.

### Shared upload sessions

Encrypted uploads repeat the same session in each file's path. Sessions now
live in `delta_sessions (id int4, app_id, session bytea)`, with a primary key
and a primary-only unique index on `(app_id, session)`. A file stores a nullable
`path_session_id int4`; replicas resolve it by primary key. Sessions are scoped
to an app and cascade on app deletion. They use the same statement-level,
caller-scoped RLS readable-app set as `delta_files`.

Readers resolve `COALESCE(delta_files.path_session, delta_sessions.session)`.
The old bytea column remains nullable during rollout and becomes NULL as rows
move. Dropping it requires a later release, after every previous reader and
writer is retired. No public response or CLI protocol changes.

Deployment order:

1. CI creates the session table and adds the file reference column on the
   subscriber before the primary migration. Only the primary keeps the unique
   session index. The migration publishes `delta_sessions`.
2. CI refreshes the subscription and waits for the table copies before
   deploying API, files and plugin workers. All readers understand both forms.
3. Once those workers are deployed everywhere, enable the Vault setting:
   `SELECT vault.create_secret('true', 'CAPGO_DELTA_SESSIONS_ENABLED');`
   If it exists, use `vault.update_secret` instead.
4. The existing cron dispatcher calls `delta_sessions_move(5000)` every
   10 seconds. It scans by `delta_files_pkey`, records its cursor in
   `backfill_progress`, and moves only each batch. The compactor attaches
   sessions from newly compacted rows under the same switch. An interrupted
   batch rolls back; the next invocation resumes at the committed cursor.
5. Check progress with
   `SELECT last_processed_id FROM public.backfill_progress WHERE job_name = 'delta_sessions_move';`
   Compare it with `SELECT max(id) FROM public.delta_files`.

Nothing rewrites rows during migration. Keep the setting off until the worker
rollout and replica synchronization finish. Turning it off stops further moves;
rows already moved continue to need the new readers.

Plain `VACUUM (ANALYZE, TRUNCATE FALSE) public.delta_files` makes freed heap
space reusable without requesting a table truncation lock. It does not shrink
the heap file. `REINDEX TABLE CONCURRENTLY public.delta_files` can reclaim index
bloat, using psql outside a transaction. Run maintenance separately on the
primary and subscriber. A heap rewrite needs a maintenance plan; this release
performs none.

### Query cost and validation

The session RLS policy calls `app_versions_readable_app_ids()` in an InitPlan
once per statement for `anon` and `authenticated`. The helper starts from the
caller identity and indexed role bindings. Session writes are internal only.
`delta_sessions_move` scans at most 5,000 file ids per scheduled invocation
through `delta_files_pkey`. If compaction creates inline sessions while the
session switch is paused, it rewinds the session cursor before that batch so
re-enabling the switch revisits those ids through the same bounded index path.
`delta_sessions_attach` selects and updates only
those ids, using `delta_sessions_app_id_session_idx` for session identity.
The existing entry-validation RPC starts with `delta_files_path_key_idx` and a
single `version_files_pkey` lookup. Restore work starts with one version's
file-id array. Plugin reads use only replicas and join `delta_sessions_pkey`;
they make no new primary-database request or permission-function call.

Local PostgreSQL 17 validation used synthetic data, one million file rows,
40% with 368-byte inline sessions, 4,000 shared sessions, and callers with
100 orgs and 4,000 apps. Compact copies occupied 434,118,656 bytes with inline
sessions and 290,390,016 bytes after sharing, including the new session table
and all its indexes. File secondary indexes are unchanged and excluded from
both copies. This measures reusable storage; it does not mean an in-place
backfill shrinks the production heap file.

For a 5,000-file manifest, six warm `EXPLAIN (ANALYZE, BUFFERS)` runs had median
execution times of 5.3 ms with inline sessions and 7.5 ms with shared sessions.
The plans used indexed version/file/session lookups, with no scan over the
million-row file table. Moving the 400,000 inline sessions in 5,000-id batches
took 6.8 seconds in total. Both samples use the new reader: this compares
inline and shared session storage, not the previous release's SQL against this
PR. These are local measurements, not production endpoint latency guarantees.
The extra session lookup runs only on a manifest-cache miss; up-to-date checks
skip the manifest query, and cached manifests return before it runs. Concurrent
cache-miss load and production p95/p99 latency remain unmeasured.

RLS `limit=1` checks took 0.8 ms for unauthenticated and invalid-key callers,
7.5 ms for a broad API key, 5.3 ms on its app-filtered control query, and
15.7 ms for the user with many orgs/apps. Their readable-app InitPlan ran once;
none scanned the large file table. The planner scanned the small, 4,000-row
session table. Eight parallel broad-key requests completed in 14-29 ms while
an unrelated org query completed in 7.5 ms, including driver scheduling.

## Deletion, restore and GC

- Deleting a version keeps its `version_files` row; only its counters change.
- Restore within 7 days: clear `deleted` / `deleted_at` (and restore the bundle
  zip from `deleted-after-7-days/` if needed). The delta files are still there,
  and `delta_restore_version_manifest_count` gives back `manifest_count` and
  `apps.manifest_bundle_count`, which `/updates` checks before reading files.
- Objects are matched under every spelling `/files/read` accepts for one key
  (a leading-dot segment as `.` or `%2E`, encoded or decoded names): an object
  is only deleted when none of its spellings is referenced.
- `triggers/cron_delta_storage_gc` reclaims R2 objects per app, one listing page
  per run: objects younger than a day are skipped, paths still referenced by a
  live version, a version deleted less than 7 days ago or an in-progress upload
  are skipped, the rest is copied to `deleted-after-7-days/` and deleted.
  A pass lists the current owner's prefix and every former owner's prefix
  found in the app's `delta_files` paths (app transfers do not move objects).
  Seen prefixes are kept in `delta_gc_state.known_orgs`; a page with a failed
  delete is listed again.
  Deleting an app records those former-owner prefixes first
  (`delta_gc_orphan_prefixes`); GC then trashes and deletes them page by page
  through the same copy, lock and lease (`delta_gc_begin_orphan_delete`), and
  drops a prefix whose app id exists again in that organization.
  `on_app_delete` already removes the current owner's prefix.
- GC postpones an app while a version that keeps its files (live or deleted
  less than 7 days ago) still has an inline `app_versions.manifest` without a
  `version_files` row: GC cannot look those paths up.
- The R2 lifecycle rule on `deleted-after-7-days/` purges the trash, so a bad
  delete stays recoverable for 7 more days by copying the object back.

### Throughput and platform limits

One run per minute, 9 s of work. Apps are claimed in groups of 5 until the
budget is spent, one listing page each, so apps with an empty or small prefix
cost one list call and a run covers many apps. R2 calls run 6 at a time: a
Worker keeps at most 6 outbound connections waiting and queues the rest, so
higher concurrency would only push deletes past their abort deadline. Copies and
deletes are a few hundred objects per run (several hundred thousand per day),
well under the 10,000 subrequests a Worker invocation may make. R2 has no
request-rate limit on these calls besides 1 write per second per key, and
every key is copied or deleted once per run. The `capgo` bucket held about
9.7 million objects (2.1 TB) at rollout, so a first full drain takes days to a
few weeks; to speed it up, schedule the `delta_storage_gc` queue task more often
(runs claim apps with `SKIP LOCKED` and may overlap). The run is an ordinary
`cron_tasks` queue task, so its wakeup goes through `http_dispatch_post`: pg_net
by default, or the QueueDispatcher Durable Object once `http_dispatch_targets`
routes `cron_delta_storage_gc` (or `*`).
Pages skipped because the app had an upload in progress are retried by the
next weekly pass.

### Concurrency

Every CLI creates its `app_versions` row before any file existence check or
upload, so one rule covers concurrent uploads and GC:

- `delta_gc_begin_delete` takes an exclusive per-app transaction advisory lock,
  refuses while the app has an in-progress (`r2-direct`, younger than a day)
  version, re-checks references, deletes unreferenced `delta_files` rows and
  opens a lease of at most 2 seconds. It is the only step that authorizes R2
  deletes, and it records every authorized path in
  `delta_gc_unsettled_deletes` in the same transaction; a path leaves that
  table only once R2 confirmed its delete (`delta_gc_confirm_deleted`), so a
  crashed run still leaves a repair record. The worker starts deletes only in the first 400 ms, aborts each one
  after 800 ms. The lease is released early (`delta_gc_end_delete`) only when
  R2 confirmed every delete; otherwise it runs to its end. R2 does not bound
  when an aborted DELETE completes, so unconfirmed deletes are recorded
  (`delta_gc_unsettled_deletes`). Each one a version references again is
  checked about 1 minute, 1 hour and 1 day later and restored from its trash
  copy whenever it is missing. New object keys per upload are not an option:
  published CLIs choose and reuse paths themselves.
  Known limitation: until the next check, a late DELETE can leave a reused key
  missing, so a download of that file can fail. The last check, 1 day after the
  delete, assumes that R2 does not apply an aborted DELETE later than that.
- The `delta_gc_wait_for_lease` trigger (`BEFORE INSERT ON app_versions`, and
  `BEFORE UPDATE` of an `r2-direct` row for a resumed upload's upsert) takes
  the shared side of that lock and waits out an active lease (at most 2 s,
  below the 3 s statement timeout published CLIs run under through PostgREST).
  An upload therefore either makes GC skip the app or starts after the batch.
- No transaction stays open during R2 calls. Copies happen before the lease and
  are idempotent; an interrupted batch only leaves extra trash copies.
- Two uploads of the same file share one `delta_files` row
  (`INSERT ... ON CONFLICT (entry_key) DO UPDATE`, which only fills a missing
  size); identical bytes land on the same key.
- `set_manifest` takes the shared side of the per-app GC lock and rechecks that
  the version is still `r2-direct`, so references are never added to a version
  GC no longer treats as in progress.

## Rollout

Five migrations, one release, each its own short transaction so no slow work
runs while `apps` or `app_versions` are locked:

1. `delta_storage_backfill` creates `delta_files` and `version_files`,
   copies every `public.manifest` row in batches of 50 versions and analyzes
   both tables. It only reads `app_versions` and `manifest`, so uploads keep
   running. Each batch ends with a progress `NOTICE`: the deploy runner drops a
   pooler connection that stays silent for about 4 minutes, which is how the
   first production attempt (one multi-minute statement over 9.7M rows) failed
   and rolled back.
2. `delta_storage_v2` drops the PlanetScale replication of the old inventory
   (`capgo_planetscale_r2_pub` and the `capgo_planetscale_r2_slot` slot; it
   terminates the slot's walsender and fails rather than leave a slot that
   would retain WAL) and adds policies, GC tables, triggers and functions.
3. `delta_storage_cutover` locks `manifest`, converts the versions uploaded
   since the backfill (found through indexes, no table scan), drops the table
   and creates the compatibility view.
4. `delta_storage_keys` adds the foreign keys as `NOT VALID` (brief locks).
5. `delta_storage_validate` removes rows whose app or version was deleted
   during the backfill, validates the keys without blocking writes, and queues
   size lookups for unsized files.

Measured on a local copy at half the production size (4.87M `manifest` rows,
4.4 GB, 1.24M unique files, production path and hash widths): the five
migrations take 34 s together (backfill 30 s, the others 1-2 s each) with
under 80 MB of backend memory, and the data shrinks to about 1 GB. The key
functions are plpgsql: as SQL-language functions they kept about 1 kB per row
until the statement ended, and the backfill ran out of memory. On that data,
reading one 633-file version for `/updates` takes 29 ms, an upload's two
writes 43 ms, and GC's reference check of a 1,000-object page 18 ms (52 s
before the tables had statistics, hence the `ANALYZE`). Batched, a local copy
of 5M rows converts in 34 s with a notice about every 0.4 s.

`delta_canonical_path` and `delta_path_key` are `PARALLEL RESTRICTED`: on
PostgreSQL 17 a parallel worker that has taken the function's `EXCEPTION`
branch (a path that is not valid UTF-8 once decoded) returns later paths
undecoded, so a parallel scan would store wrong path keys.

Size lookups queued for the view's rows are delayed 30 minutes so the new
workers, which know `delta_files`, process them; size updates through the view
are ignored (a pre-cutover lookup carries a legacy id). The migrations run
under a 5 s `lock_timeout`; a release that cannot get its locks fails and can
be retried.

Around the migrations, the release CI:

- before them, creates `delta_files` and `version_files` on the Google
  subscriber (`read_replica_schema`, `ALLOWED_NEW_REPLICA_TABLES`);
- after primary migrations, production deploy runs
  `bun scripts/sync-read-replica-schema.ts --check-subscription-publication`,
  which compares Supabase `pg_publication_tables` for `capgo_google_eu_2_pub`
  to eu-2 `pg_subscription_rel` for `capgo_google_eu_2_sub`. CI does not run
  `REFRESH PUBLICATION` or wait for initial copies. When the deploy logs a
  warning listing missing tables, operators must manually run
  `ALTER SUBSCRIPTION capgo_google_eu_2_sub REFRESH PUBLICATION WITH (copy_data = true);`
  on eu-2, wait until each listed table finishes its initial copy, then analyze
  those tables before relying on them in production. API, files, and plugin
  workers still deploy after `supabase_deploy`; the warning is operational signal
  only. Until new tables are copied, previous workers keep serving: they read
  the subscriber's now frozen `manifest` table and write through the compatibility
  view on the primary.

After the deploy:

1. Check the retired inventory worker's logs show its cleanup health failing.
2. Check the R2 lifecycle rules: `deleted-after-7-days/` expires after 7 days
   (already used by bundle zips), and incomplete multipart uploads under
   `orgs/` are aborted after 1 day.
3. Enable GC: `SELECT vault.create_secret('true', 'CAPGO_DELTA_STORAGE_GC_ENABLED');`
   (if the secret exists: `SELECT vault.update_secret(id, 'true') FROM vault.secrets WHERE name = 'CAPGO_DELTA_STORAGE_GC_ENABLED';`).
4. Decommission the inventory: delete the `capgo-r2-inventory-prod` worker, its
   queues (`capgo-r2-inventory-prod`, `-repair`, `-cleanup` and their DLQs), the
   `capgo` bucket notification rule, Hyperdrive `af73fa6a112b495f80e81718b153db76`
   and the PlanetScale `capgo-r2-inventory` database (its subscription only
   retries and fails since the migration).
5. On the Google subscriber, drop the frozen `public.manifest` table once the
   new workers serve (`DROP TABLE public.manifest;`); nothing reads it anymore.
6. Once the previous API workers are replaced, drop the unused receipt summary
   table on the primary: `DROP TABLE public.manifest_per_version;` (the old
   workers still write it during the deploy).

The 14 GB of the old table are freed by the drop itself.

Legacy SQL guards that inspected `manifest` rows (`channel_update_package_mismatch`,
`app_version_manifest_jsonb_unmigrated`, `null_migrated_app_version_manifests`)
read the new tables (`delta_version_has_entry`). Onboarding demo seeding writes
demo entries (`demo/` paths) to the new tables; `reset_onboarding_demo_app_data`
removes them with the demo versions.

Monitoring: `SELECT app_id, last_run_at, last_error FROM public.delta_gc_state WHERE last_error IS NOT NULL`
lists failing GC passes; worker logs carry `delta gc page done` per app.
