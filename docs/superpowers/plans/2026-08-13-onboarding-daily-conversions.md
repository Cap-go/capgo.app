# Onboarding Daily Conversion Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three day-by-day onboarding stage-conversion column charts to the admin frontend-onboarding dashboard.

**Architecture:** Extend the existing frontend-onboarding analytics reducer and response instead of adding a query or endpoint. A focused reusable Vue/Chart.js component renders nullable daily percentages and count-aware tooltips; the existing dashboard page passes the response points directly into three cards between the v2 funnel and v2 journey graph.

**Tech Stack:** TypeScript, Vue 3, Chart.js/vue-chartjs, PostHog HogQL response model, Vitest, vue-i18n.

---

## Task 1: Add daily conversion analytics to the existing backend model

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`
- Test: `tests/frontend-onboarding-analytics-model.unit.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Add fixtures that assert:

```ts
expect(analytics.daily_conversions.intent_to_details).toEqual([
  { date: '2026-08-01', started: 3, converted: 2, conversion_percent: 2 / 3 * 100 },
  { date: '2026-08-02', started: 0, converted: 0, conversion_percent: null },
])
expect(analytics.daily_conversions.details_to_organization[0]).toMatchObject({ started: 1, converted: 1 })
expect(analytics.daily_conversions.organization_to_setup[0]).toMatchObject({ started: 1, converted: 1 })
```

Cover combined v1/v2 only for the first transition, v2-only later transitions, source-stage UTC attribution, exact 24-hour inclusion, late-stage exclusion, and null percentage for zero denominators.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `bun vitest run tests/frontend-onboarding-analytics-model.unit.test.ts`

Expected: failure because `daily_conversions` does not exist.

- [ ] **Step 3: Implement the minimal reducer**

Add:

```ts
export interface FrontendOnboardingDailyConversion {
  date: string
  started: number
  converted: number
  conversion_percent: number | null
}
```

Build each series by grouping eligible attempts on the UTC date of its source-stage timestamp. Count destination-stage timestamps only when they are not before the source stage and remain inside the existing inclusive Intent→24h follow-up window. Return a point for every UTC day in the selected range.

- [ ] **Step 4: Run the focused test**

Run: `bun vitest run tests/frontend-onboarding-analytics-model.unit.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit backend analytics**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts tests/frontend-onboarding-analytics-model.unit.test.ts
git commit -m "feat(admin): calculate daily onboarding conversions"
```

### Task 2: Add a reusable daily conversion column chart

**Files:**
- Create: `src/components/admin/AdminDailyConversionChart.vue`
- Create: `src/components/admin/adminDailyConversionChart.ts`
- Create: `tests/admin-daily-conversion-chart.unit.test.ts`

- [ ] **Step 1: Write failing chart-helper tests**

Test chart data and options with points shaped as:

```ts
[
  { date: '2026-08-01', started: 5, converted: 3, conversion_percent: 60 },
  { date: '2026-08-02', started: 0, converted: 0, conversion_percent: null },
]
```

Assert that the dataset preserves `null`, the vertical percentage scale has `min: 0` and `max: 100`, and tooltip callbacks expose `60%` plus `3 / 5 attempts` while producing no false 0% tooltip for the null point.

- [ ] **Step 2: Run the chart test and confirm it fails**

Run: `bun vitest run tests/admin-daily-conversion-chart.unit.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement pure Chart.js builders**

Create exported point/data/options types and builders. Use vertical bars, a single configurable color, local-date labels, hidden legend, dark-mode colors, 0–100% y-axis ticks, and count-aware tooltips. Keep all user-visible tooltip nouns supplied by the caller rather than hard-coded.

- [ ] **Step 4: Implement the Vue wrapper**

Register the necessary Chart.js controllers and accept `points`, `label`, `attemptsLabel`, `color`, and `isLoading` props. Render the existing admin spinner while loading and the `Bar` chart otherwise.

- [ ] **Step 5: Run chart tests and lint**

Run:

```bash
bun vitest run tests/admin-daily-conversion-chart.unit.test.ts
bun run lint
```

Expected: both commands pass.

- [ ] **Step 6: Commit the reusable chart**

```bash
git add src/components/admin/AdminDailyConversionChart.vue src/components/admin/adminDailyConversionChart.ts tests/admin-daily-conversion-chart.unit.test.ts
git commit -m "feat(admin): add daily conversion chart"
```

### Task 3: Integrate the three charts into the onboarding dashboard

**Files:**
- Modify: `src/services/adminFrontendOnboarding.ts`
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue`
- Modify: `messages/en.json`
- Modify: `messages/en.context.json`
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Write failing response and placement tests**

Extend the analytics fixture with `daily_conversions`. Assert exactly three `AdminDailyConversionChart` instances and four `ChartCard` instances, and verify source ordering:

```ts
expect(v2FunnelIndex).toBeLessThan(intentDetailsChartIndex)
expect(intentDetailsChartIndex).toBeLessThan(detailsOrganizationChartIndex)
expect(detailsOrganizationChartIndex).toBeLessThan(organizationSetupChartIndex)
expect(organizationSetupChartIndex).toBeLessThan(graphIndex)
```

Assert all new English translation values and contexts.

- [ ] **Step 2: Run the focused dashboard tests and confirm failure**

Run: `bun vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts`

Expected: failures for missing response fields, adapter, translations, and chart components.

- [ ] **Step 3: Extend frontend response types**

Add the backend `daily_conversions` response shape to `FrontendOnboardingAnalytics` and pass those points directly to the reusable component.

- [ ] **Step 4: Render the charts**

Import `AdminDailyConversionChart`. Create computed values from `visibleAnalytics`, and insert three full-width `ChartCard` blocks directly after the v2 funnel. Each card uses a distinct existing palette color, `isLoadingStats`, and `hasData` based on a positive source-stage denominator.

- [ ] **Step 5: Add translations and contexts**

Add titles for all three transitions, a daily-conversion chart label, and the tooltip attempts label to both English catalogs according to the repository translation-queue contract.

- [ ] **Step 6: Run focused frontend verification**

Run:

```bash
bun vitest run tests/admin-daily-conversion-chart.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
bun run lint
bun run typecheck:frontend
```

Expected: all commands pass.

- [ ] **Step 7: Commit dashboard integration**

```bash
git add src/services/adminFrontendOnboarding.ts src/pages/admin/dashboard/frontend-onboarding.vue messages/en.json messages/en.context.json tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): graph daily onboarding conversions"
```

### Task 4: Verify and publish the pull request

**Files:**
- Review all branch changes against `origin/main`

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun vitest run tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-daily-conversion-chart.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts tests/translation-queue.unit.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run repository checks**

Run:

```bash
bun run lint
bun run lint:backend
bun run typecheck
bun test:unit
bun run build
git diff --check origin/main...HEAD
```

Expected: all checks pass and no unrelated generated files remain staged or modified.

- [ ] **Step 3: Invoke the required PR-ready workflow**

Follow `/Users/michaltremblay/.agents/skills/pr-ready/SKILL.md`, address actionable review/CI findings, and repeat until the branch is stable green.

- [ ] **Step 4: Push and open the PR**

Push `wolny/onboarding-daily-conversions` and create a non-draft PR with a concise title that does not begin with `[CODEX]`. Include these sections, with the suffix shown on every heading: `Summary (AI generated)`, `Motivation (AI generated)`, `Business Impact (AI generated)`, and `Test Plan (AI generated)`.
