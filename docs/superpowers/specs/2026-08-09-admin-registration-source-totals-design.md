# Admin Registration Source Totals Design

## Goal

Add a compact three-card summary immediately below the existing **Registrations by source** stacked chart. Each card shows the total number of authentication accounts in one source category for the dashboard's selected date range.

## Scope

This is a frontend-only change. The admin statistics response already contains daily `registration_source_trend` points for:

- normal registrations;
- organization-invite registrations;
- authentication accounts without a public profile.

No endpoint, SQL query, database schema, or response shape changes are required.

## User Interface

Render one responsive row of three `AdminStatsCard` components directly below `AdminStackedBarChart`, inside the existing registration-source `ChartCard`:

1. **Normal registration** — blue, matching the chart series.
2. **Organization invite** — orange, matching the chart series.
3. **Without profile** — slate gray, matching the chart series.

Each card uses the subtitle **Selected period**. The row is one column on small screens and three columns from the medium breakpoint upward.

## Data Flow

Create a computed total for each category by summing its numeric value across every `registration_source_trend` point already returned for the active date range. The totals therefore update automatically whenever the dashboard filter reloads onboarding data.

The totals must be derived from the raw trend points, rather than the rendered chart-series objects, so summary behavior is independent of chart presentation details.

## States

- While onboarding data is loading, each card uses `AdminStatsCard`'s loading state.
- If the selected period contains trend points whose values sum to zero, the cards display `0`.
- If no trend points exist, the surrounding `ChartCard` keeps its current no-data behavior; the totals row is not rendered because it belongs to that chart's populated content.

## Testing

Extend the existing admin registration-source dashboard unit test before implementation. The test should require:

- a computed totals object sourced from `registration_source_trend`;
- one card for each of the three categories;
- the shared selected-period subtitle;
- the same blue, orange, and slate color classes used by the chart categories;
- placement of the totals row after `AdminStackedBarChart` and before the registration-source `ChartCard` closes.

Run the focused unit test red, implement the minimal frontend change, then run the focused test green along with lint, dead-code analysis, type checking, the full unit suite, and a production build before opening the PR.
