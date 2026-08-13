# Frontend Onboarding v2 Analytics Design

## Goal

Extend the existing read-only admin frontend-onboarding dashboard to compare onboarding v1 and v2, show a v2 funnel, and populate the configurable v2 interaction graph from PostHog.

The implementation should deliver roughly 80% of the analytics value with 20% of the possible complexity. A relatively small pull request is a primary requirement.

## Scope

The page order is:

1. KPI cards for onboarding v2.
2. Daily onboarding attempts, with v1 and v2 as differently colored series in the same stacked column chart.
3. **Frontend onboarding funnel (v2)**, rendered with the existing funnel component.
4. **Frontend onboarding graph (v2)**, rendered with the new configurable graph component.
5. **Frontend onboarding funnel (v1, legacy)**, the existing funnel renamed and moved to the bottom.

The v2 graph includes the four main stages:

1. Intent
2. App details
3. Organization details
4. Setup reached

Only App-details interaction nodes are included initially. Temporary Organization-details interaction nodes used to stress-test long text must be removed. Organization details and Setup reached remain as main stage nodes.

## Non-goals

This work does not add:

- attempt-ID persistence across refreshes;
- refresh or resumed-session reconstruction;
- attempt expiry rules;
- event-order validation or repair;
- new database tables or migrations;
- caches, queues, retries, or another admin endpoint;
- Organization-details interaction analytics;
- partial-data fallback when PostHog fails.

Refreshes can create another `onboarding_attempt_id`. This known edge case is accepted. The dashboard groups only by the IDs present in the events.

## Data Source and Query

Extend the existing `frontend_onboarding_analytics` endpoint and its current HogQL query. Do not introduce a second PostHog request.

The query returns one row per onboarding version and attempt ID:

```ts
interface FrontendOnboardingAttemptRow {
  attempt_id: string
  onboarding_version: 1 | 2
  intent_ms: number
  details_ms: number | null
  organization_ms: number | null
  setup_ms: number | null
  interaction_events: Array<[event_name: string, timestamp_ms: number]>
}
```

`interaction_events` contains relevant v2 interaction names paired with their event timestamps. The row mapper drops malformed tuples and invalid timestamps. The reducer then keeps only tuples from the attempt's inclusive Intent-to-24-hour follow-up window and deduplicates their event names, so repeated copies of one event in an attempt increase its node count only once.

The query retains the current protections:

- cohort attempts by their first Intent timestamp;
- allow subsequent events in the existing 24-hour follow-up window;
- reject date ranges longer than 365 days;
- fail closed above the existing 50,000-attempt limit;
- use the existing PostHog connection and error handling.

The 50,000-attempt limit applies to the combined v1 and v2 result.

## Backend Aggregation

Extend the existing pure analytics reducer. It separates attempt rows by `onboarding_version` and produces:

```ts
interface FrontendOnboardingAnalytics {
  kpis: FrontendOnboardingV2Kpis
  daily_attempts: Array<{
    date: string
    v1_attempts: number
    v2_attempts: number
  }>
  funnels: {
    v1: FrontendOnboardingFunnelStage[]
    v2: FrontendOnboardingFunnelStage[]
  }
  v2_graph: {
    nodes: Array<{
      key: string
      count: number
    }>
  }
}
```

The KPI cards are calculated from v2 attempts only. Both funnels reuse the current stage-reduction logic:

- Intent
- App details
- Organization details
- Setup reached

Daily attempts are zero-filled across the selected date range and split by onboarding version.

The backend graph response contains stable event keys and distinct-attempt counts only. It does not return labels, icons, colors, coordinates, edges, hierarchy, or percentages.

## Graph Counting Semantics

Every graph node counts distinct `onboarding_attempt_id` values containing its event. One attempt contributes at most once to a node.

Graph hierarchy is frontend configuration, not a PostHog event property.

### Direct App-details events

These nodes connect immediately to the App details stage, for example:

- App name entered
- App ID entered
- App ID help opened
- Store import opened
- File picker opened

Their displayed percentage is:

```text
node attempt count / App details attempt count
```

It is labeled `% of App details`. The graph does not display a percentage of all onboarding attempts for interaction nodes.

### Nested App-details events

These nodes connect to another interaction, for example:

```text
Store import opened
├── Import closed
└── Store URL entered
    └── Import clicked
        ├── Import succeeded
        └── Import failed
```

They display two percentages:

```text
% of App details = node attempt count / App details attempt count
% of previous = node attempt count / immediate parent node attempt count
```

A zero denominator produces `0%`. The reducer does not verify that every child attempt also contains its expected parent event. Missing or out-of-order event sequences are accepted.

## Frontend Responsibilities

The frontend owns the graph's visual and semantic configuration:

- node labels and event-key mapping;
- direct and nested relationships;
- icons, tones, and colors;
- coordinates, widths, levels, and edges;
- calculation of `levelPercent` and `previousPercent` from backend counts;
- complete, wrapping labels without truncation.

The reusable graph component remains independent of PostHog and the backend response shape. The page adapts backend node counts into the graph configuration.

The v2 and legacy funnels both use `AdminFunnelChart`. The legacy title changes to **Frontend onboarding funnel (v1, legacy)**.

The daily chart adapts `daily_attempts` into two existing stacked-bar series with stable, distinct v1 and v2 colors.

## Error Handling

Retain the page's current loading coordinator and single error state. If the combined PostHog query fails, the analytics request fails as it does today. Do not show a partially populated dashboard or introduce per-section retries.

## Testing

Focused tests cover:

- HogQL includes versions 1 and 2 and groups by version plus attempt ID;
- repeated interaction events in one attempt count once;
- interaction events before Intent or after the 24-hour attempt window do not count;
- daily attempts split v1 and v2 and zero-fill dates;
- v1 and v2 funnels use the expected attempt cohorts;
- KPI cards use v2 only;
- direct graph percentages use App details as the denominator;
- nested graph percentages use App details and the immediate parent;
- zero denominators produce zero percentages;
- dashboard sections render in the approved order;
- both funnels reuse `AdminFunnelChart`;
- the legacy funnel has the new title and appears last;
- temporary Organization-details subnodes are absent.

Existing range, truncation, request-lifecycle, loading, and error tests remain in place.

## Implementation Constraint

Prefer extending the existing model, query, reducer, response type, adapters, and page. Do not generalize beyond the two supported onboarding versions or build infrastructure for hypothetical future analytics. Simplicity is part of correctness for this change.
