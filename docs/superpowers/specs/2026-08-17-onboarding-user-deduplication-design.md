# Onboarding User De-duplication Design

**Status:** Approved for implementation planning

**Date:** 2026-08-17

## Summary

Add an optional, non-persistent **De-duplicate by user** view to two admin onboarding charts:

- **Daily onboarding attempts**
- **Frontend onboarding funnel (v3)**

The existing analytics remain the default. When a chart's checkbox is enabled, that chart uses one winning onboarding attempt per PostHog person. The winning attempt is the attempt that reached the furthest valid onboarding stage; ties select the latest attempt.

The backend returns both the existing and de-duplicated chart data in one response. The two frontend checkboxes switch between those variants independently without another request or loading state.

## Goals

- Let admins view daily onboarding attempts with each person counted at most once across the selected date range.
- Let admins view the v3 funnel with each person counted at most once among their v3 attempts in the selected date range.
- Select the attempt that reached the furthest stage within the existing 24-hour follow-up window.
- Select the latest attempt when multiple attempts reached the same furthest stage.
- Keep both chart controls independent, local, default-off, and non-persistent.
- Reuse the existing PostHog attempt query and compute both variants in the backend analytics model.

## Non-goals

- Changing the PostHog event query or event definitions.
- De-duplicating KPIs, comparison metrics, daily conversion charts, v1/v2 funnels, interaction graphs, or Setup-to-CLI outcomes.
- Persisting either checkbox state locally or remotely.
- Re-querying PostHog when a checkbox changes.
- Combining different PostHog people by email, user ID, organization, device, or another inferred identity.

## Definitions

### Valid stage reach

An attempt reaches a stage when that stage or a later stage has a qualifying timestamp between the attempt's Intent timestamp and 24 hours after Intent, inclusive. This preserves the existing funnel semantics:

1. Setup reached
2. Organization
3. App details
4. Intent

For example, an attempt with an Organization timestamp but no App details timestamp still ranks as Organization and counts as having reached App details in the funnel.

### Winning attempt

Attempts are compared in this order:

1. Furthest valid stage reached.
2. Latest Intent timestamp.
3. Lexicographically greatest attempt ID as a deterministic final tie-breaker.

The attempt ID tie-breaker has no product meaning. It only guarantees stable output if duplicate or asynchronously ordered events produce otherwise identical candidates.

### Missing person identity

An attempt without a non-empty PostHog `personId` is not merged with any other attempt. Its attempt ID acts as a unique fallback key. This avoids collapsing every unidentified attempt into one synthetic user.

## Chart Semantics

### Daily onboarding attempts

De-duplicate all v1, v2, and v3 attempts whose Intent timestamp falls inside the selected range. Select one winning attempt per person across that entire range, even when the attempts occurred on different UTC days or onboarding versions.

The winner contributes once:

- on the UTC date of its own Intent event;
- to the series for its own onboarding version.

Example: a person's August 10 v2 attempt reaches App details and their August 12 v3 attempt reaches Organization. Only the August 12 v3 attempt is counted.

### Frontend onboarding funnel (v3)

Filter the selected-range attempts to onboarding v3 first, then select one winner per person from those v3 attempts. A person's v1 or v2 attempts neither compete with nor disqualify their v3 attempt.

Build the de-duplicated v3 funnel from those winners using the existing 24-hour stage and funnel rules.

## Backend Architecture

### Existing query

Keep `buildFrontendOnboardingHogql` unchanged. It already returns every required attempt with:

- onboarding version;
- attempt ID;
- PostHog person ID;
- Intent, App details, Organization, and Setup timestamps.

No additional PostHog round trip is required.

### Pure selection model

Add a pure helper in the frontend onboarding analytics model that selects one winning attempt per identity from a supplied attempt array. The helper owns the stage ranking, latest-attempt tie-breaker, deterministic attempt-ID tie-breaker, and missing-person fallback.

`buildFrontendOnboardingAnalytics` will continue to build the existing fields from all attempts. It will additionally:

1. Select current-range winners across v1/v2/v3 and build de-duplicated daily attempts.
2. Filter current-range attempts to v3, select v3 winners, and build a de-duplicated v3 funnel.

Selection occurs only after attempts are normalized and mapped from PostHog rows, so malformed attempts continue to be rejected by the existing mapping boundary.

### API response

Extend `FrontendOnboardingAnalytics` with:

```ts
interface FrontendOnboardingAnalytics {
  // Existing fields remain unchanged.
  deduplicated: {
    daily_attempts: FrontendOnboardingDailyAttempt[]
    funnels: {
      v3: FrontendOnboardingFunnelStage[]
    }
  }
}
```

The field name makes the alternate semantics explicit and leaves room for another deliberately de-duplicated chart without changing existing response fields.

## Frontend Data Flow

The dashboard keeps two independent `ref(false)` values:

- `deduplicateDailyAttempts`
- `deduplicateV3Funnel`

Computed chart inputs choose between the existing and alternate response fields:

- Daily chart: `daily_attempts` or `deduplicated.daily_attempts`.
- V3 funnel: `funnels.v3` or `deduplicated.funnels.v3`.

Checkbox changes do not call the analytics loader. Refreshing the page recreates both refs as `false`. Because each control is rendered inside its `ChartCard` body, it remains visible only while that chart is expanded.

## Error Handling and Compatibility

- The analytics request remains all-or-nothing; no new partial-result state is introduced.
- Existing query connection, truncation, date validation, and malformed-row errors remain authoritative.
- The new response field is additive, so existing consumers remain compatible.
- A missing `deduplicated` field is not silently synthesized by the frontend. A deployment mismatch should use the existing dashboard load/error behavior rather than present raw data as de-duplicated.

## Testing

### Pure backend model

Tests will prove:

- Setup outranks Organization, which outranks App details, which outranks Intent.
- A later attempt wins when stage depth is tied.
- Attempt ID produces deterministic output when both stage and Intent timestamp are tied.
- A winner moves the person to the winner's UTC day and onboarding-version series.
- Daily selection competes across v1, v2, and v3 attempts.
- V3 funnel selection competes only among v3 attempts.
- Different missing-person attempts remain distinct.
- Stage ranking observes the existing 24-hour follow-up window.
- Daily output remains zero-filled for every UTC date in the selected range.

### Frontend integration

Tests will prove:

- Both checkbox states default to `false`.
- Daily series switches only to `deduplicated.daily_attempts`.
- V3 funnel switches only to `deduplicated.funnels.v3`.
- Toggling either checkbox does not invoke the analytics loader.
- Existing raw chart behavior remains the default.

### Completion gates

Run the focused model and dashboard tests first, then the repository frontend/backend lint, type-check, build, and applicable unit suites required by repository guidance before publishing the pull request.
