# Deleted-version manifest cleanup

`on_version_update` releases the deleted version's legacy `public.manifest` rows
by moving them into `delta_files` / `version_files`
(`convert_version_manifest_rows`); onboarding demo rows are deleted in place.
The version keeps its `version_files` row, so its delta files survive the 7-day
restore window. Delta storage GC reclaims R2 objects afterwards; see
[delta storage](delta-storage.md).

One write pool runs sequential Drizzle transactions: the conversion moves the
whole version (at most 10,000 rows) at once, then leftover demo rows are deleted
in batches of at most 1,000, starting from `idx_manifest_app_version_id_file_hash`. A pass stops after 20
batches or ten seconds between batches; statements have a 15-second timeout
and lock waits a two-second timeout. Incomplete passes raise the existing cleanup
error; committed batches survive retries and the existing 15-minute sweeper
requeues remaining work. Queue reads remain capped at five. A 5,000-file bundle
needs one conversion transaction, with no per-file connections or network calls.

The last row deletion and version/app counter finalization commit together.
Retries cannot double-decrement `manifest_bundle_count`, including legacy rows
whose version count was zero. JSON manifests are cleared during finalization.
Cleanup and manifest persistence take the existing per-version advisory lock and
lock the version row. Persistence rechecks deletion while locked, so an upload
that passed its earlier route check cannot insert into a deleted version.

The manifest-file trash/delete/restore system is fully removed, including its
restore helper and `manifest_trash_restore_pending` table. The migration drops
that table and any records it contains; there is no recovery drain or replacement
collector. The sweeper only requeues database cleanup, rotates versions by their
last requeue time, and leaves counter finalization to the handler.
Sweeper retries also finish ZIP and metadata cleanup after the final database
batch, including deletions that exceeded the original five queue attempts.

Deploy the handler and drain old in-flight handlers before applying the migration
that drops the recovery table. First run the database-only
`scripts/reclaim_deleted_version_manifests.ts` with an explicit `SUPABASE_DB_URL`.
It replaces the old manual R2 trash script: it marks legacy zero-count versions
for requeue without touching objects or app counters. Its one-time scan uses the
existing `(deleted_at, id)` index in 50-version pages, shares version locks with
cleanup, preserves timestamp microseconds, and handles null deletion dates.
Each committed page saves a local checkpoint; failures retain the prior
checkpoint and write a report containing the affected version IDs. Rerun with the
same database/checkpoint to resume. `MANIFEST_REQUEUE_CHECKPOINT` can override the
default file in the temporary directory. This is a rollout operation, not a cron.

On databases with more than 10,000 versions,
prebuild the retry index using `scripts/ops/deleted_manifest_retry_index.sql`,
outside a transaction. The migration refuses an inline index build above that
size and bounds lock waits and statement duration on smaller databases.
Channel unlinking, bundle cache purge, metadata/storage-statistics updates and
canonical version-owned ZIP trash/retry remain part of version deletion.

The sweeper remains a service-role-only cron RPC, called once per sweep. Its
candidate search starts from deleted versions ordered by `updated_at, id`
(`idx_app_versions_deleted_manifest_pending`), filtered to positive counters or
legacy JSON. Finished versions leave that index; normal sweeps never probe
manifest rows or scan finished deletion history. It updates at
most the requested batch. No new RLS function, public RPC, cron, or extension is
introduced. Cleanup queries target one version; they do not scan all manifests.
