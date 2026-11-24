# App serving regions

Apps request a unique nonempty subset of the nine existing backend regions:
EU, NA, SA, OC, AS_INDIA, AS_JAPAN, HK, AF and ME. Existing/new apps default
to all nine. Both fields remain optional in the public update API;
omitting them preserves saved settings. Existing app.update_settings RLS and
API permissions apply, including the onboarding-only mutation guard. The builtin
CHECK expression validates each changed app row over at most nine input elements; it
reads no tables and adds no lookup to RLS or unfiltered request queries.

## What is enforced

After explicit deployment activation, the public plugin handlers for updates, manifest sizes, stats and every
channel_self method resolve a small policy document before app status,
snapshot, payload caches or regional database access. Deprecated plugin aliases
and the shared Deno handlers use the same gate. Every subset compares trusted ingress colo groupings with the list, independently
of the Worker hostname. Devices in a deselected region are denied, including
saved legacy `route` policies. Unknown ingress fails unavailable for a restricted
policy. The legacy mode column/API is retained for compatibility; it can no
longer bypass region deselection. The customer UI has only region checkboxes,
with all nine selected by default, and automatic saved/applied status from #4180.
It does not attest the physical location of Worker execution.

Replica selection is checked at the actual connection-string boundary.
Missing/lagging allowed replicas cannot escape to EU, a disabled binding or the
primary. The default all/Route path retains the existing routing/lag behavior.
Restricted policies partition app caches by the allowed set and use replica
queries instead of the globally published KV payload cohort. Hyperdrive caching
and PostgreSQL replication are unchanged. Global edge/control metadata and
channel override stores are not physical residency controls.

## Bundle delivery and storage limits

The files Worker's uncached ingress reads the same current policy before its
managed `CachedFiles` entrypoint, deletion markers, inner Cache API, R2 or
storage fallback. The shared file handler repeats the gate for direct Deno and
legacy `/private/files/read/attachments/` routes. App identity comes from the
validated storage key `orgs/<org>/apps/<app>/...`, never a query parameter or
hostname. Native, regional and custom hosts use the same gate. Existing alias
candidate rules cannot cross app/organization boundaries. GET, implicit HEAD,
range and old URLs all undergo admission again. A preview hostname combined
with an attachment path is rejected before policy or cache access. Memoized
admission is bound to the app identity as well as the Request; a second app
cannot reuse the first app's admission.

Public preview URLs also check policy before their managed cache. Apps with
actual region deselections cannot use previews, whose current metadata lane
and external download payload cannot meet these boundaries. All-nine policies
retain previews and external offers with either legacy mode; a hidden saved
Block mode is not itself a delivery exclusion. Unknown/unscoped legacy keys
fail unavailable while enforcement is enabled: there is no primary lookup,
manifest scan or permissive app guess. This is an intentional compatibility
limit that must be inventoried before activation.

Enforcing builds return `private, no-store` to download clients, including on
all-region apps so a future tightening cannot be bypassed by a newly populated
client cache. Server-side byte caches remain usable after admission. Enforcing builds use server-configured `PLUGIN_FILE_DOWNLOAD_BASE_URL` for zip
and manifest URLs, including from custom API-only domains. Missing/invalid file
ingress configuration fails unavailable. Worker source configuration supplies
the matching native file ingress for each environment; Deno must receive the
same setting before activation. Deno no longer issues direct presigned GET URLs
in enforcing builds. Apps with actual region deselections do
not receive new `external_url` bundle offers, because an external provider
cannot apply our later policy changes. All-region apps retain normal update eligibility. Disabled-build URLs and
cache behavior are preserved.

The shared Cache API zip handler checks indexed deletion evidence on an allowed
replica in enforcing builds. Files workers prefer EU only when policy permits
it, and the selector still rejects missing/lagging allowed bindings without
primary fallback. The source files-Worker production and alpha configs reuse
the nine replica bindings of the matching plugin Worker. Preproduction has no
replica and needs a genuine allowed replica binding before activation; its
direct/primary binding must not be relabeled as a replica. No provider
configuration is changed by this source edit.

The enforcing deletion query stays a single cacheable SELECT. It does not open
a transaction or bypass Hyperdrive caching, so replica lag and the ordinary
query-cache lifetime still apply to deletion evidence. Route/configuration
failures return unavailable before serving bytes. Actual transient database
errors still fail open, as required. Because replica evidence can lag a
committed deletion, it only gates serving: a cache hit never restores a
missing R2 object from it, so a lagging replica cannot write a deleted object
back. Disabled builds retain the legacy primary deletion
connection/transaction path, and only that path restores a live cached file
to R2. The restoration receives an invoked promise and its own body branch
before the client starts consuming the response. Deleted markers and positive
deletion evidence still prevent restoration.

Activation prerequisites for this path: a cached zip of a just-deleted bundle
stays downloadable until the replica and Hyperdrive's query cache see the
deletion (/updates stops offering it as soon as the plugin state syncs), and
the replica lookup has no server-side statement bound of its own. Confirm the
replica role's `statement_timeout` (or accept these bounds) before setting the
reader epoch.

The policy read admits a request. A tightening does not stop an in-flight
response, remove bytes already downloaded, or revoke a response already held
in a client cache. Direct presigned storage URLs issued by older builds, public
storage endpoints and external provider URLs are outside Capgo's ingress and
cannot be revoked by Worker logic. Before activation, stop old URL issuance,
wait for outstanding signed links to expire, retire/deny any public storage
bypass, and verify every native/custom/legacy route reaches enforcing ingress.
External URLs need provider-side access controls or migration to hosted bundles.
Until those conditions are proved, do not promise complete old-URL prevention
or activate this feature. No production/provider verification is performed here.

This is **update delivery control, not physical replication selection or storage
residency**. PostgreSQL replication and shared storage are unchanged. KV's
[standard data location](https://developers.cloudflare.com/kv/reference/data-location/)
uses central stores and global caching. New namespace jurisdictions constrain
durable storage only; Cloudflare explicitly allows caches outside them. They
cannot be retrofitted or set per app to our arbitrary nine-region set. Denying
reads does not prove deletion or prohibit physical replicas. R2
[location hints](https://developers.cloudflare.com/r2/reference/data-location/)
are best effort. R2 jurisdictions are bucket-level guarantees chosen at creation,
not arbitrary per-object region sets. The shared buckets in this repository are
not converted to jurisdictional buckets by this change. Any physical-residency
requirement needs a separate provider/storage architecture and migration.
Cloudflare's [R2 consistency contract](https://developers.cloudflare.com/r2/reference/consistency/)
is why live policy reads use R2 instead of eventually consistent KV.

The Cloudflare docs above were checked on 2026-11-18. PR #4152 provides the policy
publisher, admission and database guards. PR #4180 is merged at this baseline and
provides automatic customer status. This change extends those controls to deny
excluded ingress even for legacy Route settings and to gate hosted downloads;
it does not duplicate the status/domain work or depend on the separate EU
background-source fix.

## Publication and activation

The database columns are requested settings. Once deployment enforcement is
enabled, they become effective at the successful conditional R2 write of sr1:<app_id> in the existing pointer bucket.
A save does not acknowledge activation. The console only offers these controls
after the service reports that they are available. Once available, it checks
saved settings automatically and shows a short applying/up-to-date status.
Unsaved edits are never presented as applied. Publication failure leaves the
previous policy effective and the requested change pending. Status checks use
the console environment's configured policy gateway and CSP, with bounded
retries and request timeouts. Only the latest check can update the displayed
status; changing the app or saved settings cancels an older check.

A dedicated durable policy queue is drained by the existing sync handler and
existing periodic plugin_state_sync_tick. It operates independently of the
payload writer/read flags. Policy jobs never promote unsynced apps to full sync,
read manifests/history, publish ps1 payloads, run payload garbage collection or
acknowledge app/full coverage. Payload work is gated by its existing SQL switch.
The initial policy phase has a deadline halfway through the invocation and half
the provider-operation allowance.
Deadline checks occur between awaited operations; they do not cancel an in-flight
SQL or R2 operation. It reserves eleven provider operations before each lease and
bounds no-op claims too, so sustained policy backlog leaves payload capacity.
Unused policy operations remain available to payloads and garbage collection.
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
a previously issued direct storage URL. Hosted file URLs recheck policy on each request. A receipt never substitutes for a current
policy read.

The snippet makes one uncached policy-only preflight before all learned,
on-prem, plan-upgrade and synthetic-stats answers. Restricted apps bypass only
their snippet app answers. All retry targets are filtered; once a policy is
known, the unfiltered original-origin fallback is forbidden. The shared
five-subrequest budget includes the preflight, Cache API operations and retries.
The gateway signs a fifteen-second app-and-client-IP-bound ingress receipt using a
separate SERVING_REGION_SIGNING_KEY secret, never embedded in snippet source. The
receipt requires a unique client binding; shared ingress addresses cannot establish one. The
active-policy snippet shares that routing horizon across its five-subrequest
budget, including the policy request, complete cache reads and circuit writes,
and worker attempts. These routing operations wait at most three seconds or the
remaining routing time. Individual network timeouts remain three seconds. This
bounds routing, not response-body delivery after a worker has answered. Workers
verify it with Web Crypto; plain region headers have no authority. Direct
regional requests use trusted request.cf.colo. No new Worker-to-Worker data
forwarder is introduced. Deno fetches only the policy from its configured
PLUGIN_REGION_TARGETS gateway and requires an active response for the same
compiled reader epoch. Missing gateway configuration fails unavailable;
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
reading R2; the console hides unavailable regional controls. Existing requested
settings remain stored for later activation. Saving Block or a smaller Route
set through the API does not activate it.

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
   The activation check and epoch write hold the same transaction lock as policy claims through commit.
   Busy claim admission fails activation safely instead of accepting a partial transition.
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
including hosted file traffic, regional ingress attestation and the coordinated
deployment transition require
staging validation before readiness acknowledgement. Each file request adds a current-policy R2 read before its byte cache. A cold
loopback invocation may perform a second read; it must fail closed if the
ingress identity cannot be preserved. A 5k-file delta bundle therefore requires
at least 5k policy reads across its downloads. This cost and latency must be
measured with representative concurrency before activation. No primary database
lookup or cached-policy shortcut is introduced.

The configured gateway (EU in production) is a control-plane dependency; a gateway outage fails closed. A later
multi-gateway policy-only fallback must preserve the same subrequest budget.

R2 consistency contract:
https://developers.cloudflare.com/r2/reference/consistency/
Trusted incoming request properties:
https://developers.cloudflare.com/workers/runtime-apis/request/
