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
(runs claim apps with `SKIP LOCKED` and may overlap).
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
   copies every `public.manifest` row in one pass and analyzes both tables.
   It only reads `app_versions` and `manifest`, so uploads keep running.
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
before the tables had statistics, hence the `ANALYZE`).

Size lookups queued for the view's rows are delayed 30 minutes so the new
workers, which know `delta_files`, process them; size updates through the view
are ignored (a pre-cutover lookup carries a legacy id). The migrations run
under a 5 s `lock_timeout`; a release that cannot get its locks fails and can
be retried.

Around the migrations, the release CI:

- before them, creates `delta_files` and `version_files` on the Google
  subscriber (`read_replica_schema`, `ALLOWED_NEW_REPLICA_TABLES`);
- after them, refreshes `capgo_google_eu_2_sub` with `copy_data = true` and
  waits until every replicated table finished its initial copy, then analyzes
  the newly copied tables (`read_replica_subscription`). The api, files and plugin workers deploy only
  after that, so they never read a half-copied replica. Until then the previous
  workers keep serving: they read the subscriber's now frozen `manifest` table
  and write through the compatibility view on the primary.

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
