# R2 cleanup consumer

This adds deletion delivery to the existing production inventory Worker. The
producer implementation, constants, minute schedule and health code are unchanged
relative to current main. Producer activation and live health checks were merged
separately in PR #3702 while this consumer was being prepared; current main has
`CLEANUP_ACTIVATED=true`. This PR preserves that upstream implementation verbatim.
See [producer contract](r2-cleanup-producer.md). This PR adds no consumer cron,
Worker, jobs table or health writer. Deploying it can begin draining existing
committed retirement jobs once storage configuration and replication evidence
permit; it must not be treated as a disabled deletion rollout.

## Delivery and safety

`capgo-r2-inventory-prod-cleanup` delivers up to 100 messages after a ten-second
batch timeout, with at most five concurrent batches, two retries (three deliveries total), a
30-second retry delay and dedicated `capgo-r2-inventory-prod-cleanup-dlq`.
Existing notification/repair delivery settings remain unchanged. The existing
release job runs the extended queue-provisioning script before Worker deployment;
all six queues retain four days of messages. Provisioning stays production-only.
No production queue, credential, SQL or object is changed by preparing this PR.

Validate the producer's schema version, production bucket, managed delta scope
and exact six-digit microsecond retirement timestamp. Identical jobs within a
batch share storage work. Different retirement identities for one key stay
independent. Invalid bodies use the existing durable rejection-envelope pattern,
with acknowledgement only after cleanup-DLQ publication. Failed/ambiguous
publication retries only those invalid source messages within their normal budget.
DLQ envelope bodies are operational data; never forward them to Discord.

For each group of at most 20 jobs, short READ COMMITTED transactions read only
the delivered inventory primary keys and perform exact indexed `manifest.s3_path`
probes. They hold no row/advisory lock through R2 work. `row_security=off` makes
policy-filtered reference reads fail closed. Missing/non-visible retirement
retries; a different non-null timestamp is obsolete and acknowledged without R2.
Matching completed retirement is an acknowledged duplicate. A matching
`to_be_deleted` row must have no visible reference and no active manifest lease.
An unexpected reference/lease preserves both R2 and permanent retirement, logs a
generic reason, acknowledges that message and contributes to the alert summary.
There is no automatic redispatch of skipped or exhausted jobs.

V2 manifest finalization requires an existing, unexpired reservation and renews it
under the inventory row lock; a receipt cannot recreate a missing reservation.
Upload notifications preserve the existing expiry exactly. Once cleanup retires a
key, a late upload cannot attach that key through a new successful finalization.
The separate possibility of a previously admitted save committing after its renewed
lease expires is accepted and documented beside the consumer reference check;
shared transactional coordination is deferred to the planned inventory move into
Supabase. Older v1/receiptless finalization retains its existing retirement checks.

The consumer accepts the original v1, upstream v2 and replication-only v3 `cleanup_health` schemas,
and reads only a valid `observedAt` and
`manifestReplicationHealthy=true`. Evidence must not be future-dated and must be
at most 300 seconds old, independently of producer-only `maxAgeSeconds`. It is read again for each group and its remaining life
bounds storage work within that group. Notification/repair/backlog and consumer
health flags do not gate draining. Missing/stale evidence stops R2 work; this PR
neither invents evidence nor reinstates admin monitoring. The producer's separate live
health contract is unchanged relative to main.

## Storage and acknowledgement

The existing lightweight S3 client's high-level copy API does not expose source
conditions or cancellation. This consumer uses the already installed AWS S3 SDK
with an explicit fetch transport, one SDK attempt and a shared AbortSignal for
its entire object workflow. R2 performs server-side COPY to
`deleted-after-7-days/{original-key}` with metadata directive COPY and, when
available, the inventory source ETag. If inventory lacks an ETag, HEAD supplies it.
The R2 destination-create-only extension preserves an existing backup on retry.
A precondition failure requires sequential source/trash HEADs with matching ETag,
length and metadata before deletion. Mismatches and unknown/permission/network failures
preserve the original. A definitive absent source is an idempotent success.
No object body is downloaded or proxied.

The SDK consumes the complete copy response and detects errors embedded in HTTP
200; the consumer also requires copy-result ETag and modification evidence.
Only confirmed copy completion permits DELETE. COPY+DELETE is **not atomic**:
source conditions do not fence subsequent DELETE, and a timed-out operation can
finish remotely. Aborted/late COPY resolution cannot initiate DELETE. A successful
copy followed by failed DELETE recovers against the existing backup; DELETE
followed by a crash before acknowledgement recovers through definitive absence.
Permanent retirement plus the separately reviewed legacy-write/replication
activation requirements remain essential; this is not a new restore workflow.

The inventory Worker aliases `@aws-sdk/xml-builder` to its pure JavaScript
parser. The SDK's browser parser requires `DOMParser`, which Workers do not
provide: R2 can complete COPY with HTTP 200 while SDK deserialization fails.
Keep the alias and explicit dependency together. The browser-build regression
test verifies successful COPY parsing, embedded errors, incomplete responses,
and existing-backup recovery without DOM APIs.

Storage failures emit up to three distinct, sanitized diagnostic events per
batch, immediately when observed. They report the storage stage, allowlisted
error type, HTTP status, timings and copy-response field presence. They never
include object keys, raw provider errors or credentials, and do not change
acknowledgement, retries or deletion decisions.

After confirmed DELETE/absence, acknowledge each corresponding source message
**immediately, before any completion database connection/query**. Then perform
one best-effort completion UPDATE per group. The update uses the snapshot taken
before storage, revision and first-seen identity, and event/reconciliation
watermarks. It sets `deleted`/reconciliation/tombstone facts while preserving
retirement, size, ETag, modified time and event history. It never invents an R2
eventTime. Conflicts, lock failures and write failures only log/alert; they cannot
retry acknowledged messages. Existing notifications are fallback recovery.

## Budgets and capacity

Each batch runs four workflows concurrently, at most one storage request each.
Five concurrent batches therefore allow up to 20 storage workflows across five
independent invocations, each with its own six-connection limit. Each batch
releases its DB connection before storage and never opens a per-file connection.
Cleanup adds at most five active application DB connections to the existing
notification and repair consumers' combined two. The independently scheduled
upstream producer/health invocation can add one inventory and one source-database
connection: at most eight inventory connections and one source connection across
these paths. Hyperdrive pools and API traffic have additional budgets.
Transactions use two-second statements, 500ms locks and five-second
idle limits. Connection establishment is limited to three seconds.

Each storage workflow has a 20-second deadline. A batch has ten minutes and
stops starting work without another full object budget plus a 15-second reserve.
Groups use fresh snapshots; work cannot start without 20 seconds remaining in
the health/110-second observation window. Completion refuses observations older
than 120 seconds. The simple worst-case storage budget is
`100 / 4 * 20s = 500s`, leaving 100 seconds for database/publication/alert overhead;
these are enforced starting bounds, **not measured latency or throughput guarantees**.
A capped batch can leave unfinished messages for its configured retries/DLQ.
Five batches can hold up to 500 delivered messages at once; the per-batch
deadline, four-workflow limit, request budget and retry count do not increase.
Measure net backlog change over several minutes against ongoing production,
alongside batch issue counts and DLQ growth. A falling main queue alone does
not prove successful cleanup if failures are instead exhausting into the DLQ.

Current Cloudflare limits are 15 minutes wall time per queue invocation, default
30 seconds CPU configurable to five minutes (this Worker requests 300,000ms),
10,000 Paid subrequests by default and six initial simultaneous connections.
Normal storage uses 200 requests per full batch; recovery can use up to five
per object (including missing-ETag HEAD), with no SDK retries. This leaves room
for bounded SQL/publication/alert work, but production capacity still requires
measurement. No local mock proves provider latency or a drain rate.

A read-only production `EXPLAIN (ANALYZE, BUFFERS)` on 2026-10-15 used the
consumer safety SELECT over 20 keys sampled by a bounded primary-key range.
The delivered-key lookup used `r2_objects_pkey` and all 20 reference probes used
`manifest_s3_path_idx` (index-only, zero heap fetches). Execution was 7.196ms,
205 shared buffer hits / 15 reads, with no large-table sequential scan. This
single query is not an end-to-end throughput or cold-cache guarantee.

## Dedicated optional Discord alert

Install an optional, **new dedicated** secret on this Worker; no existing webhook
is reused:

```sh
bunx wrangler secret put R2_CLEANUP_DISCORD_WEBHOOK_URL --config cloudflare_workers/r2_inventory/wrangler.jsonc --env prod
```

Use a standard `https://discord.com/api/webhooks/.../...` URL. A missing secret
only disables Discord, never correct cleanup. Messages contain fixed generic
reason labels and bounded counts, no keys, filenames, customer/app/org ids,
receipts, credentials, raw provider errors or stacks. Content is hard-capped at
1,800 characters (Discord allows 2,000) with `allowed_mentions: { parse: [] }`.

The `cleanup_discord_alert` entry in existing checkpoints atomically claims a
10-minute global cooldown before sending and accumulates bounded suppressed
counts. The connection is released before HTTP. A failed durable claim skips
Discord. There is one three-second HTTP attempt with redirects disabled; a
failed/ambiguous send consumes its claim, without immediate retry or object
failure. A longer numeric Retry-After extends the claim (bounded to one day)
using its token, so an old invocation cannot overwrite a later claim.

## Deployment and activation prerequisites

Before deploying the consumer, verify:

1. The upstream producer activation from PR #3702 is intentional for the rollout.
   Current main already enables retirement, so consumer deployment can start
   physical deletion of committed jobs. Preserve the producer runbook's replication
   and legacy late-write safety requirements. This consumer PR supplies no health
   attestation writer and changes none of the existing producer health code.
   If deletion must remain paused, pause cleanup delivery before deployment;
   never use missing credentials as the pause mechanism or burn delivery retries.
2. Correct standalone PlanetScale inventory/replicated manifest schema, retirement
   triggers, uncached `HYPERDRIVE_R2_INVENTORY` and the existing restricted role.
   Read-only inspection on 2026-10-15 found about 20M inventory / 11.4M manifest
   rows, the expected manifest index, safety columns, inventory/checkpoint writes
   and the column-only manifest reference grant. No new permission is needed.
   Reverify at rollout; the existing reviewed SQL setup is
   `sql/20261014_cleanup_manifest_read.sql`, not a new migration to apply here.
3. The release workflow must provision/verify cleanup queue and DLQ before deploying
   this Worker, then verify actual consumer settings and runtime limits. No
   alpha/preprod inventory deployment or manual live queue provisioning is needed
   to prepare this change. Pause delivery during failed rollout instead of burning
   the three-delivery budget; do not blindly replay exhausted jobs.
4. Configure these **required storage secrets** before delivering cleanup work:

   ```sh
   bunx wrangler secret put S3_ENDPOINT --config cloudflare_workers/r2_inventory/wrangler.jsonc --env prod
   bunx wrangler secret put S3_ACCESS_KEY_ID --config cloudflare_workers/r2_inventory/wrangler.jsonc --env prod
   bunx wrangler secret put S3_SECRET_ACCESS_KEY --config cloudflare_workers/r2_inventory/wrangler.jsonc --env prod
   ```

   `S3_ENDPOINT` is the HTTPS R2 account endpoint, with no bucket/path. Use
   bucket-scoped credentials permitting server-side copy, HEAD and DELETE for the
   production bucket and trash prefix. The native R2 binding cannot perform
   server-side COPY. Preserve/verify the existing seven-day trash lifecycle rule.
5. Measure throughput, timeouts, queue/DLQ age, DB plans/WAL/pool capacity and
   copy/delete failure recovery using an approved synthetic rollout. This PR's
   tests use fake transports and isolated Postgres, and send no live webhook.

References: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[R2 S3 support](https://developers.cloudflare.com/r2/api/s3/api/),
[R2 destination conditions](https://developers.cloudflare.com/r2/api/s3/extensions/),
[S3 complete-copy responses](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html),
[Discord webhooks](https://docs.discord.com/developers/resources/webhook).
