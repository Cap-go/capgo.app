# Onboarding v4 Welcome Outcomes Design

**Status:** Approved for implementation

**Date:** 2026-08-19

## Summary

Add a daily stacked column chart directly below **Frontend onboarding funnel (v4)** on the admin frontend-onboarding dashboard. The chart diagnoses whether onboarding v4 users saw the desktop Welcome screen and whether they continued to Intent.

The chart has three mutually exclusive series:

1. **Viewed Welcome screen, advanced to Intent**
2. **Did not show viewing Welcome screen**
3. **Viewed Welcome screen, did not advance**

It displays absolute attempt counts by default. A local **De-duplicate by user** control switches the chart to one best attempt per PostHog person across the selected range.

## Goals

- Diagnose devices or flows that reach Intent without recording a Welcome view.
- Show Welcome abandonment and advancement day by day in UTC.
- Keep all analytics strictly scoped to onboarding v4, the pre-organization flow, and the production console host.
- Reuse the existing 24-hour onboarding follow-up window.
- Let admins switch independently between raw attempts and best-attempt-per-user data without another network request.
- Preserve every existing funnel, KPI, conversion, CLI-outcome, and journey-graph calculation.

## Non-goals

- Changing Welcome-screen eligibility or onboarding behavior.
- Changing existing funnel or de-duplication semantics.
- Adding a PostHog dashboard or saved insight.
- Persisting the chart's de-duplication control.
- Supporting onboarding v1, v2, or v3 in this chart.
- Treating local, staging, development, or preproduction hosts as production data.
- Introducing a fourth pending category for incomplete 24-hour windows.

## Event Scope

The new query includes only `onboarding_step_viewed` events matching all of these conditions:

- `onboarding_version = 4`
- `flow = 'pre_org'`
- `$host = 'console.capgo.app'`, through the existing `FRONTEND_ONBOARDING_PRODUCTION_HOST` constant
- `step IN ('welcome', 'intent')`
- a non-empty `onboarding_attempt_id`

The query uses the same JSON extraction pattern as the existing frontend-onboarding query because PostHog's inferred typed property access does not reliably expose the string step value.

## Attempt Classification

Each attempt is assigned to exactly one category.

### Viewed Welcome screen, advanced to Intent

The attempt has a Welcome view and a subsequent Intent view at or before 24 hours after Welcome. The boundary is inclusive.

### Did not show viewing Welcome screen

The attempt has an Intent view and no Welcome view.

### Viewed Welcome screen, did not advance

The attempt has a Welcome view but no subsequent Intent view inside the inclusive 24-hour follow-up window. An Intent timestamp before Welcome does not count as advancement from that Welcome view.

Recent Welcome-only attempts are provisional until their 24-hour window closes. They can move from **did not advance** to **advanced to Intent** when the dashboard is refreshed. The chart description explains this behavior rather than introducing another visual category.

## Day Attribution

- Attempts containing Welcome use the UTC date of their first Welcome view.
- Attempts without Welcome use the UTC date of their first Intent view.
- The selected range applies to this anchor timestamp.
- The query reads from 24 hours before the selected range through 24 hours after it so an adjacent Welcome or Intent event cannot be mistaken for a missing event at a range boundary.
- The response is zero-filled for every UTC date in the selected range. A zero-total day renders no visible column.

## De-duplication Semantics

The raw series counts every classified attempt. The de-duplicated series selects one winning attempt per PostHog person across the entire selected range.

Attempts are ranked by journey quality:

1. Viewed Welcome and advanced to Intent.
2. Reached Intent without a Welcome view.
3. Viewed Welcome and did not advance.

If multiple attempts have the same rank, the later anchor timestamp wins. If rank and timestamp are identical, the lexicographically greatest attempt ID wins as a deterministic final tie-breaker.

Examples:

- Welcome-only on August 1 and Welcome-to-Intent on August 2: count only August 2.
- Intent without Welcome on August 1 and Welcome-only on August 2: count only August 1.
- Welcome-to-Intent on August 1 and Welcome-only on August 2: count only August 1.
- Intent without Welcome on August 1 and Welcome-to-Intent on August 2: count only August 2.

An empty PostHog person ID does not merge unrelated attempts. The attempt ID is used as a namespaced fallback identity, matching the existing de-duplication safety behavior.

## Backend Architecture

Add a dedicated Welcome-outcomes HogQL query instead of broadening the existing Intent-rooted query. Execute it in parallel with the existing frontend-onboarding and Setup-to-CLI queries inside the same admin endpoint.

The query returns one normalized row per attempt:

```ts
interface FrontendOnboardingWelcomeAttempt {
  attemptId: string
  personId: string
  welcomeMs: number | null
  intentMs: number | null
}
```

A focused pure model owns classification, day attribution, zero-filling, and best-attempt selection. Keeping this model separate prevents Welcome-only attempts from leaking into existing Intent-rooted analytics.

The query uses the existing 50,000-attempt limit and fail-closed total metadata validation. A failure in any PostHog query retains the dashboard's existing all-or-nothing error behavior.

Extend the response additively:

```ts
interface FrontendOnboardingAnalytics {
  daily_welcome_outcomes: FrontendOnboardingDailyWelcomeOutcome[]
  deduplicated: {
    // Existing fields remain unchanged.
    daily_welcome_outcomes: FrontendOnboardingDailyWelcomeOutcome[]
  }
}
```

Each daily point contains the UTC date and an absolute count for each of the three categories.

## Frontend Design

Add a full-width `ChartCard` directly below `funnel-v4` titled **Welcome screen outcomes (v4)**. Reuse `AdminStackedBarChart` and `AdminChartDeduplicateControl`.

Series colors communicate outcome:

- Emerald: Viewed Welcome screen, advanced to Intent.
- Amber: Did not show viewing Welcome screen.
- Rose: Viewed Welcome screen, did not advance.

The y-axis shows absolute attempt or user counts. Tooltips show the UTC date, category count, category share of the day's classified total, and daily total.

The chart owns an independent `ref(false)` de-duplication state. Its computed input switches between `daily_welcome_outcomes` and `deduplicated.daily_welcome_outcomes`. Toggling the control never reloads analytics and does not change the other chart controls.

All customer-visible copy uses translation keys added to `messages/en.json`.

## Failure Handling and Compatibility

- The analytics endpoint remains all-or-nothing.
- Query disconnection, malformed totals, and limit overflow use the existing page-level error state.
- The frontend validates the additive raw and de-duplicated arrays instead of silently presenting raw data as de-duplicated.
- Existing response fields and chart defaults remain unchanged.
- Recent provisional data is described in the chart copy; it is not treated as an error.

## Testing

### Pure model

Tests prove:

- all three category classifications;
- the inclusive 24-hour boundary;
- Intent before Welcome does not count as advancement;
- UTC date attribution uses Welcome when present and Intent otherwise;
- raw daily counts and zero-filled days;
- the four cross-day winner examples;
- latest-attempt and attempt-ID tie-breakers;
- empty person IDs remain separate.

### HogQL and endpoint

Tests prove:

- strict v4, `pre_org`, and `console.capgo.app` filtering;
- only Welcome and Intent step views are queried;
- dates include the required boundary lookback and follow-up;
- non-empty attempt IDs, grouping, total metadata, ordering, and the 50,000-attempt limit;
- the new query runs in parallel and failures remain all-or-nothing;
- normalized rows reject malformed data.

### Frontend

Tests prove:

- the new card appears directly after the v4 funnel;
- all three absolute-count series are mapped correctly;
- tooltip values include counts, percentages, and totals;
- the independent de-duplication control defaults off;
- toggling swaps response fields without another loader call;
- missing response arrays cause the existing error behavior;
- provisional-window copy is present.

## Completion Gates

Run focused analytics model, HogQL, and dashboard tests during TDD. Before publishing the pull request, run repository lint, backend and frontend type-checking, the production build, and the applicable unit suite. The pull request must pass the repository's `pr-ready` stable-green workflow.
