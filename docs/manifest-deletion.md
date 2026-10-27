# Deleted-version manifest cleanup

Deleting a version keeps its `version_files` row, so its delta files survive
the 7-day restore window; delta storage GC reclaims the R2 objects afterwards
(see [delta storage](delta-storage.md)). `on_version_update` only finalizes the
version's counters: one short transaction on one write pool sets
`manifest_count` to 0 and decrements `apps.manifest_bundle_count` once
(retries cannot double-decrement). An inline `app_versions.manifest` is cleared
only when the version has a `version_files` row; otherwise it is the only
reference GC sees, so it stays. Statements have a 15-second timeout and lock
waits a two-second timeout. There are no per-file connections or network calls.

Cleanup and manifest persistence take the existing per-version advisory lock and
lock the version row. Persistence rechecks deletion while locked, so an upload
that passed its earlier route check cannot add references to a deleted version.

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
