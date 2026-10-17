# Organization lifecycle email evaluation

This implementation depends on the protected A/B enrollment migration and engine
in [PR #3732](https://github.com/Cap-go/capgo.app/pull/3732), and the matching
49 isolated Bento sender branches in
[PR #21](https://github.com/Cap-go/bento-unofficial-api/pull/21).
It does not allocate experiments, backfill existing organizations, enable a
rollout control, send a test email, or deploy a workflow.

## Enrollment and recipients

`org_lifecycle_creators` prospectively records `NEW.created_by` at organization
insertion. `orgs.created_by` is unsuitable as historical provenance because
ownership transfer and account cleanup can replace it. The private provenance
row cannot be changed, including by later ownership changes; deleting the
original user does not replace that identity. Older organizations without this
capture remain outside this cohort. The original creator must still resolve to
a protected signup marker, a valid persisted v2 treatment A, the configured
self-signup audience and original creator's persisted `created_via_invite = false`,
the creation cutoff, current OTA/Builder intent, and the Builder treatment
prerequisite where applicable. No evaluation calls the allocator.
Invited creators stay excluded even with a stale treatment. Signup provenance
comes from the original user row; the recipient's invitation or membership and
client-provided onboarding JSON cannot establish self-signup eligibility.

The recipient is the current owner with an unexpired direct organization
membership and enabled organization/personal onboarding preferences and
notification consent. Original enrollment does not grant the creator access or
make a departed creator a recipient. Product content is independent; organization
and recipient collision budgets are shared. Organization preference links use a
membership-checked `oid` deep link, so another currently selected organization
cannot silently receive a billing or notification action.

## State, evidence and sending

Small modules under `cloudflare_workers/bento_dispatch/flows/lifecycle/` separate
cohort reads, typed evidence, progress collection, recovery, Trial clocks,
capacity, payload presentation, and atomic claim limits. The existing audited
worker handles scheduling, provider acceptance, retries and analytics relay.

Journey state is keyed by organization/product; app observations are keyed by
organization/product plus immutable `apps.id`. Deletion and ID reuse preserve
organization readiness and accepted purpose history while creating a fresh app
observation boundary. Transfers capture a new destination boundary. An
authenticated setup-page selection carries the exact incarnation and enabled
product. It changes context with an observation boundary, never the progress
clock. Passive usage heartbeats cannot switch apps or repeatedly wake retired
journeys. Old facts load as context and do not create a congratulatory batch. Ambiguous app selection
is unknown evidence, never a claim that no app exists.

Independent canonical statuses remain done/pending/skipped/warning/unknown.
Done-or-intentionally-skipped canonical checklists establish plan readiness;
only a real, non-demo applied bundle or successful cloud build establishes value.
Outcome polling continues after checklist completion. Demo provenance uses the
canonical `(app_id, relation_name, row_key)` index, independently of the demo seed
UUID. Analytics reads are bounded by current app creation/capture time and a
90-day lookback, with grouped version results validated against finalized real
bundles; an earlier demo result cannot hide a later genuine applied update.
Unknown coverage suppresses abandonment.
A supported Builder checklist with an omitted/null platform has the known next
task “Choose my platform”; it can receive recovery and unfinished Trial guidance
without earning iOS/Android facts, checklist readiness or real value. Invalid
platform values and unknown platform-specific steps remain unhealthy.

One genuinely new fact opens a fixed 15-minute batch. More facts join that batch
without moving its due time. A separately verified running build can hold it.
Normal/resumed/success/purchase variants compete for the same summary purpose.
Accepted summaries derive durable success/resumed/offer aliases. A later real
outcome is still new even if the checklist was manually resolved earlier.

The 24h, 48h and final purposes are shared across selected products in an
organization. Context includes product, app incarnation/platform, unresolved
steps and last meaningful progress (plus continuous app-less period). Escalation
requires the matching prior confirmed acceptance; a different app or product
cannot satisfy it. Replacement does not replenish consumed purposes. The final
reminder requires both matching sends, shipping intent and a current app; it is
due from day five and expires at day seven. Actual build-time denials supply the
separate funding-help branch; missing builds never imply a funding problem.

Provider acceptance alone consumes a purpose. Retries preserve its dispatch ID
and five-attempt ceiling, and refresh nonaccepted recipient/context metadata
under the current revision fence. The short existing claim transaction enforces
one organization/person send per rolling day, three optional setup sends per
rolling seven days and one optional offer per week. Retained Trial touches
bypass the optional weekly caps. A verified success with an unpaid plan CTA
consumes the same optional offer budget and durable offer alias; a paid success
does not. A due Trial candidate wins organization-level product arbitration at
selection, serialized claim and both live send rechecks. A higher priority
sibling arriving after selection can therefore reserve the organization slot;
blocked/exhausted candidates yield the cohort front.

## Retained Trial calendar

A read-only audit of the live Trial graph on 2026-10-17 verified a Stripe
CustomerCreated enrollment and seven sequential waits of 7/5/2/1/3/5/5 days.
The payment-incoming hook precedes the expired notice by one day. Old `trial7`
backend tags separately represent a 2–7-calendar-day billing segment, and
`trial0` also depends on allowance; neither defines this schedule.

This implementation preserves the seven purpose identities and wait spacing,
with explicit deadline-relative anchors at -8/-3/-1/0/+3/+8/+13 days relative to
`stripe_info.trial_at`. The first purpose also waits at least seven days after
journey enrollment. Later purposes cannot compress the confirmed acceptance
spacing. Missed windows do not create catch-up bursts. Extensions recompute
unsent anchors without replaying consumed phases; canonical completion changes
only the next unsent phase's ready/unfinished variant. The exact subject
`🚨 Capgo payment incoming !` is retained, while supplied copy states the actual
UTC deadline and makes no automatic-charge claim. Paid coverage or available
usage credits suppress upgrade pressure. Fresh measured usage and current
monthly catalog pricing determine the smallest fitting plan; missing pricing or
usage does not fabricate a recommendation.

## Activation and legacy handoff

All gates default closed. The authorized activation sequence is:

1. Merge/apply PR #3732's protected enrollment migration and engine first.
2. Merge this lifecycle migration/worker and PR #21's JSON definition. Deployment
   and live Bento application remain separate operator actions.
3. Verify the deployed JSON contains every event/tag in
   `lifecycle-v2-contract.json`, with isolated event → tag → email → finish
   branches. Verify inline text escaping and actual product URL targets.
4. Inspect legacy Aha, Builder and **Stripe CustomerCreated-rooted Trial** flows,
   including their already-running sessions. Backend event/tag suppression
   cannot stop a Trial session already enrolled by Stripe. Before attesting
   handoff, stop or exclude only the new-cohort organization/recipient sessions
   and verify that future Stripe enrollments cannot start both sequencers.
   Use original-creator cohort evidence plus current authorized recipients,
   not a person's A/B tag alone. Do not remove shared Trial/paid tags globally.
5. For multi-organization recipients, verify legacy session provenance before
   excluding it. An organization-less session cannot safely be attributed to a
   treated organization while preserving a control organization's email.
   Leave ambiguous organization journeys held (`support_hold = true`) and their
   legacy delivery active until session-level exclusion can be verified. Clear
   the hold only after that evidence exists; changing the hold wakes evaluation.
6. Only after sender and legacy-session verification explicitly set Vault
   `BENTO_LIFECYCLE_V2_SENDER_CONTRACT` and
   `BENTO_LIFECYCLE_V2_LEGACY_HANDOFF` to `new-emails-v2-2026-10-17`, and retain
   the existing global `BENTO_EVENT_DISPATCH_ENABLED=true` requirement. Explicit
   deployment overrides use the same exact values. This PR sets none of them.

Readiness and legacy suppression use the same protected creator predicate and
three controls. Unknown readiness retains existing legacy delivery and prevents
new provider events. Unrelated invitations, billing and transactional messages
are not suppressed. Existing subscription/customer/paid tags remain intact.

## Execution model and capacity

No plugin request path gains a primary database read/write. Trigger work starts
from a new/changed organization, user, app, billing customer or build identity.
Every new SQL function has an empty search path, explicit owner and PUBLIC/anon/
authenticated EXECUTE revocation. These functions are private trigger/scalar
helpers, with no new RPC or RLS-policy call. Public/invalid-key/broad-key and
unfiltered PostgREST SELECT requests execute none of the new functions.

Creator enrollment uses `(original_creator_id, org_id)`, organization selection
uses `apps(owner_org, app_id)` and a `LIMIT 2` ambiguity check, and individual
source joins use org/user/app primary keys. Demo exclusions use
`onboarding_demo_data(app_id, relation_name, row_key)`. Bundle/build lookups
start at indexed `app_id`; recommendations use the exact organization billing
period in `org_metrics_cache`. Dispatch counts use partial organization and
recipient expression indexes and bounded weekly counts. The migration test
executes `EXPLAIN (ANALYZE, BUFFERS)` with the normal planner over 100,000
additional synthetic users, organizations and creator rows. The measured keyed
lookup returned one row, used `org_lifecycle_original_creator`, `orgs_pkey` and
`users_pkey`, and had no sequential scan: 0.183 ms execution, 13 buffer hits and
zero reads in embedded PostgreSQL. These are fixture measurements, not
production-machine latency.

Each cron leases at most 20 due organization/product rows through the due-time
index and SKIP LOCKED. Tokens and revisions fence expired refreshes; observation
IDs and state updates commit together. Lifecycle handlers resolve/send
sequentially on each pinned connection, avoiding concurrent source transactions
spending a claim lease behind one another; independent queue deliveries still
run in parallel. Analytics requests are batched and capped
at 8KB per query, five seconds each, with at most 2,001 grouped version results.
Overflow is unhealthy coverage. The refresher has a 35-second soft deadline,
checks remaining time between rows, and never holds a transaction over network
I/O. Unfinished leases are reclaimable after 120 seconds.

Fixed batch/reminder/Trial boundaries schedule the next evaluation exactly.
Passive unresolved apps use distributed hourly slots; paid/ineligible/held
journeys sleep seven days, exhausted journeys daily. Relevant user/org/app/build/
billing changes wake them immediately. A 500-journey simulation at 20 evaluations
per minute proves ordinary polling fits the hourly capacity and pending batches
remain timely, avoiding permanent five-minute churn from completed cohorts.
This is console-scale coordination; it does not scan manifests or fan out per
plugin request. Actual backlog/refresh failure logs must be checked before
increasing rollout volume.
