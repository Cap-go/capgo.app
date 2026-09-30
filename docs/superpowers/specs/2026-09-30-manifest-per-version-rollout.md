# Deferred manifest-per-version rollout

**Status:** Deferred design; no runtime, CLI, publication, or schema change in this document.

## Decision

Do not integrate `@capgo/manifest-packing` into CapGo now. The work is not a
current monthly-growth priority. Encoding while the existing per-file `manifest`
table remains the replica read path would temporarily replicate **both** formats,
increasing rather than reducing replication traffic and storage. Other recent
changes have already reduced that cost. Reconsider only with measured benefit,
capacity for a bounded migration, and a reason to prioritize it over growth work.

The separately proposed replication-exclusion change keeps
`manifest_per_version` on the Supabase primary but removes it from the
Supabase → Google EU2 publication and selected subscriber schema. The table and
its receipt-summary writes are **not** deleted. Verify that deployment before
relying on the exclusion. Any future plugin read from it requires a deliberate
distribution plan; plugin endpoints must never fall back to the primary
Supabase database.

## Current contracts to preserve

| Component | Current behavior | Consequence |
| --- | --- | --- |
| `private/set_manifest` | Verifies a receipt for **every** entry when any receipt is present. On initial insert, receipt-backed rows get trusted sizes; legacy rows start with size `0` and queue R2 size lookup. Existing manifest rows are not rewritten by a later receipt-bearing retry. | Missing receipts do not prove a size. A zero is not a completion signal: a valid empty file can also have size `0`. |
| `manifest_per_version` | An initial receipt-backed insert writes a `format_version = 0` summary with `size_receipts_provided = true`, count and total; both binary packets/hashes are empty or null. A receipt-bearing retry after legacy rows already exist writes neither this summary nor trusted sizes. | Format `0` is **not** a decodable packed manifest. Versions without a summary remain on the legacy read/backfill path. |
| `private/finalize_bundle_upload` | Authorizes and changes `app_versions.storage_provider` from `r2-direct` to `r2`; an `r2` retry is idempotent. The CLI's `useNewFinalizeBundleUpload` config is currently `false`, so its legacy finalization path remains in use. | Finalization currently does not check packed-manifest readiness. That flag is not an encoding rollout flag. |
| `/updates` and `/updates/manifest_size` | Read per-file `public.manifest` data from a regional Google replica. Other consumers, including deletion/GC, also use those rows. | A primary-only binary row cannot replace their data source. Preserve the existing plugin response and file-size behavior for old plugins. |
| `@capgo/manifest-packing` | Wire `format_version = 1`; `packManifest(entries, { encodeSize: true })` returns the main packet, size packet, both hashes, count, and total. `unpackManifest` validates them. `packSizeManifest` supports a later size sidecar when needed. | The library packs data; it does **not** validate CapGo upload receipts, authorize versions, or distribute data to replicas. |

See [`set_manifest.ts`](../../../supabase/functions/_backend/private/set_manifest.ts),
[`manifest_persist.ts`](../../../supabase/functions/_backend/utils/manifest_persist.ts),
[`finalize_bundle_upload.ts`](../../../supabase/functions/_backend/private/finalize_bundle_upload.ts),
[`config.ts`](../../../supabase/functions/_backend/private/config.ts),
[`update.ts`](../../../supabase/functions/_backend/plugin_runtime/utils/update.ts),
and the [packing library](https://github.com/Cap-go/manifest-packing).

## Preferred future sequence, only if the benefit justifies it

| Gate | Change to make later | Proof before advancing |
| --- | --- | --- |
| 1. Measure and choose distribution | Measure primary WAL, Supabase → EU2 logical bytes, downstream Google storage/WAL, read latency, and manifest row counts. Choose a replicated packed table or another regional delivery mechanism. | A credible end-to-end cost model includes the temporary dual-format period, decode CPU/memory, backfill, and R2 lifecycle work; not just byte-per-entry savings. |
| 2. Close the legacy-upload boundary | Observe receipt coverage by published CLI version. Ship a minimum CLI version/explicit deprecation policy only when the still-published CLI contract permits it. Keep the legacy size queue and row reader until then. | No supported uploader can finalize without complete, server-verified per-file receipts. Old **versions** already stored still need a bounded backfill or permanent fallback even after old CLIs stop uploading. |
| 3. Make writes atomic and idempotent | After receipt verification and path/entry validation, encode the complete version with `packManifest(..., { encodeSize: true, context })`. In the manifest transaction, replace the format-0 placeholder for that immutable `version_id` with format-1 packets and metadata. Gate finalization on durable, complete data; retry must compare/reuse the same version, not create a divergent packet. | Count, version ID, paths, hashes, verified sizes, total, and both packet hashes agree after `unpackManifest`; invalid/incomplete entries never make a version serveable. Handle signed zero-size receipts correctly. |
| 4. Prepare regional reads | If using the Google replica, restore the table to the EU2 publication and subscriber schema **before** any plugin read uses it; allow the copy/backfill to reach every downstream region. Add bounded decode to `/updates` and `/updates/manifest_size`, preserving their existing output, authorization, and file-size semantics. | Every region can read a full format-1 version locally, with memory/CPU limits and cache/admission behavior measured under production-like concurrency. No request-path Supabase fallback. |
| 5. Canary and retain rollback | Shadow-compare packed and per-file reads first. Then gate packed reads for receipt-backed versions only, gradually increasing exposure; keep `public.manifest` rows and the old reader available. A separate runtime flag is needed; the current CLI finalization flag is not sufficient. | Responses match for legacy/delta paths, encryption variants, zero-size files, and large manifests. Failure flips the read flag back without changing already-served versions. |
| 6. Complete the cost cutover | Migrate every remaining reader and writer, including size lookup, deletion, R2 reference/GC, audits, and repair tooling. Backfill or expire pre-receipt versions. Only then stop producing per-file rows, remove `public.manifest` from publication, and plan its storage cleanup separately. | No supported path needs the old table; replicas and rollback window are healthy. Measure actual billing before claiming savings. |

This is a sequence of future, separately reviewed changes, **not** a plan to
enable the binary table immediately. Re-adding it to a publication while
per-file rows are still replicated creates a dual-replication window. Keep that
window short and sized from measured data; do not assume a schema-only change
delivers savings. Coordinate eventual per-file row removal with the
[R2 delta-manifest object lifecycle proposal](2026-09-30-r2-manifest-object-lifecycle-design.md).

## Why wait for receipts instead of writing a size sidecar later?

The library supports `packManifest(..., { encodeSize: false })` followed by
`packSizeManifest(...)`, but that is a compatibility tool, not the preferred
steady state. A later `UPDATE` creates another primary row version, WAL, and
potential logical change; it also requires exact entry ordering and a clear
"not ready yet" state. Today's `total_file_size NOT NULL` schema would need an
explicit contract for an unknown total rather than treating `0` as unknown.

When only receipt-capable uploads remain, verified sizes are available at
`set_manifest`. The simpler target is **one complete encode and one durable
write** of both packets before finalization. Existing legacy versions still
require the old per-file fallback until safely converted or retired. Neither
deprecating old CLIs nor moving binary bytes into a table retroactively proves
their file sizes.
