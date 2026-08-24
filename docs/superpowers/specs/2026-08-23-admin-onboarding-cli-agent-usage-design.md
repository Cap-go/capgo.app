# Admin Onboarding CLI Agent Usage Design

**Status:** Approved for implementation

**Date:** 2026-08-23

## Summary

Add a daily stacked chart directly below **Daily Setup → CLI outcomes (v2–v4)** on the frontend onboarding admin dashboard. The chart classifies every qualifying Setup person-day exactly once as **No CLI invoked**, **No agent**, one detected agent identity such as **Codex** or **Claude Code**, **Multiple agents**, or **Unknown agent**.

The chart reuses the existing v2–v4 Setup cohort, person identity, and 24-hour latest-anchor attribution window. It does not require an app or organization ID, so actor-scoped commands such as `app list` can still describe agent-assisted onboarding without including unrelated established-user CLI activity.

## Goals

- Show how often agents participate after people reach the onboarding Setup step.
- Preserve the existing Setup cohort and 24-hour action-attribution semantics.
- Include every Setup person-day, including people who invoke no CLI command.
- Count each Setup person-day exactly once, regardless of command count.
- Display detected agent identities dynamically from `agent_identity`.
- Keep the existing CLI-outcome chart and API fields unchanged.
- Reuse the existing PostHog request, pure model, and stacked-chart component.

## Non-goals

- Attributing CLI activity to a specific app or organization.
- Counting all CLI activity from newly registered or established users.
- Persisting derived agent attribution in PostgreSQL.
- Changing CLI telemetry or the `agent_invoker` / `agent_identity` event schema.
- Replacing the existing **Daily Setup → CLI outcomes (v2–v4)** chart.

## Cohort and Attribution

The existing daily Setup analytics defines the cohort and ownership window:

- Setup event: `onboarding_step_viewed`.
- Required properties: `flow = pre_org`, `step = setup`, and onboarding version 2, 3, or 4.
- Anchor: the first qualifying Setup view for a PostHog person on a UTC day.
- Ownership window: `[anchor, min(anchor + 24 hours, next Setup anchor))`.
- Lifecycle: the existing First-time/Returning calculation remains unchanged for the existing graph. The new agent chart combines both lifecycles into one daily stack because it answers a different question: which invocation environment followed Setup?

An app or organization ID is intentionally unnecessary. PostHog `person_id` connects the authenticated Setup event to authenticated CLI invocation events.

## Classification

For each displayed Setup anchor, inspect only `CLI Command Invoked` events assigned to its existing ownership window.

1. No CLI events: **No CLI invoked**.
2. One or more CLI events, but every event has `agent_invoker != true`: **No agent**.
3. Every agent invocation event contains a usable `agent_identity.id`, and those events contain exactly one unique ID: the group label is the first non-empty `agent_identity.name`, falling back to the ID.
4. Agent invocation events contain more than one unique identity ID: **Multiple agents**.
5. At least one event has `agent_invoker = true`, but none contains a usable identity ID: **Unknown agent**.
6. A known identity plus an unknown detected identity is **Multiple agents**, since more than one invocation environment was observed but not fully identified.

Repeated commands and repeated use of the same agent never increase the Setup-person count. Identity IDs are trimmed and compared exactly; display names remain presentation metadata and do not define uniqueness.

## Backend Data Flow

Extend the existing bounded `buildFrontendOnboardingDailySetupCliHogql` result for CLI rows with:

- `agent_invoker` as a Boolean;
- `agent_id` extracted from `agent_identity.id`;
- `agent_name` extracted from `agent_identity.name`.

Non-CLI rows return neutral values for these columns. The existing total-row metadata, 50,000-row limit, ordering, cohort restriction, and failure behavior remain unchanged.

Extend `FrontendOnboardingDailySetupCliEvent` with optional normalized agent fields for CLI events. Invalid types are rejected. A missing identity is valid only because **Unknown agent** is an intentional classification.

The pure model will compute the new result while processing the same normalized event array used by `buildFrontendOnboardingDailySetupCliOutcomes`. It must preserve the existing anchor selection and window ownership rules rather than reimplementing a broader user-age or app-based cohort.

The API adds:

```ts
interface FrontendOnboardingDailySetupCliAgentGroup {
  key: string
  agent_id?: string
  agent_name?: string
}

interface FrontendOnboardingDailySetupCliAgentPoint {
  date: string
  counts: Record<string, number>
}

interface FrontendOnboardingDailySetupCliAgentUsage {
  groups: FrontendOnboardingDailySetupCliAgentGroup[]
  points: FrontendOnboardingDailySetupCliAgentPoint[]
}
```

The response field is `daily_setup_cli_agent_usage`. Reserved keys are `no_cli_invoked`, `no_agent`, `multiple_agents`, and `unknown_agent`; detected identities use `agent:<id>`.

Groups are ordered as detected agents by descending total count with agent-name/key tie-breakers, followed by **Multiple agents**, **Unknown agent**, **No agent**, and **No CLI invoked** when those groups occur. Every UTC date remains present even if all counts are zero. The frontend resolves reserved keys through translation messages and displays a detected group using `agent_name`, falling back to `agent_id`.

## Dashboard Presentation

Add a `ChartCard` immediately after the existing daily Setup-to-CLI chart.

- Title: **Daily Setup → CLI agent usage (v2–v4)**.
- Description: each Setup person is counted once per UTC day; CLI events use the following 24 hours and are attributed to the latest Setup anchor.
- Visualization: one stacked bar per UTC day using `AdminStackedBarChart`.
- Series: dynamic detected-agent groups plus the four reserved groups that occur in the selected range.
- Color: stable known colors for Codex and Claude; stable reserved colors for special groups; deterministic palette selection for other agent IDs.
- Empty state: only when there are no Setup person-days in the displayed range. A range containing only **No CLI invoked** is valid chart data.

All labels and descriptions use keys in `messages/en.json`; no inline translation fallbacks are introduced.

## Error Handling

- Preserve the existing PostHog connectivity and row-limit failure behavior.
- Reject malformed Boolean, identity ID, or identity name fields instead of silently changing classification.
- Treat `agent_invoker = true` with absent identity data as **Unknown agent**, not a query failure.
- Treat missing agent properties on older CLI events as `agent_invoker = false`, preserving historical compatibility.
- Return no partial agent chart when the shared daily Setup CLI query fails.

## Testing

### Query and row mapping

- HogQL extracts all three agent fields only for CLI invocation rows.
- Older rows without agent properties map to non-agent CLI invocations.
- Valid identities map ID and name.
- Invalid field types are rejected and logged through the existing invalid-row path.
- Existing query bounds, cohort filters, total metadata, and row limit stay intact.

### Pure model

- no CLI → **No CLI invoked**;
- only non-agent CLI events → **No agent**;
- one agent across repeated commands → that agent once;
- two unique agents → **Multiple agents**;
- detected event without identity → **Unknown agent**;
- known plus unknown detected invocation → **Multiple agents**;
- actions belong only to the latest eligible Setup anchor;
- actions exactly at the next anchor or 24-hour boundary follow existing half-open semantics;
- daily totals equal Setup person-day totals;
- missing dates are zero-filled;
- group ordering is deterministic.

### Frontend

- API types accept dynamic agent groups and daily counts.
- the series mapper preserves dates, filters zero-total groups, and assigns stable colors;
- **No CLI invoked** is retained when it is the only active group;
- the new card appears directly after the existing daily CLI-outcomes card;
- the existing chart remains unchanged;
- translation keys exist for the title, description, and reserved labels.

## Acceptance Criteria

- Every qualifying v2–v4 Setup person-day appears exactly once in the new chart.
- `app list` and other actor-scoped commands can contribute without app/org properties.
- Unrelated CLI activity is excluded unless the person reached the qualifying Setup step and the invocation falls in its ownership window.
- Agent identities are visible by name, multi-agent usage is not double-counted, and non-agent/no-CLI behavior remains visible.
- The chart is directly below **Daily Setup → CLI outcomes (v2–v4)**.
- Relevant backend and frontend unit tests, lint, typecheck, and build pass.
