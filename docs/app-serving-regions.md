# App serving regions

Apps request a unique nonempty subset of the nine existing backend regions:
EU, NA, SA, OC, AS_INDIA, AS_JAPAN, HK, AF and ME. Existing/new apps default
to all nine and Route. Both fields remain optional in the public update API;
omitting them preserves saved settings. Existing app.update_settings RLS and
API permissions apply, including the onboarding-only mutation guard. The immutable
CHECK helper runs once per changed app row over at most nine input elements; it
reads no tables and adds no lookup to RLS or unfiltered request queries.

## What is enforced

The public plugin handlers for updates, manifest sizes, stats and every
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

The database columns are requested settings. They become effective at the
successful conditional R2 write of sr1:<app_id> in the existing pointer bucket.
A save does not acknowledge activation. Settings show this distinction and let
the user compare the published document with their choices. Publication failure
leaves the previous policy effective and the requested change pending.

The existing durable sync queue publishes the small policy before any large
manifest/history work. Policy changes enqueue even when the KV sync/read canary
is off. A monotonic writer generation plus R2 ETag conditions fences delayed
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

## Deployment order, before accepting restrictions

This PR performs no deployment or provider mutation. Do not deploy it as an
uncoordinated rolling release.

1. Deploy schema and the policy writer first. Initialize a policy for every
   existing app through the bounded existing sync queue, including all/Route
   apps. New app inserts enqueue initialization. Verify queue failures and
   policy coverage before enabling readers. No missing-document default exists.
2. Configure one shared, random, at least 32-character
   SERVING_REGION_SIGNING_KEY in all nine plugin Workers. Keep the existing
   PLUGIN_STATE_POINTERS bindings/bucket and all Hyperdrive cache settings.
   Verify direct and snippet gateway requests preserve trusted ingress cf.colo
   across same-zone fetches in the deployed configuration. Do not accept Block
   activation until this is verified. No assumption about Wrangler placement
   counts as physical attestation.
3. Deploy every shared handler/alias and the snippet preflight together with a
   traffic drain/version transition. Old snippets with warm answers cannot be
   made safe by a cache purge alone. Test warm on-prem/plan/synthetic answers
   and failures against each ingress path. Verify old Deno paths return policy
   unavailable rather than accessing a disabled replica when restricted.
4. Only after every ingress is verified, write {"f":1} to sr1:ready in the
   existing pointer bucket. The writer refuses to publish any restrictive
   policy without this readiness acknowledgement. It leaves requested choices
   pending. This is a deployment acknowledgement, independent of KV canaries.
5. Release the settings UI only after the preceding checks. Verify published
   status, Block/Route, allowed-only lag fallback and unavailable cases.
   Never delete policy keys or rotate pointer stores without reinitialization.

If publication exhausts the existing five-attempt budget, repair/re-enqueue the
failed item through the existing sync repair path; do not raise retry limits.
No propagation deadline is promised during provider failure. Pending must not
be represented as active. A future synchronous settings service could
acknowledge activation in the save response; it would still need to fence all
direct console/SQL writers and in-flight requests.

## Cost and remaining verification

A cached snippet answer now needs one strong policy read; a Worker-served
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
