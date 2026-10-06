# PostHog delivery from private events

`POST /private/events` runs in the Cloudflare API Worker. Authentication,
permission checks, verified org/app/user resolution, canonical event identity,
and acceptance/event timestamps are synchronous. Console-only events retain
only the existing Realtime path. Every other event awaits a JSON queue send
before Bento enrichment, delivery, or onboarding/checklist writes. A resolved
send is the PostHog durability boundary, not confirmation of provider delivery.
Missing bindings or failed sends return `503 event_queue_unavailable`, with no
later Bento/state work. Oversized snapshots return `413 event_too_large`; invalid
provider inputs return `400 invalid_event_payload`.

After persistence the existing Bento and state behavior continues, with PostHog
disabled in the common tracking call. The existing derived bundle-compatibility
email-outcome event also uses this queue. Its canonical identity is deterministically
derived from the accepted parent ID in a separate namespace, and its timestamps
come from the parent. It is produced when existing enrichment determines the
outcome, after the primary event is durable. Other direct PostHog callers keep
the Hono wrapper and its legacy boolean contract.

## Direct production cutover

Merge deploys this cutover directly to production. There is no dual-send phase,
feature flag, hold queue, generic analytics ingress, or Supabase fallback.

1. Provision and verify the target environment's queue pair **before deploying
   the Worker that references it**. Use a Cloudflare account-scoped token with
   Queues Edit and the existing Worker deployment permissions. Set
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` securely; never put them in
   a command argument, logs, or a committed file.
2. Run `bun scripts/ensure-posthog-queues.ts prod`. It creates the DLQ before
   main, applies fourteen-day retention (`1209600` seconds) to both, reads fresh
   server state to verify it, and ensures the DLQ has one HTTP pull consumer
   with five retries. It refuses an unexpected automatic DLQ consumer or retry
   configuration. Existing queue settings are preserved when correcting retention.
3. Run `bun scripts/ensure-posthog-queues.ts prod --verify-only` if a separate
   read/verification phase is needed. This fails if resources, retention, or the
   DLQ consumer differ and never creates/updates resources.
4. Deploy with `bun run deploy:cloudflare:api:prod`. This command **also runs the
   provisioning/verification gate and stops on failure before Wrangler deploy**.
   CI invokes this same guarded command. Do not bypass it with a direct Wrangler
   deployment. Deployment attaches the main consumer and switches the producer
   immediately. Keep current `POSTHOG_API_KEY` and `POSTHOG_API_HOST` Worker
   secrets configured; consumers use current credentials, never queued secrets.
5. Monitor enqueue failures, provider retries, oldest backlog, quota-limited
   outcomes, and DLQ depth immediately after deployment. Prefer a forward fix
   retaining the queue handler/bindings if a problem occurs. Do not deploy an old
   native-notification-only queue handler while PostHog messages remain queued.
   Never purge or delete queues to roll back a Worker.

The same idempotent command supports `alpha`, `preprod`, and `all`. The guarded
`deploy:cloudflare:api:dev` and `:preprod` commands select alpha and preprod
respectively. They support non-production verification, not a staged production
rollout requirement. Local Wrangler uses a local queue pair to exercise the same
path. Endpoint/Bento integration tests run in Cloudflare CI; Supabase CI does not
simulate a queue or restore direct delivery.

| Environment | Main queue | DLQ |
| --- | --- | --- |
| alpha | `capgo-posthog-events-alpha` | `capgo-posthog-events-alpha-dlq` |
| preprod | `capgo-posthog-events-preprod` | `capgo-posthog-events-preprod-dlq` |
| prod | `capgo-posthog-events-prod` | `capgo-posthog-events-prod-dlq` |

Main consumers have batch size 10, batch wait 5 seconds, concurrency 2, and
**exactly five retries**. No Worker automatically consumes the DLQ. Its HTTP
consumer exists only for operator recovery. Main and DLQ each retain messages
for fourteen days; TTL expiry is still a data-loss boundary.

## Delivery and observability

The V1 JSON message contains `source: private_events`, canonical `event_id`,
`accepted_at`, `request_id`, and a provider-ready payload: event/channel,
description, canonical distinct ID, tags/non-person tags, verified organization
group, captured IP, and frozen occurrence timestamp. The producer explicitly
selects these fields, deep-copies properties, strips credential and reserved
identity/group property names, validates the schema, and caps UTF-8 JSON at
96 KiB, leaving room below Cloudflare's 128 KiB limit for metadata/overhead.
JWTs, Capgo tokens, PostHog keys, authentication headers, Bento payloads, and raw
request objects are never selected into the snapshot. No consumer queries a
database, reauthenticates, reauthorizes, or calls an internal HTTP endpoint.

Each message makes one capture using both `$insert_id` and `uuid` equal to the
canonical event ID and the original event timestamp. Queue delivery is at least
once; provider deduplication handles duplicates after an ambiguous response or
a crash between provider persistence and queue acknowledgement.

| Provider/consumer outcome | Action |
| --- | --- |
| delivered | Acknowledge this message |
| HTTP 429 or 5xx | Retry this message |
| timeout, network failure, invalid response | Retry with original identity/time |
| quota limited | Await explicit DLQ persistence, then acknowledge original |
| missing config, invalid host/payload, other 4xx, rejected | Same publish-then-ack DLQ rule |
| invalid queue body | Preserve in DLQ without provider capture |
| unexpected exception or failed DLQ send | Retry original, do not acknowledge |

Retry delays for attempts one through five are 30s, 2m, 10m, 30m, and 2h.
Cloudflare moves the original V1 message to the matching DLQ when retries
exhaust. Explicit terminal routing uses a `posthog_dlq` V1 envelope containing
`original` plus outcome, reason, HTTP status, failure time, and attempt count.
An invalid near-limit original is preserved raw if an envelope would not fit.
Recovery understands original V1 and explicit envelopes, and refuses invalid data.

`posthog_queue_enqueue` logs persistence/failure status and canonical correlation
IDs. `posthog_queue_delivery` logs action/outcome, HTTP status when available,
attempt count, queue age, and duration. No new logs contain event names,
user/org/app IDs, IPs, descriptions, tags, provider response bodies, errors with
arbitrary provider details, or authentication material. No provider result is
returned to the client; success remains `{ status: 'ok', event_id }`.

Use Cloudflare queue metrics (`backlog_count`, `backlog_bytes`,
`oldest_message_timestamp_ms`) for both queues alongside structured Worker logs.
Investigate sustained enqueue failures immediately. Alert on any quota-limited
outcome or new DLQ growth; investigate oldest main backlog exceeding five minutes
outside known provider outages. Retention is fourteen days, so resolve incidents
and replay well before expiry. Use counts/ages in incident notes, not payloads.

The batch timeout test runs ten captures concurrently and proves ten stalled
fetches finish/retry at 5s, rather than taking 50s serially. Fetch is bounded to
5s and successful body inspection to another 1s; provider bodies are capped at
16 KiB. With two invocations there are at most twenty in-flight captures, giving
a conservative capture capacity of about 200 events/minute at the worst-case
six-second response duration before DLQ-send overhead. This is a timeout-bound
capacity estimate, not a production throughput measurement. Watch measured
backlog/drain rate and provider limits before changing concurrency. Successful
siblings are explicitly acknowledged and are not replayed by a failed sibling.

## Bounded operator replay

Fix the provider quota, credentials, host, or transient incident first. Replaying
while quota remains exhausted will only move snapshots back into the DLQ.
Run one replay process per environment; do not run concurrent operators or a
background replay automation. Keep Cloudflare credentials in the environment.

```sh
# Read backlog metrics only. No leases, publications, acknowledgements, or payload output.
bun scripts/replay-posthog-dlq.ts prod --limit=10

# Explicitly publish at most ten validated snapshots to main, then ack each DLQ lease.
bun scripts/replay-posthog-dlq.ts prod --execute --limit=10
```

Default limit is 10; allowed range is 1–100. The tool has an eight-minute run
budget, pulls at most ten messages at once with a ten-minute visibility lease,
and bounds each Cloudflare request to fifteen seconds. It previews each batch
without leasing it, rejecting invalid/non-JSON bodies and messages with four or
more previous DLQ attempts before spending another attempt. Preview is not an
atomic lease; pulled bodies are validated again to cover changes between calls.
HTTP JSON bodies are base64-decoded with strict UTF-8 before schema validation.

Replay preserves canonical IDs, accepted/occurrence timestamps, and every
provider field. It strips only the terminal envelope and republishes the original
validated V1 JSON. A lease is acknowledged only after the main publication resolves;
acknowledgement count and warnings are checked. Publication failure, an uncertain
ack, or a deadline stops the run with remaining leases unacknowledged. Duplicates
caused by uncertain publication/ack keep stable provider deduplication IDs.

Output is limited to mode and counts. Invalid data is never printed, published,
acknowledged, or purged; a refusal stops further batches and exits nonzero.
HTTP pulls consume DLQ retry budget, so do not repeatedly retry refused/failed
runs. Cloudflare can discard a message after that budget expires. Inspect and
repair refused data through restricted operator tooling before any further
lease, or preserve it in an access-controlled incident store before TTL expiry.
The replay tool intentionally has no destructive repair/export mode.

References: [Cloudflare queue limits](https://developers.cloudflare.com/queues/platform/limits/),
[per-message retries and acknowledgement](https://developers.cloudflare.com/queues/configuration/batching-retries/),
[HTTP pull content types and lease behavior](https://developers.cloudflare.com/queues/configuration/pull-consumers/),
[non-leasing message preview](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/peek/).
