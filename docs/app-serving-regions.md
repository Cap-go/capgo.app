# App serving regions

Apps request a unique nonempty subset of the nine existing backend regions:
EU, NA, SA, OC, AS_INDIA, AS_JAPAN, HK, AF and ME. Existing/new apps default
to all nine and Route. Both fields remain optional in the public update API;
omitting them preserves saved settings. Existing app.update_settings RLS and
API permissions apply, including the onboarding-only mutation guard. The immutable
CHECK helper runs once per changed app row over at most nine input elements; it
reads no tables and adds no lookup to RLS or unfiltered request queries.

## What is enforced

After explicit deployment activation, the public plugin handlers for updates, manifest sizes, stats and every
channel_self method resolve a small policy document before app status,
snapshot, payload caches or regional database access. Deprecated plugin aliases
and the shared Deno handlers use the same gate. Block compares trusted ingress
colo groupings with the list, independently of the Worker hostname. Unknown
ingress fails unavailable. Route accepts other ingress regions and chooses an
allowed database backend within the current Worker; it does not attest the
physical location of Worker execution.

Replica selection is checked at the actual connection-string boundary.
Missing/lagging allowed replicas cannot escape to EU, a disabled binding or the
primary. The default all/Route path retains the existing routing/lag behavior.
Restricted policies partition app caches by the allowed set and use replica
queries instead of the globally published KV payload cohort. Hyperdrive caching
and PostgreSQL replication are unchanged. Global edge/control metadata and
channel override stores are not physical residency controls.

This is **not a storage residency feature**. Database replication remains global.
Capgo-hosted zip and delta files, shared R2 storage and their existing cache
layer remain global. All current regional files hostnames target the same files
Worker; selecting a hostname would not regionalize it. Legacy unscoped file
paths have no trustworthy app policy index. Direct signed storage URLs can
outlive a policy change, and external_url belongs to another provider.
Authenticated console/admin/preview/download-link operations are outside this
plugin policy. No regional guarantee is added to any download URL.

## Publication and activation

The database columns are requested settings. Once deployment enforcement is
enabled, they become effective at the successful conditional R2 write of sr1:<app_id> in the existing pointer bucket.
A save does not acknowledge activation. Settings show this distinction and let
the user compare the published document with their choices. Publication failure
leaves the previous policy effective and the requested change pending.

A dedicated durable policy queue is drained by the existing sync handler and
existing periodic plugin_state_sync_tick. It operates independently of the
payload writer/read flags. Policy jobs never promote unsynced apps to full sync,
read manifests/history, publish ps1 payloads, run payload garbage collection or
acknowledge app/full coverage. Payload work is gated by its existing SQL switch.
Each policy claim uses the shared monotonic generation sequence and a one-minute
lease. Publication failure retries after ten seconds, up to five claims. Expired
fifth leases are archived in batches of 200. Explicit repair_serving_policy_sync
re-enqueues at most 200 archived policies; it never starts payload repair.
Policy changes enqueue even when the KV sync/read canary is off. A monotonic writer generation plus R2 ETag conditions fences delayed
publishers. Policy keys are separate from ps1 payloads and are never garbage
collected as payload pointers. Each serving request reads R2 directly; neither
an eventual KV miss nor a payload canary flag grants unrestricted access.
Missing binding/document, invalid data or timeout fails unavailable before app
data. Old payload documents with absent fields retain all/Route; malformed
supplied fields fail validation.

The linearization point is the policy read of each request. Requests admitted
before a tightening may complete; this does not revoke an in-flight request or
a previously issued download URL. A receipt never substitutes for a current
policy read.

The snippet makes one uncached policy-only preflight before all learned,
on-prem, plan-upgrade and synthetic-stats answers. Restricted apps bypass only
their snippet app answers. All retry targets are filtered; once a policy is
known, the unfiltered original-origin fallback is forbidden. The shared
five-subrequest budget includes the preflight, Cache API operations and retries.
The gateway signs a five-second app-and-client-IP-bound ingress receipt using a separate
SERVING_REGION_SIGNING_KEY secret, never embedded in snippet source. Workers
verify it with Web Crypto; plain region headers have no authority. Direct
regional requests use trusted request.cf.colo. No new Worker-to-Worker data
forwarder is introduced. Deno fetches only the policy from the fixed gateway;
restricted policies fail unavailable if that runtime cannot attest ingress or
supply an allowed replica binding. Legacy server-side channel storage that
would open a primary read/write connection is unavailable under a restrictive
policy; it cannot silently bypass the regional read boundary. Trusted Logpush replay preserves EdgeColoCode;
older records without it cannot bypass a Block policy.

## Safe default release and activation contract

The checked-in servingRegionRollout.js artifact has a null reader epoch. Every
standard automatic release therefore preserves legacy Worker, shared Deno and
snippet serving, including warm on-prem/plan/synthetic answers. No policy read,
gateway fetch, signing key, new binding or primary lookup is added to those
request paths. Request headers, envclient, environment strings and KV misses
cannot enable the feature. The policy gateway reports active:false without
reading R2; the console reports requested settings as pending. Saving Block or
a smaller Route set does not activate it.

private.settings is the source of truth for deployment epochs. Hot paths use
its immutable deployment artifact, never a database query or an eventually
consistent runtime flag. Activation requires a deliberate prepared deployment;
the ordinary release workflow does not prepare or activate it. This PR performs
no deployment, provider mutation or automatic production activation.

1. Deploy the default-disabled code/schema first. The existing periodic tick
   bootstraps legacy all/Route policies through indexed app_id pagination of
   100 apps per transaction, with backpressure at 200 queued jobs. The cursor
   advances atomically with enqueue. No manifest/history scan is involved.
   New app inserts and changes enqueue their own policy work independently.
   During preparation, restrictive requests remain pending while the publisher
   writes only the legacy baseline. Inspect policy progress, pending and failed
   queues, and verify actual R2 coverage. With 5,500 apps the pagination requires
   55 nonempty passes plus the completion pass; provider throughput and the
   twenty-second drain budget determine elapsed time.
2. Provision the existing pointer binding and shared random signing key of at
   least 32 characters on every ingress implementation. In staging, test real
   cf.colo attestation across snippet same-zone fetches, all nine direct regions,
   Deno aliases and failures, warm old snippet answers, and representative load.
   These are prerequisites, not verified claims from local unit tests.
3. Set CAPGO_SERVING_REGIONS_READER_EPOCH in private.settings to a new immutable
   deployment identifier. Export only that name/value row, never secrets. Run
   bun scripts/prepare-serving-region-rollout.ts /absolute/reader-epoch.json.
   Review and commit the generated artifact in an intentional deployment PR,
   so subsequent automatic releases retain the same enforcing epoch. Deploy
   every reader, alias and snippet from that artifact. Drain old readers and
   old snippets before proceeding. Once enabled, a missing, invalid or
   unavailable per-app policy always fails closed before app data; there is
   no all/Route fallback on policy miss. The DB policy and cache gates all use
   the same request policy.
4. Verify every deployed ingress has the enforcing build, correct bindings and
   key, and initialized policies. Write {"f":1,"epoch":"<reader epoch>"} to
   sr1:ready only after the staging and deployed-ingress checks. As postgres,
   invoke activate_serving_policy_publication(epoch, verification_json).
   The function requires completed baseline pagination, empty pending/failed
   queues, matching private.settings reader epoch, and true acknowledgements
   for all nine region names plus snippet, deno, warm_cache, colo_attestation,
   load and keys. It sets CAPGO_SERVING_REGIONS_ACTIVE_EPOCH. Ordinary publisher
   credentials cannot call this activation function. The publisher also checks
   the same epoch against its compiled reader artifact and R2 readiness before
   publishing any restrictive document. No single request or canary can enable
   restrictive publication.
5. The periodic tick starts a new bounded policy-only pass for the active epoch.
   Requests remain governed by the previous published baseline until each
   conditional policy write succeeds. The UI compares actual published choices;
   a save/reload never represents pending choices as active. No payload
   backfill cursor or full-synced metadata is reset. Failed policy work requires
   explicit bounded policy repair, never a blanket full payload re-enqueue.

Activation must be treated as persistent. Never deploy a null or older artifact
once restrictions are accepted, delete policy keys/readiness, or rotate stores.
An enforcing reader with a missing policy fails closed, including newly created
apps awaiting their first publication. A rollback of enforcement requires a
separate deliberate product/operational decision, not an absent environment
variable. No propagation deadline is promised during provider failure.

## Cost and remaining verification

After activation, a cached snippet answer needs one strong policy read; a Worker-served
snippet request needs a second independent policy read. No plugin request
queries the primary to discover its policy. Per-request R2 work is constant,
independent of device/bundle/manifest count. Full 2M–50M requests/day load,
regional ingress attestation and the coordinated deployment transition require
staging validation before readiness acknowledgement. The gateway is a fixed
EU hostname control-plane dependency; a gateway outage fails closed. A later
multi-gateway policy-only fallback must preserve the same subrequest budget.

R2 consistency contract:
https://developers.cloudflare.com/r2/reference/consistency/
Trusted incoming request properties:
https://developers.cloudflare.com/workers/runtime-apis/request/
