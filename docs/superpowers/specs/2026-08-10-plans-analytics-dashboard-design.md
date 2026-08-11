# Plans Analytics Dashboard Design

## Summary

Add a read-only **Plans** page to the admin dashboard that explains how organizations use the customer-facing Plans page and whether those visits lead to checkout intent. The page combines historical PostHog behavior with Capgo billing records, preserves data from before exact Plans tracking existed, and makes incomplete historical classification visible instead of silently guessing.

This feature does not change the customer-facing Plans page, ended-subscription behavior, payment banners, or checkout behavior. The exact Plans tracking fix is a prerequisite, and the stacked vertical bar component merged in PR #2963 is reused.

## Goals

- Measure Plans-page traffic by organization and by total logical openings.
- Show the billing state of daily Plans visitors at the time they visited.
- Measure whether daily Plans visitors started checkout within the agreed attribution window.
- Show the historical billing state of organizations that started checkout.
- Preserve legacy Plans visit data while repairing watcher-generated duplicate bursts.
- Make PostHog failures and uncertain historical billing classifications explicit.

## Non-goals

- Measuring checkout completion or abandonment in this release.
- Adding a new analytics warehouse, scheduled importer, or materialized reporting table.
- Changing subscription, trial, credit, or checkout behavior.
- Treating current billing state as a substitute for historical state.
- Adding an artificial maximum to the admin date-range picker.

## Selected Architecture

Use live hybrid aggregation:

1. The frontend requests one `plans_analytics` metric from the existing `/private/admin_stats` endpoint.
2. A focused backend Plans analytics module queries PostHog for Plans visits, checkout starts, and timestamped billing-transition evidence.
3. The backend reads Capgo billing and credit history for only the organizations returned by PostHog.
4. Pure functions repair legacy events, attribute checkout, reconstruct billing state, and produce every chart series.
5. The existing five-minute admin-dashboard cache stores the complete response by selected range.

PostHog remains the source of behavioral facts. Capgo's database remains the billing source of truth, while timestamped PostHog billing transitions may resolve exact intraday timing that daily database rollups cannot provide.

No direct per-query PostHog charge is expected under the current event-ingestion pricing model. The additional read workload is controlled through one page request, the existing cache, bounded query timestamps, and no automatic refresh or retry.

## Time Model

- All query boundaries, buckets, labels, billing-state comparisons, and checkout attribution use UTC.
- The page labels the reporting timezone as UTC.
- The selected range is half-open: `[start, end)`.
- Custom ranges remain unrestricted. Very large ranges may time out; the page explains that the administrator should choose a shorter range.

## Plans Visit Sources

### Exact events

An exact opening is a `User visit` event with `page = 'plans'`. Exact events are emitted once per Plans page activation by the tracking fix and do not receive legacy burst repair.

### Legacy events

A legacy candidate is a `User visit` event that:

- does not contain `page = 'plans'`; and
- has a URL/path property that normalizes to `/settings/organization/plans`.

Query strings, fragments, and a trailing slash do not change the normalized path. Legacy and exact branches are mutually exclusive.

The pathname evidence must be stored on the event, or be a PostHog person-on-events property verified to represent ingestion-time state. A query-time person property is not valid historical evidence. If the schema probe cannot establish an event-time pathname, legacy reconstruction is disabled and the page reports the exact-tracking boundary rather than fabricating historical Plans visits.

### Organization identity

Events without a valid organization identifier cannot contribute to organization-based graphs. The response reports their count as excluded data-quality evidence.

## Legacy Burst Repair

Legacy watcher emissions must be converted into logical openings without removing genuine repeat visits:

1. Sort legacy candidates chronologically within `organization + PostHog session`.
2. If a session identifier is absent, use `organization + distinct user`.
3. Start a new logical opening when no preceding candidate exists or the inactivity gap exceeds the configured burst threshold.
4. Collapse the other events in the burst into the first event and retain that timestamp.
5. Read 30 seconds before the selected range so a burst crossing the range boundary does not create a false opening. Events before `start` remain excluded from chart counts.

Thirty seconds is only a candidate threshold. It must not be treated as active or numerically trustworthy until a historical same-organization/session inter-event gap distribution proves that it separates watcher bursts from genuine navigation. `dataQuality.legacyDeduplicationSeconds` is `null` while legacy reconstruction is unavailable; a selected numeric value may be returned only after the legacy path and threshold are validated and covered by deterministic tests.

This repair changes **Total opens** and visit-to-checkout attribution. Organization-unique graphs apply their own range or daily deduplication after logical openings have been constructed.

## Checkout Attribution

- A `Checkout Started` event matches the most recent preceding logical Plans opening for the same organization within 24 hours.
- The checkout is attributed to the Plans opening's UTC day, not the checkout event's UTC day.
- A checkout matches at most one Plans opening.
- A checkout without a preceding Plans opening inside 24 hours is excluded from checkout-intent graphs and reported in data-quality metadata.
- For one organization with multiple attributed checkouts on the same attributed day, checkout-intent counts the organization once. The checkout breakdown uses its earliest attributed checkout that day.

Example: a Plans opening at August 1 23:55 UTC followed by checkout at August 2 00:05 UTC counts as `Started checkout` on August 1.

The PostHog query therefore reads Plans visits from 30 seconds before the selected range through `end`, and checkout events from `start` through 24 hours after `end`. Events outside the selected range support repair or attribution only and never become visible Plans visits.

## Billing Categories

The categories are mutually exclusive:

1. Paying
2. Active trial
3. Expired trial — never subscribed
4. Canceled — previously paid and voluntarily ended
5. Payment problem — past due or payment-failure churn
6. Credits only
7. Unknown — insufficient historical evidence

Classification precedence is:

1. Payment problem
2. Paying
3. Active trial
4. Credits only
5. Canceled
6. Expired trial — never subscribed
7. Unknown

Trial-generated `canceled` rows without a `paid_at` timestamp classify as Expired trial, not Canceled. Payment-related churn takes precedence over ordinary cancellation. Credit state is reconstructed at the visit timestamp from grants and transactions, not from the current balance.

### Paying reconstruction

For each relevant Stripe customer, reconstruct paid entitlement over time from `daily_revenue_metrics`:

```text
ending MRR =
  opening MRR
  + new business MRR
  + expansion MRR
  - contraction MRR
  - churn MRR
```

Positive MRR means paid entitlement; zero MRR means no paid entitlement. Carry the resulting state forward until the next billing movement.

On a UTC day where entitlement changes, daily MRR identifies the start and end state but may not identify the exact intraday transition. Resolve the transition time using, in order:

- `paid_at` for the first paid conversion;
- `canceled_at` for the current or final cancellation; and
- timestamped PostHog `User subscribe`, `User update subscribe`, `User cancel`, and organization `$groupidentify` billing transitions for intermediate cycles.

For periods predating reliable revenue history, the fallback is `paid_at <= visit timestamp` and either no `canceled_at` or a visit before `canceled_at`. This fallback is valid only for an unambiguous single paid interval. If daily MRR proves an intraday change but no trustworthy transition timestamp exists, or multiple lifecycle records conflict, classify that visit as Unknown.

“Paying” therefore means there is positive evidence that paid entitlement existed at the exact Plans-opening timestamp. It never means that today's mutable `stripe_info.status` is currently successful.

## Graph Definitions

### 1. Plans page traffic

Full-width line chart with two series:

- **Unique visitor orgs:** each organization contributes once in the selected range, placed on the UTC day of its first logical opening inside that range. A visit before the selected range does not suppress the first visit inside the range.
- **Total opens:** every logical opening after legacy repair.

If an organization opens Plans on August 1 and August 6, it adds one unique organization on August 1, zero unique organizations on August 6, and one total opening on both days.

### 2. Who opened Plans?

Full-width stacked vertical bars. Each organization contributes once per UTC day and may contribute again on later days. Its category is evaluated at its first logical Plans opening that day.

If the same organization opens Plans on August 1 and August 2, it appears once on each day.

### 3. Checkout intent

Full-width stacked vertical bars. Each daily unique Plans visitor belongs to exactly one series:

- Started checkout
- Did not start

An organization is Started checkout when at least one checkout is attributed to one of its logical Plans openings for that day. Graph 3 totals equal Graph 2 totals for every day.

### 4. Who opened checkout?

Full-width stacked vertical bars using the exact Started checkout population from Graph 3. Classify each organization at the Plans opening attributed to its earliest checkout for that attributed day. Graph 4 totals equal Graph 3's Started checkout totals for every day.

### 5. Checkout completion

Full-width placeholder card only. Its title is **Checkout completion**. Its body intentionally uses user-facing TODO language and links to `docs/admin/plans-checkout-completion.md` on GitHub. That document explains the completion/abandonment graph that will be implemented after reliable completion tracking exists.

No completion estimates are derived from missing events in this release.

## API Contract

Add `plans_analytics` to the admin `MetricCategory` union and `/private/admin_stats` validation/switch. The endpoint returns all graphs in one response:

```ts
interface PlansAnalyticsResponse {
  traffic: {
    dates: string[]
    uniqueVisitorOrganizations: number[]
    totalOpens: number[]
  }
  visitorBreakdown: DailyBillingPoint[]
  checkoutIntent: DailyCheckoutIntentPoint[]
  checkoutVisitorBreakdown: DailyBillingPoint[]
  dataQuality: {
    exactTrackingStartedAt: string | null
    legacyLogicalOpens: number
    exactLogicalOpens: number
    legacyReconstructionAvailable: boolean
    legacyUnavailableReason: 'missing_event_time_path' | null
    excludedMissingOrganization: number
    unmatchedCheckoutStarts: number
    unknownBillingOrganizations: number
    posthogConfigured: boolean
    posthogConnected: boolean
    posthogFailureReason: 'unconfigured' | 'timeout' | 'unavailable' | 'too_large' | null
    legacyDeduplicationSeconds: number | null
  }
}
```

## Evidence Record — 2026-08-10

The exact tracking prerequisite is present through `main`: commit `918f7dc15` (`fix(analytics): deduplicate plans page visit tracking (#2964)`) emits one `User visit` per Plans-page activation with `tags: { page: 'plans' }`, and merge commit `060a4abaa` brought that prerequisite into this branch.

The Task 1 PostHog project lookup, schema lookup, bounded event sample, and legacy inter-event gap histogram were each attempted. Every call returned MCP error `-32603 Internal error`. These failures provide no production event sample, schema result, event-time pathname proof, or gap distribution. Consequently, legacy reconstruction remains disabled with `legacyUnavailableReason: 'missing_event_time_path'`, and the 30-second candidate is unvalidated: it is neither active nor numerically trustworthy and is reported as `legacyDeduplicationSeconds: null`.

Re-enabling legacy reconstruction requires a successful proof that the chosen pathname is event-time data, a real same-organization/session gap histogram that validates the selected threshold, and tests covering the enabled mapper, burst boundaries, and wire metadata. No production-data conclusion is inferred from the failed calls.

The concrete daily-series types use the existing admin chart input conventions and contain every UTC date in the selected range, including zero-value days.

## Admin UI

Add a **Plans** tab and a dedicated admin dashboard page. The page uses the existing `AdminFilterBar`, identifies UTC explicitly, and renders the five full-width cards in graph order.

- Graph 1 reuses `AdminMultiLineChart`.
- Graphs 2–4 reuse `AdminStackedBarChart` from PR #2963.
- Graph 5 is the documentation placeholder.
- Loading uses chart-card skeletons.
- A valid empty result renders zero/empty chart states.
- PostHog being unconfigured, unavailable, or timed out renders a page-level unavailable state rather than zero-valued charts.
- Partial billing reconstruction renders the charts with Unknown segments and a visible data-quality warning.
- Refresh uses the existing manual refresh control and invalidates the five-minute cache.
- There is no automatic refresh or automatic retry.

For a timed-out request, retain the selection and show: “Plans analytics timed out. Try again, or select a shorter period.” Keep this distinct from the `too_large` response, which tells the admin that the result exceeded a bounded row or byte ceiling.

## Error Handling and Observability

- Keep PostHog credentials and HogQL on the backend.
- Preserve the existing platform-admin read-only authorization gate.
- Distinguish unconfigured, connection failure, timeout, and valid empty data in the response/error model.
- Treat an analytics result that reaches the bounded PostHog row or response-byte ceiling as `too_large`; never render silently truncated charts. Sequential behavior and boundary queries have an 8 MiB response ceiling; each of the four concurrent transition queries is limited to 2 MiB so one wave remains bounded to 8 MiB in aggregate.
- Log query duration, selected range duration, logical event counts, and classification coverage without logging organization IDs or credentials.
- Never silently fall back to current billing status.
- Never substitute zeros when either source fails.

## File Boundaries

The implementation plan should preserve these responsibilities:

- A focused backend Plans analytics module owns PostHog queries and orchestration.
- Pure backend helpers own visit repair, checkout attribution, paid-timeline reconstruction, and billing-category precedence.
- `/private/admin_stats` owns validation, authorization, and dispatch only.
- The Pinia store owns the typed metric request and existing cache integration.
- The Plans admin page owns presentation and state rendering only.
- A dedicated Markdown file owns the deferred checkout-completion requirements.

No database migration is required.

## Verification

Unit tests cover:

- duplicate legacy bursts and genuine repeat visits;
- session fallback to distinct user;
- a burst crossing the selected-range boundary;
- separation of exact and legacy events;
- range-wide versus daily organization uniqueness;
- UTC date bucketing;
- checkout across midnight within 24 hours;
- exclusion of checkout outside 24 hours or without a visit;
- one checkout result per organization/day;
- Graph 2 classification at the first daily opening;
- Graph 4 classification at the opening attributed to the earliest checkout;
- billing-category precedence;
- first subscription, cancellation, payment failure, recovery, and resubscription timelines;
- credit balance at the historical timestamp;
- deliberate Unknown classification for ambiguous history;
- Graph 2 and Graph 3 daily-total equality;
- Graph 3 Started checkout and Graph 4 daily-total equality.

Backend tests cover admin authorization, request validation, PostHog unconfigured/unavailable/timeout behavior, valid empty data, and the complete response contract using mocked PostHog responses.

Frontend tests cover loading, populated graphs, valid empty data, partial-data warnings, timeout recovery messaging distinct from `too_large`, unavailable state, UTC labeling, and the checkout-completion documentation link.

Before handoff, run focused tests, lint, type checking, and the production build. Validate the 30-second legacy threshold against the real historical gap distribution before considering the analytics numerically trustworthy.

## Dependencies and Rollout

- PR #2963 supplies the stacked vertical bar component.
- The exact Plans `User visit` tracking fix must be merged before this dashboard is considered complete.
- Legacy history remains visible with explicit reconstruction metadata.
- Exact and legacy counts appear in data-quality metadata so the transition can be monitored.
- Checkout completion remains deferred until a reliable success signal and abandonment definition are implemented.
