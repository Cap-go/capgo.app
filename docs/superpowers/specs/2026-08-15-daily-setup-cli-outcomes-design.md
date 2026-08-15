# Daily Setup → CLI Outcomes (v2) Design

**Status:** Approved for implementation planning

**Date:** 2026-08-15

## Summary

Add a new daily stacked-column chart to the onboarding analytics dashboard that explains what people do after reaching the v2 Setup page. Each UTC day contains two adjacent stacks: First-time and Returning. Each person can contribute to at most one mutually exclusive outcome per UTC day, and downstream actions are observed for up to 24 hours after that day's Setup anchor.

The existing aggregate **Setup → CLI outcomes (v2)** chart remains unchanged. The new chart reuses `AdminStackedBarChart` through a backward-compatible grouped-stack extension; it does not introduce another chart component.

## Problem

The existing aggregate Setup-to-CLI chart answers a range-level question and collapses each person across the full selected period. It also uses a broad onboarding-start signal. It cannot answer:

- how Setup cohorts behave day by day;
- whether a person is appearing for the first time or returning within the selected range;
- which Setup copy action preceded CLI activity;
- whether the person ran `init`, ran another CLI command, or ran no CLI command;
- whether a returning Setup view should own a later action instead of the earlier view.

Repeated Setup views are important product behavior, so the new chart needs person-day semantics rather than range-level unique-person semantics.

## Goals

- Show daily v2 Setup outcomes as adjacent First-time and Returning stacks.
- Count a person at most once per UTC day.
- Classify every counted person-day into exactly one of 12 outcomes.
- Observe copy and CLI events for the next 24 hours.
- Attribute an action only to the most recent eligible Setup day.
- Reuse and generically extend `AdminStackedBarChart`.
- Show only outcome categories that actually occur in the displayed range.
- Keep the existing aggregate Setup-to-CLI graph and its semantics unchanged.

## Non-goals

- Replacing or modifying the existing **Setup → CLI outcomes (v2)** graph.
- Changing the existing range-level `v2_setup_cli_outcomes` API field.
- Defining First-time against a person's complete product history. It is relative to the selected date range.
- Counting onboarding attempts rather than people.
- Introducing a database migration or persistent analytics table.
- Introducing a new chart component.
- Treating broad `onboarding-v2` channel or Builder onboarding-step events as proof that `init` was run in this new chart. The new chart distinguishes actual CLI command invocations.

## Definitions

### Setup anchor

A Setup anchor is the first qualifying v2 Setup view for one PostHog person on one UTC calendar day:

- event: `onboarding_step_viewed`;
- `properties.flow = 'pre_org'`;
- `properties.onboarding_version = 2`;
- `properties.step = 'setup'`.

Later Setup views by that person on the same UTC day do not create another cohort entry and do not reset the 24-hour window.

### First-time and Returning

First-time and Returning are calculated only from Setup anchors inside the selected range:

- the person's earliest Setup day in the selected range is First-time;
- every later Setup day in the selected range is Returning;
- Setup views before the selected range are intentionally ignored.

This means changing the selected date range can change whether a day is labelled First-time or Returning.

### Copy signals

- CLI command copied: `onboarding_cli_command_copied`.
- AI instructions copied: `onboarding_ai_instructions_copied`.

Both copy signals must also have `properties.flow = 'pre_org'`, `properties.onboarding_version = 2`, and `properties.step = 'setup'`. Copy order does not matter. Both flags can be true for one person-day.

### CLI signals

- Init run: `CLI Command Invoked` with `properties.command_path = 'init'`.
- Other CLI run: `CLI Command Invoked` with a non-`init` command path.

If both Init and Other CLI are present, Init takes precedence when selecting the outcome.

## Attribution Window

Each Setup anchor owns a half-open action window beginning at the anchor timestamp:

```text
[setup anchor, min(setup anchor + 24 hours, next Setup anchor))
```

The next Setup anchor is the person's next qualifying UTC-day anchor, including an ownership-only anchor in the 24-hour tail after the selected range. Truncating the earlier window at the next anchor ensures one action cannot upgrade two daily columns.

Ownership-only anchors after the selected end are not emitted as chart cohorts and do not affect First-time/Returning labels. They exist only to prevent the final displayed day from claiming actions that actually followed a newer Setup view. For example, a September 1 Setup view can truncate an August 31 window when August is selected, but September 1 is not displayed.

Example:

- August 3: person reaches Setup for the first time.
- August 4: the same person reaches Setup again and then runs `init`.
- The `init` action belongs only to August 4 Returning.
- August 3 remains classified from the actions assigned before the August 4 anchor, potentially No action.

An action exactly at a new Setup anchor belongs to the new anchor. An action exactly 24 hours after an anchor is outside that anchor's window.

## Outcome Taxonomy

Every Setup person-day maps to exactly one outcome.

| Key | Init run | Other CLI run | Copy combination | Display label |
| --- | --- | --- | --- | --- |
| `cli_copy_init` | Yes | Any | CLI only | CLI copy + init |
| `ai_copy_init` | Yes | Any | AI only | AI copy + init |
| `both_copy_init` | Yes | Any | Both | Both copied + init |
| `no_copy_init` | Yes | Any | Neither | No copy + init |
| `cli_copy_other_cli` | No | Yes | CLI only | CLI copy + other CLI |
| `ai_copy_other_cli` | No | Yes | AI only | AI copy + other CLI |
| `both_copy_other_cli` | No | Yes | Both | Both copied + other CLI |
| `no_copy_other_cli` | No | Yes | Neither | No copy + other CLI |
| `cli_copy_no_cli` | No | No | CLI only | CLI copied · no CLI run |
| `ai_copy_no_cli` | No | No | AI only | AI copied · no CLI run |
| `both_copy_no_cli` | No | No | Both | Both copied · no CLI run |
| `no_action` | No | No | Neither | No action |

Classification order is:

1. If Init was run, choose one of the four Init outcomes from the copy flags.
2. Otherwise, if another CLI command was run, choose one of the four Other CLI outcomes.
3. Otherwise, choose one of the three copied-with-no-CLI outcomes or No action.

## Backend Data Flow

### Dedicated PostHog query

The current onboarding analytics query groups by onboarding attempt and retains only the earliest Setup timestamp for that attempt. Extending that result would lose repeated daily Setup views. Add a dedicated HogQL query for the new graph and leave `buildFrontendOnboardingHogql` and `v2_setup_cli_outcomes` unchanged.

The new query will:

1. Identify people with a qualifying Setup event inside the selected range.
2. For only those cohort people, read qualifying Setup events from the selected start through the 24-hour follow-up tail.
3. Read the two qualifying v2/pre-org/Setup copy events and all `CLI Command Invoked` events for the same cohort people through `selected end + 24 hours`.
4. Return normalized event rows containing the person ID, timestamp, event kind, and CLI command path when applicable.

Restricting action rows to people who reached Setup avoids scanning unrelated CLI identities in the result set. The query must expose total-row metadata and use an explicit row limit. The server must fail loudly and log when the total exceeds the limit rather than returning a truncated chart.

### Pure analytics model

A pure TypeScript model will:

- validate the normalized PostHog rows;
- group Setup events into the first anchor per person and UTC day;
- mark anchors inside the selected range as display cohorts and tail anchors as ownership-only;
- derive First-time/Returning from display cohorts only;
- assign each copy and CLI event to the most recent eligible Setup anchor using the half-open attribution window;
- classify each person-day into one outcome key;
- aggregate counts by UTC date and lifecycle;
- zero-fill every UTC date in the selected range;
- return all outcome keys with numeric counts, including zeros.

Keeping anchoring, attribution, classification, and date filling in a pure model makes the complete business rule directly unit-testable and avoids duplicating it in HogQL or embedding display labels there.

### API response

Extend `FrontendOnboardingAnalytics` with a new field; do not change the existing aggregate field:

```ts
type DailySetupCliOutcomeKey =
  | 'cli_copy_init'
  | 'ai_copy_init'
  | 'both_copy_init'
  | 'no_copy_init'
  | 'cli_copy_other_cli'
  | 'ai_copy_other_cli'
  | 'both_copy_other_cli'
  | 'no_copy_other_cli'
  | 'cli_copy_no_cli'
  | 'ai_copy_no_cli'
  | 'both_copy_no_cli'
  | 'no_action'

interface DailySetupCliOutcomePoint {
  date: string
  first_time: Record<DailySetupCliOutcomeKey, number>
  returning: Record<DailySetupCliOutcomeKey, number>
}
```

The response field is `daily_setup_cli_outcomes: DailySetupCliOutcomePoint[]`.

The endpoint should execute the existing analytics query and the new dedicated query within the same request. If either fails or is truncated, the existing dashboard error state is used; partial results must not be presented as complete analytics.

## Chart Component Extension

Extend `AdminStackedBarChart` without changing existing callers:

- add optional `stack` metadata to a series/dataset;
- add optional human-readable `stackLabel` metadata for tooltips;
- pass `stack` through to Chart.js so equal stack IDs combine and different stack IDs render side by side;
- preserve current behavior when `stack` is absent;
- compute tooltip totals from datasets in the hovered stack only when stack metadata is present;
- include the stack label in grouped-stack tooltips;
- deduplicate legend entries that share an outcome label;
- make a deduplicated legend item toggle every dataset with that outcome label;
- omit legend entries whose matching datasets total zero across the displayed range.

For the new graph, each active outcome produces two datasets with the same label and color:

- `stack = 'first_time'`, displayed on the left;
- `stack = 'returning'`, displayed on the right.

The frontend includes both lifecycle datasets for an active outcome so the paired layout stays stable. An outcome is active when either lifecycle has a non-zero count anywhere in the selected range.

## Dashboard Presentation

Add a new `ChartCard` immediately after the existing aggregate **Setup → CLI outcomes (v2)** card.

- Title: **Daily Setup → CLI outcomes (v2)**.
- Description: explain that each person is counted once per UTC day, the left stack is First-time, the right stack is Returning, and actions use the next 24 hours.
- Do not show a range-level people total in the card header because the measure is person-days and a returning person can legitimately appear on multiple dates.
- Use one consistent color per outcome across both lifecycle stacks.
- Use related color families for Init, Other CLI, and No CLI outcomes; reserve a neutral gray for No action.
- Render First-time on the left and Returning on the right for every date.
- Keep zero-count dates on the x-axis to preserve the complete selected daily range.
- If the whole range has no Setup person-days, use the existing `ChartCard` empty state.

### Legend behavior

The legend is derived from the displayed data:

- show an outcome once if its combined First-time and Returning count is greater than zero anywhere in the selected range;
- do not show categories that are zero throughout the range;
- never show separate duplicate legend items for First-time and Returning;
- retain First-time/Returning distinction through column position and tooltip text.

### Tooltip behavior

For the hovered stack, show:

- UTC date;
- First-time or Returning;
- outcome label;
- person count;
- percentage of that lifecycle stack's total for the day.

The denominator must not combine First-time and Returning.

## Error Handling and Empty States

- Invalid dates and ranges continue to use the endpoint's existing validation.
- The action query boundary must be derived safely as `end + 24 hours` and remain within the supported PostHog timestamp range.
- Invalid row shapes are rejected instead of coerced into misleading counts.
- Query failures and row-limit overflow fail the analytics request and are logged with request ID and total/limit metadata.
- A valid query with no Setup anchors returns the complete date range with zero counts; the frontend displays the chart card's normal no-data state.

## Testing Strategy

### Backend model tests

- all 12 mutually exclusive categories;
- copy order does not affect the category;
- Init takes precedence over Other CLI;
- one person is counted once on a UTC day despite repeated Setup views;
- the first selected-range Setup day is First-time and later days are Returning;
- Setup history before the selected range does not change lifecycle classification;
- an action in overlapping nominal 24-hour windows belongs only to the most recent Setup anchor;
- an ownership-only Setup anchor after the selected end truncates the final displayed anchor without appearing in the result;
- actions at the next anchor and at the 24-hour boundary follow the half-open interval rules;
- UTC day boundaries and zero-filled missing dates;
- totals across all categories equal the number of Setup person-days for each date/lifecycle.

### Query and endpoint tests

- the query filters v2 pre-org Setup events correctly;
- both copy events require v2/pre-org/Setup properties, and all `CLI Command Invoked` events are selected;
- the action boundary extends exactly 24 hours beyond the selected end;
- event-row total metadata and row-limit overflow are validated;
- the existing analytics response fields and aggregate outcome graph remain unchanged;
- a new-query failure produces the established analytics error behavior rather than partial data.

### Chart and frontend tests

- ungrouped existing `AdminStackedBarChart` callers retain current data and tooltip behavior;
- grouped datasets render with two stack IDs;
- grouped tooltip percentages use only the hovered stack;
- duplicate outcome legend labels collapse into one item;
- toggling a deduplicated legend item toggles both lifecycle datasets;
- zero-only categories are absent from the legend;
- a category present only in one lifecycle still appears once;
- the series mapper preserves every date and filters only range-wide zero outcomes;
- the existing aggregate chart remains rendered and the new daily chart is rendered separately below it;
- all new user-facing strings are translation keys in `messages/en.json` with no inline fallback text.

## Expected Implementation Areas

- `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`
- `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`
- `src/services/adminFrontendOnboarding.ts`
- `src/components/admin/AdminStackedBarChart.vue`
- `src/components/admin/adminStackedBarChart.ts`
- `src/pages/admin/dashboard/frontend-onboarding.vue`
- `messages/en.json`
- existing onboarding analytics, dashboard, and stacked-chart unit tests

## Acceptance Criteria

- The existing aggregate Setup-to-CLI chart is visually and semantically unchanged.
- A separate daily chart displays paired First-time and Returning stacks for every selected UTC date.
- Each Setup person-day belongs to exactly one of the 12 approved outcomes.
- Actions are attributed only to the latest eligible Setup anchor within 24 hours.
- The legend contains only outcomes present somewhere in the displayed range and contains no lifecycle duplicates.
- Existing `AdminStackedBarChart` usages remain backward compatible.
- Backend, frontend model, chart-helper, dashboard, lint, and type-check validation pass.
