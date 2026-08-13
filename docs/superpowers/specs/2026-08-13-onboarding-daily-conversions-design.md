# Onboarding Daily Conversion Charts

## Goal

Make the aggregate onboarding funnel drop-offs diagnosable by showing the three stage-to-stage conversion rates day by day. The charts should reveal whether a poor aggregate rate is persistent or concentrated on particular days.

## Scope

Add three full-width column charts to the existing **Frontend onboarding** admin page, directly below **Frontend onboarding funnel (v2)** and above **Frontend onboarding graph (v2)**:

1. **Intent → App details** — combines onboarding v1 and v2 attempts.
2. **App details → Organization** — onboarding v2 only.
3. **Organization → Setup reached** — onboarding v2 only.

The existing v2 funnel, v2 journey graph, v1 legacy funnel, date selector, loading behavior, and error behavior remain unchanged.

## Metric semantics

Each column represents one UTC day and one conversion percentage:

- Assign an attempt to the UTC day on which it reached the transition's starting stage.
- The denominator is the number of distinct `onboarding_attempt_id` values that reached the starting stage that day.
- The numerator is the subset of those attempts that reached the destination stage within the existing inclusive 24-hour follow-up window.
- Conversion is `numerator / denominator × 100`.
- A day with no starting attempts has no column rather than a misleading 0% value.

The first transition accepts both onboarding versions. The second and third transitions accept only v2. Existing attempt deduplication and stage ordering rules continue to apply.

## Backend design

Extend the existing `frontend_onboarding_analytics` response with a `daily_conversions` object containing three series. Build the series inside the existing frontend-onboarding analytics model from the same normalized attempt data already used by the KPIs, funnels, daily attempts, and journey graph.

Each point contains:

- UTC date (`YYYY-MM-DD`)
- starting-attempt count
- converted-attempt count
- conversion percentage

No new endpoint and no additional PostHog query are introduced. The model returns one point for every UTC day in the requested range. Days with no starting attempts contain zero counts and a `null` conversion percentage; the frontend skips their columns.

## Frontend design

Add a small reusable adapter that converts a backend daily-conversion series into the existing column-chart input shape. Render three existing chart cards in a vertical stack, preserving the page's full-width analytics layout.

All charts use a 0–100% y-axis. Tooltips show:

- date
- conversion percentage
- `converted / starting attempts`

All titles, legends, axis labels, and tooltip copy use translation keys. The page's existing date selector controls all three charts through the current analytics request.

## Loading and failure behavior

The charts use the same `visibleAnalytics` and latest-request loading lifecycle as the rest of the page. They do not show stale values while a new date range is loading. Existing page-level error handling remains the sole error UI.

## Testing

Backend model tests cover:

- UTC-day attribution to the starting stage
- inclusive 24-hour conversion window
- distinct-attempt counting
- combined v1/v2 behavior for Intent → App details
- v2-only behavior for the later transitions
- zero-denominator days

Frontend tests cover:

- conversion-series mapping
- percentage and count tooltip data
- the three chart titles and ordering between the v2 funnel and v2 graph
- reuse of the existing date/loading lifecycle

## Non-goals

- Comparing v1 and v2 as separate series
- Adding filters beyond the existing date range
- Returning raw attempt events to the frontend
- Adding new PostHog requests or endpoints
- Handling onboarding attempts without `onboarding_attempt_id`
