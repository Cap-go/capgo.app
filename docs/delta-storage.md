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
| `delta_storage_state` | one | converter cursor. Primary only. The rollout switches are Vault secrets. |
| `delta_gc_state` | one per app | GC schedule, listing cursor, delete lease. Primary only. |

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

Plugin reads (`/updates`, `/updates/manifest_size`) prefer `version_files` when
the version row and all of its `delta_files` rows are visible, and otherwise read
legacy `manifest` rows. The response format is unchanged.

## Deletion, restore and GC

- Deleting a version keeps its `version_files` row. Legacy rows of the version
  are moved into the new tables (`convert_version_manifest_rows`).
- Restore within 7 days: clear `deleted` / `deleted_at` (and restore the bundle
  zip from `deleted-after-7-days/` if needed). The delta files are still there.
- `triggers/cron_delta_storage_gc` reclaims R2 objects per app, one listing page
  per run: objects younger than a day are skipped, paths still referenced by a
  live version, a version deleted less than 7 days ago or an in-progress upload
  are skipped, the rest is copied to `deleted-after-7-days/` and deleted.
- The R2 lifecycle rule on `deleted-after-7-days/` purges the trash, so a bad
  delete stays recoverable for 7 more days by copying the object back.

### Concurrency

Every CLI creates its `app_versions` row before any file existence check or
upload, so one rule covers concurrent uploads and GC:

- `delta_gc_begin_delete` takes an exclusive per-app transaction advisory lock,
  refuses while the app has an in-progress (`r2-direct`, younger than a day)
  version, re-checks references, deletes unreferenced `delta_files` rows and
  opens a lease of at most 2 seconds. It is the only step that authorizes R2
  deletes. The worker starts deletes only in the first 400 ms, aborts each one
  after 800 ms, then releases the lease (`delta_gc_end_delete`), so every
  request is settled before an upload can proceed.
- The `delta_gc_wait_for_lease` trigger (`BEFORE INSERT ON app_versions`) takes
  the shared side of that lock and waits out an active lease (at most 2 s,
  below the 3 s statement timeout published CLIs run under through PostgREST).
  An upload therefore either makes GC skip the app or starts after the batch.
- No transaction stays open during R2 calls. Copies happen before the lease and
  are idempotent; an interrupted batch only leaves extra trash copies.
- Two uploads of the same file share one `delta_files` row
  (`INSERT ... ON CONFLICT DO NOTHING`); identical bytes land on the same key.

## Rollout

1. **Before merge**, create the two tables on the Google subscriber. The release
   job only adds columns to existing subscriber tables and stops on a missing
   table, which guards this step. Apply the `delta_files` and `version_files`
   blocks of `read_replicate/schema_replicate.sql` (table, identity, primary key).
2. Deploy. The migration creates the tables, adds them to
   `capgo_google_eu_2_pub`, seeds `delta_gc_state` and drops the unused
   `idx_manifest_file_hash` / `idx_manifest_file_name`. Uploads write both the
   new tables and legacy rows (Vault `CAPGO_DELTA_STORAGE_LEGACY_MANIFEST_WRITES` absent = on).
3. On the subscriber:
   `ALTER SUBSCRIPTION capgo_google_eu_2_sub REFRESH PUBLICATION WITH (copy_data = true);`
   Wait until `delta_files` / `version_files` row counts match the primary.
4. Switch to the new tables only:
   `SELECT vault.create_secret('false', 'CAPGO_DELTA_STORAGE_LEGACY_MANIFEST_WRITES');`
   The `convert_legacy_manifest` cron then moves legacy rows (20 versions every
   10 seconds) and deletes them. Onboarding demo rows (`demo/` paths) stay
   legacy because `onboarding_demo_data` tracks their ids.
5. Check the R2 lifecycle rules: `deleted-after-7-days/` expires after 7 days
   (already used by bundle zips), and incomplete multipart uploads under
   `orgs/` are aborted after 1 day.
6. Enable GC: `SELECT vault.create_secret('true', 'CAPGO_DELTA_STORAGE_GC_ENABLED');`
   Apps that still have legacy rows are postponed until converted.
7. Decommission the inventory: delete the `capgo-r2-inventory-prod` worker, its
   queues (`capgo-r2-inventory-prod`, `-repair`, `-cleanup` and their DLQs), the
   `capgo` bucket notification rule, Hyperdrive `af73fa6a112b495f80e81718b153db76`,
   the PlanetScale `capgo-r2-inventory` database, and on Supabase the
   `capgo_planetscale_r2_pub` publication and its replication slot (a slot left
   behind retains WAL).
8. Once only demo rows remain in `public.manifest`, migrate the demo seeding to
   the new tables and drop `public.manifest`, which frees its storage. CLI
   8.42.x reads `manifest` directly for its AI auto-bump diff (after conversion
   it sees an empty list and suggests a larger bump); replace the table with a
   `manifest` view over `version_manifest` when dropping it.

Legacy SQL guards that inspected `manifest` rows (`channel_update_package_mismatch`,
`app_version_manifest_jsonb_unmigrated`, `null_migrated_app_version_manifests`)
also see converted rows (`delta_version_has_entry`).

Monitoring: `SELECT count(*) FROM public.manifest` shrinks after step 4;
`SELECT app_id, last_run_at, last_error FROM public.delta_gc_state WHERE last_error IS NOT NULL`
lists failing GC passes; worker logs carry `delta gc page done` per app.
