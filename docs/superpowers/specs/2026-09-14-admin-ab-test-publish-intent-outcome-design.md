# Admin A/B Test Publish Intent Outcome Design

## Goal

Extend the read-only platform-admin **A/B Tests** page with one numeric outcome graph answering: among unique users who saw the new **Publish** intent through either qualifying experiment, how many selected Publish, selected another intent, or have not selected an intent yet?

## Cohort

A user is exposed when either of these persisted treatment assignments is present:

- `webnativeapp_publish_intent` uses its configured treatment branch; or
- `webnativeapp_development_environment` uses its configured treatment branch.

The query reads one row per `public.users` record, so a user assigned to both treatments is counted once. Control-only users are excluded. Exposure is based on the authoritative persisted A/B assignment, not analytics events or organization membership.

## Outcomes

Every exposed user belongs to exactly one outcome:

- **Selected Publish:** `users.onboarding.intent = 'publish'`.
- **Selected another intent:** the intent is `ota`, `builder`, `both`, or `exploring`.
- **No selection yet:** the intent is missing or is not a recognized onboarding intent.

The exposed total equals the sum of these three counts. Counts, rather than percentages, are the primary UI value. Bar lengths remain proportional to the exposed total to make the relative sizes scannable without adding percentage labels.

## Data Flow

1. Add a focused `ab_test_publish_intent_outcome` category to the existing authenticated `/private/admin_stats` endpoint.
2. A dedicated backend helper reads `public.users` through the production read replica.
3. The query uses the existing `users_onboarding_abtests_gin_idx` expression index with two JSON containment predicates joined by `OR`. It groups only the matched user rows by normalized outcome.
4. The helper fills missing outcome buckets with zero and returns a stable three-row response plus the deduplicated total.
5. The admin page loads assignment distribution and the new outcome metric concurrently through the existing five-minute admin-stat cache.
6. A strict frontend parser rejects malformed totals, duplicate or unknown outcome keys, negative counts, and responses whose counts do not sum to the total.

No schema migration is required. The query is admin-only, low frequency, read-only, and returns aggregate counts without customer-identifying data.

## Interface

Keep the existing assignment-distribution matrix unchanged. Directly below it, add one separate card titled **New Publish intent outcome**.

The card contains:

- a short explanation that the cohort combines either treatment and deduplicates overlap;
- the large unique exposed-user count;
- three horizontal count bars for Selected Publish, Selected another intent, and No selection yet;
- locale-aware, tabular count formatting; and
- accessible visible labels and numeric values so color is never the only signal.

Desktop places the exposed total beside the graph. Narrow screens stack the total above the rows. Light and dark styling follow the existing admin dashboard tokens.

## States

- **Loading:** retain the existing page loader while both metrics load.
- **Loaded:** render assignment distribution and the unified outcome card.
- **Zero exposure:** show total `0`, all three counts as `0`, and empty tracks.
- **Error:** retain the page-level retry notice if either response is invalid or unavailable.

## Verification

- Unit-test cohort response building, zero-filled outcomes, invalid backend rows, read-replica usage, GIN-compatible predicates, and pool cleanup.
- Unit-test strict frontend response parsing and total consistency.
- Unit-test admin metric validation, page wiring, outcome-card structure, and English copy.
- Run the focused tests, backend lint, frontend lint, typecheck, production build, and the repository's broader applicable test gates.
- Use `EXPLAIN (ANALYZE, BUFFERS)` against production to confirm the two exposure predicates use the existing GIN index and avoid a sequential scan.
- Open a pull request and complete the `pr-ready` stable-green process.
