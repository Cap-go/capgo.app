# Frontend Onboarding v2 Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing admin analytics endpoint and dashboard to compare onboarding v1/v2, show a real v2 funnel, and populate the configurable v2 interaction graph from distinct PostHog onboarding attempts.

**Architecture:** Keep one PostHog HogQL request that returns one row per onboarding version and `onboarding_attempt_id`. Extend the existing pure reducer to produce v2 KPIs, split daily attempts, two funnels, and v2 interaction counts; keep graph hierarchy and percentages in frontend configuration. Reuse the current endpoint, loader, stacked chart, funnel chart, and graph prototype.

**Tech Stack:** Vue 3 Composition API, TypeScript, Tailwind CSS, Chart.js, Hono, PostHog HogQL, Vitest, Bun.

---

## File Structure

- Modify `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`: version-aware attempt model and pure aggregation for KPI, daily, funnel, and interaction counts.
- Modify `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`: one version-aware HogQL query and row mapping.
- Modify `src/services/adminFrontendOnboarding.ts`: response types and pure frontend adapters for daily series, funnels, and graph metrics.
- Modify `src/pages/admin/dashboard/frontend-onboarding.vue`: remove demo Organization interaction nodes, bind real analytics, add the v2 funnel, and rename/move the legacy funnel.
- Keep `src/components/admin/AdminOnboardingJourneyGraph.vue`: reusable HTML/SVG renderer created by the prototype; only make corrections required by real data binding.
- Keep `src/components/admin/adminOnboardingJourneyGraph.ts`: reusable graph configuration types created by the prototype.
- Modify `messages/en.json`: v2/legacy titles, series labels, and remove demo-only copy from the page.
- Modify `tests/frontend-onboarding-analytics-model.unit.test.ts`: reducer behavior.
- Modify `tests/frontend-onboarding-analytics.unit.test.ts`: HogQL and row-mapping behavior.
- Modify `tests/admin-frontend-onboarding-dashboard.unit.test.ts`: frontend adapters and page contract.

Do not add another endpoint, PostHog query, database migration, persistence mechanism, retry layer, or generalized analytics framework.

### Task 1: Extend the pure backend analytics model

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`
- Test: `tests/frontend-onboarding-analytics-model.unit.test.ts`

- [ ] **Step 1: Update the test fixture to identify attempt version and interaction events**

Add version and unique interaction-event collections to every test attempt:

```ts
function attempt(
  attemptId: string,
  onboardingVersion: 1 | 2,
  intentMs: number,
  detailsMs: number | null,
  organizationMs: number | null,
  setupMs: number | null,
  interactionEvents: string[] = [],
): FrontendOnboardingAttempt {
  return {
    attemptId,
    onboardingVersion,
    intentMs,
    detailsMs,
    organizationMs,
    setupMs,
    interactionEvents,
  }
}
```

- [ ] **Step 2: Write failing tests for v2 KPIs, split daily attempts, two funnels, and interaction counts**

Use a current-period fixture containing v1 and v2 attempts plus a previous-period v2 attempt. Assert the complete output shape:

```ts
expect(result.daily_attempts).toEqual([
  { date: '2026-08-10', v1_attempts: 1, v2_attempts: 2 },
  { date: '2026-08-11', v1_attempts: 0, v2_attempts: 0 },
])

expect(result.funnels.v1.map(stage => stage.reached)).toEqual([1, 1, 1, 0])
expect(result.funnels.v2.map(stage => stage.reached)).toEqual([2, 2, 1, 1])

expect(result.kpis).toMatchObject({
  attempts: 2,
  completed: 1,
  completion_rate: 50,
})

expect(result.v2_graph.nodes).toEqual([
  { key: 'onboarding_app_name_entered', count: 2 },
  { key: 'onboarding_store_import_shown', count: 1 },
  { key: 'onboarding_store_import_hidden', count: 1 },
])
```

Include the same interaction event twice in one attempt fixture and assert its count remains one for that attempt. Include a v1 attempt with the same interaction string and assert it is ignored by `v2_graph`.

- [ ] **Step 3: Run the model tests and confirm the old shape fails**

Run:

```bash
bun vitest run tests/frontend-onboarding-analytics-model.unit.test.ts
```

Expected: FAIL because attempts lack version/event fields and the reducer still returns one funnel plus one daily count.

- [ ] **Step 4: Add the version-aware model and response types**

Replace the single-version constant with the supported versions and extend the attempt/response interfaces:

```ts
export const FRONTEND_ONBOARDING_VERSIONS = [1, 2] as const
export type FrontendOnboardingVersion = typeof FRONTEND_ONBOARDING_VERSIONS[number]

export interface FrontendOnboardingAttempt {
  attemptId: string
  onboardingVersion: FrontendOnboardingVersion
  intentMs: number
  detailsMs: number | null
  organizationMs: number | null
  setupMs: number | null
  interactionEvents: string[]
}

export interface FrontendOnboardingDailyAttempt {
  date: string
  v1_attempts: number
  v2_attempts: number
}

export interface FrontendOnboardingGraphNodeCount {
  key: string
  count: number
}

export interface FrontendOnboardingAnalytics {
  kpis: FrontendOnboardingPeriodKpis & { comparison: FrontendOnboardingComparison }
  daily_attempts: FrontendOnboardingDailyAttempt[]
  funnels: {
    v1: FrontendOnboardingFunnelStage[]
    v2: FrontendOnboardingFunnelStage[]
  }
  v2_graph: {
    nodes: FrontendOnboardingGraphNodeCount[]
  }
}
```

- [ ] **Step 5: Split attempts by version and reuse the existing funnel/KPI helpers**

Keep `buildFunnel`, `summarizePeriod`, `findLargestDropoff`, and `comparePeriods`. In `buildFrontendOnboardingAnalytics`, form version cohorts explicitly:

```ts
const currentV1Attempts = currentAttempts.filter(attempt => attempt.onboardingVersion === 1)
const currentV2Attempts = currentAttempts.filter(attempt => attempt.onboardingVersion === 2)
const previousV2Attempts = previousAttempts.filter(attempt => attempt.onboardingVersion === 2)

const currentV2 = summarizePeriod(currentV2Attempts)
const previousV2 = summarizePeriod(previousV2Attempts)
```

Return `currentV2.kpis` with comparison against `previousV2.kpis`, and return `buildFunnel(currentV1Attempts)` plus `currentV2.funnel` under `funnels`.

- [ ] **Step 6: Build the split daily series and v2 graph counts**

Replace the daily counter with two version counters:

```ts
function buildDailyAttempts(
  attempts: FrontendOnboardingAttempt[],
  startMs: number,
  endMs: number,
): FrontendOnboardingDailyAttempt[] {
  const attemptsByDate = new Map<string, { v1: number, v2: number }>()
  for (const attempt of attempts) {
    const date = utcDate(attempt.intentMs)
    const counts = attemptsByDate.get(date) ?? { v1: 0, v2: 0 }
    if (attempt.onboardingVersion === 1)
      counts.v1++
    else
      counts.v2++
    attemptsByDate.set(date, counts)
  }

  // Preserve the existing UTC date loop and emit zero-filled entries.
  return days.map(date => ({
    date,
    v1_attempts: attemptsByDate.get(date)?.v1 ?? 0,
    v2_attempts: attemptsByDate.get(date)?.v2 ?? 0,
  }))
}
```

Count unique event names once per v2 attempt:

```ts
function buildV2GraphNodes(attempts: FrontendOnboardingAttempt[]): FrontendOnboardingGraphNodeCount[] {
  const counts = new Map<string, number>()
  for (const attempt of attempts) {
    for (const event of new Set(attempt.interactionEvents))
      counts.set(event, (counts.get(event) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, count }))
}
```

- [ ] **Step 7: Run the model tests**

Run:

```bash
bun vitest run tests/frontend-onboarding-analytics-model.unit.test.ts
```

Expected: PASS, including existing follow-up-window, median, comparison, empty-data, and date-range tests.

- [ ] **Step 8: Commit the pure model change**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts tests/frontend-onboarding-analytics-model.unit.test.ts
git commit -m "feat(admin): aggregate onboarding analytics by version"
```

### Task 2: Extend the single PostHog query and row mapper

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`
- Test: `tests/frontend-onboarding-analytics.unit.test.ts`

- [ ] **Step 1: Write failing HogQL contract tests**

Update the query test to require both versions, grouping by version and attempt ID, and one unique interaction-event array:

```ts
expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) IN (1, 2)')
expect(query).toContain('GROUP BY onboarding_version, attempt_id')
expect(query).toContain("groupUniqArrayIf(event, event != 'onboarding_step_viewed') AS interaction_events")
expect(query).toContain("event = 'onboarding_step_viewed'")
expect(query).toContain("event IN ('onboarding_app_id_entered'")
```

Retain assertions for strict date interpolation, Intent cohorting, ordering, the explicit `LIMIT 50000`, `count() OVER ()`, and the 24-hour follow-up boundary.

- [ ] **Step 2: Write failing row-mapping tests**

Return PostHog rows for v1 and v2 and assert the endpoint response contains split analytics. Include repeated interaction names in `interaction_events` to prove the pure reducer deduplicates them:

```ts
{
  onboarding_version: 2,
  attempt_id: 'attempt-v2',
  total_attempts: 2,
  intent_ms: currentStartMs + 1_000,
  details_ms: currentStartMs + 2_000,
  organization_ms: currentStartMs + 3_000,
  setup_ms: currentStartMs + 4_000,
  interaction_events: [
    'onboarding_app_name_entered',
    'onboarding_app_name_entered',
    'onboarding_store_import_shown',
  ],
}
```

Assert malformed versions and non-array `interaction_events` rows are ignored or mapped to an empty interaction list without throwing. Keep the attempt total fail-closed assertions.

- [ ] **Step 3: Run the transport tests and confirm they fail**

Run:

```bash
bun vitest run tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: FAIL because the query filters only version 1 and `mapAttempts` does not map version or interactions.

- [ ] **Step 4: Define the narrow v2 interaction allowlist in the query module**

Keep the allowlist next to the HogQL builder:

```ts
export const FRONTEND_ONBOARDING_V2_INTERACTION_EVENTS = [
  'onboarding_app_id_entered',
  'onboarding_app_id_help_opened',
  'onboarding_app_icon_picked',
  'onboarding_app_icon_picker_closed_without_selection',
  'onboarding_app_icon_picker_open_failed',
  'onboarding_app_icon_picker_opened',
  'onboarding_app_icon_upload_failed',
  'onboarding_app_icon_uploaded',
  'onboarding_app_name_entered',
  'onboarding_store_import_failed',
  'onboarding_store_import_hidden',
  'onboarding_store_import_shown',
  'onboarding_store_import_submitted',
  'onboarding_store_import_succeeded',
  'onboarding_store_url_entered',
] as const
```

Use `sqlStr` to build the SQL list rather than interpolating unchecked input.

- [ ] **Step 5: Extend the existing HogQL query instead of adding another request**

Build one grouped result:

```sql
SELECT
  onboarding_version,
  attempt_id,
  count() OVER () AS total_attempts,
  toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'intent')) AS intent_ms,
  toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'details')) AS details_ms,
  toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'organization')) AS organization_ms,
  toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'setup')) AS setup_ms,
  groupUniqArrayIf(event, event != 'onboarding_step_viewed') AS interaction_events
FROM (
  SELECT
    timestamp,
    event,
    JSONExtractString(toString(properties), 'onboarding_attempt_id') AS attempt_id,
    JSONExtractString(toString(properties), 'step') AS step,
    toIntOrZero(toString(properties.onboarding_version)) AS onboarding_version
  FROM events
  WHERE JSONExtractString(toString(properties), 'flow') = 'pre_org'
    AND toIntOrZero(toString(properties.onboarding_version)) IN (1, 2)
    AND (event = 'onboarding_step_viewed' OR event IN (${interactionEventSql}))
    AND timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
    AND timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
)
WHERE trim(attempt_id) != ''
GROUP BY onboarding_version, attempt_id
HAVING intent_ms >= toUnixTimestamp64Milli(parseDateTimeBestEffort(${sqlStr(startDate)}))
  AND intent_ms < toUnixTimestamp64Milli(parseDateTimeBestEffort(${sqlStr(cohortEndDate)}))
ORDER BY intent_ms ASC, onboarding_version ASC, attempt_id ASC
LIMIT 50000
```

Do not add sequence validation or joins. Interaction events are simply collected by attempt ID inside the existing query window.

- [ ] **Step 6: Map version and interaction arrays safely**

Extend `mapAttempts` with small scalar helpers:

```ts
function onboardingVersion(value: unknown): 1 | 2 | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return parsed === 1 || parsed === 2 ? parsed : null
}

function interactionEvents(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((event): event is string => typeof event === 'string' && event.trim() !== '')
    : []
}
```

Skip rows without a valid attempt ID, Intent timestamp, or supported version. Pass valid rows into the pure model unchanged otherwise.

- [ ] **Step 7: Return the combined response without a misleading single-version field**

Remove `onboarding_version: FRONTEND_ONBOARDING_VERSION` from the endpoint wrapper:

```ts
return {
  ...analytics,
  posthog_configured: posthog.configured,
  posthog_connected: posthog.connected,
}
```

- [ ] **Step 8: Run backend analytics tests and lint**

Run:

```bash
bun vitest run tests/frontend-onboarding-analytics.unit.test.ts tests/frontend-onboarding-analytics-model.unit.test.ts
bun run lint:backend
```

Expected: all focused tests PASS and backend lint exits 0.

- [ ] **Step 9: Commit the transport change**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics.ts tests/frontend-onboarding-analytics.unit.test.ts
git commit -m "feat(admin): query onboarding v1 and v2 attempts"
```

### Task 3: Update frontend response adapters

**Files:**
- Modify: `src/services/adminFrontendOnboarding.ts`
- Test: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Write failing tests for the split daily series and dual funnels**

Update the analytics fixture to the approved response shape and assert:

```ts
expect(buildFrontendOnboardingDailySeries(
  analytics.daily_attempts,
  'Onboarding v1',
  'Onboarding v2',
)).toEqual([
  {
    label: 'Onboarding v1',
    color: '#a78bfa',
    data: [{ date: '2026-08-10', value: 4 }],
  },
  {
    label: 'Onboarding v2',
    color: '#06b6d4',
    data: [{ date: '2026-08-10', value: 6 }],
  },
])

expect(buildFrontendOnboardingFunnelStages(analytics.funnels.v2)).toHaveLength(4)
expect(buildFrontendOnboardingFunnelStages(analytics.funnels.v1)).toHaveLength(4)
```

- [ ] **Step 2: Write failing graph-metric tests**

Define only the relationship metadata needed for percentages:

```ts
const graphDefinitions = [
  { key: 'onboarding_app_name_entered' },
  { key: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_import_hidden', parentKey: 'onboarding_store_import_shown' },
] as const

expect(buildFrontendOnboardingGraphMetrics(
  100,
  analytics.v2_graph.nodes,
  graphDefinitions,
)).toEqual({
  onboarding_app_name_entered: { count: 70, levelPercent: 70 },
  onboarding_store_import_shown: { count: 30, levelPercent: 30 },
  onboarding_store_import_hidden: { count: 18, levelPercent: 18, previousPercent: 60 },
})
```

Add a zero-App-details and zero-parent assertion returning zero percentages.

- [ ] **Step 3: Run the frontend unit test and confirm it fails**

Run:

```bash
bun vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the types and adapters still accept the v1-only response.

- [ ] **Step 4: Replace the v1-only response types**

Update `FrontendOnboardingAnalytics` to match the backend contract exactly. Remove the literal `onboarding_version: 1`, change `daily_attempts`, add `funnels`, and add `v2_graph` node counts.

Allow colors to be strings because the daily adapter now returns two stable colors:

```ts
export interface FrontendOnboardingDailySeries {
  label: string
  color: string
  data: Array<{ date: string, value: number }>
}
```

- [ ] **Step 5: Return two daily chart series**

```ts
export function buildFrontendOnboardingDailySeries(
  dailyAttempts: readonly FrontendOnboardingAnalytics['daily_attempts'][number][],
  v1Label: string,
  v2Label: string,
): FrontendOnboardingDailySeries[] {
  return [
    {
      label: v1Label,
      color: '#a78bfa',
      data: dailyAttempts.map(({ date, v1_attempts }) => ({ date, value: v1_attempts })),
    },
    {
      label: v2Label,
      color: '#06b6d4',
      data: dailyAttempts.map(({ date, v2_attempts }) => ({ date, value: v2_attempts })),
    },
  ]
}
```

- [ ] **Step 6: Add the small graph-metric adapter**

```ts
export interface FrontendOnboardingGraphDefinition {
  key: string
  parentKey?: string
}

export interface FrontendOnboardingGraphMetric {
  count: number
  levelPercent: number
  previousPercent?: number
}

export function buildFrontendOnboardingGraphMetrics(
  appDetailsCount: number,
  nodeCounts: readonly FrontendOnboardingAnalytics['v2_graph']['nodes'][number][],
  definitions: readonly FrontendOnboardingGraphDefinition[],
): Record<string, FrontendOnboardingGraphMetric> {
  const counts = new Map(nodeCounts.map(node => [node.key, node.count]))
  return Object.fromEntries(definitions.map((definition) => {
    const count = counts.get(definition.key) ?? 0
    const levelPercent = appDetailsCount > 0 ? count / appDetailsCount * 100 : 0
    const parentCount = definition.parentKey ? counts.get(definition.parentKey) ?? 0 : 0
    const previousPercent = definition.parentKey
      ? (parentCount > 0 ? count / parentCount * 100 : 0)
      : undefined
    return [definition.key, {
      count,
      levelPercent,
      ...(previousPercent === undefined ? {} : { previousPercent }),
    }]
  }))
}
```

Do not add sequence validation or clamp child percentages. Display the event counts that PostHog returned.

- [ ] **Step 7: Run the frontend adapter tests**

Run:

```bash
bun vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: PASS for the adapter tests; page source-contract tests may remain failing until Task 4.

- [ ] **Step 8: Commit the adapter change**

```bash
git add src/services/adminFrontendOnboarding.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): adapt onboarding v2 analytics"
```

### Task 4: Bind the real dashboard and finalize the graph prototype

**Files:**
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue`
- Modify: `src/components/admin/AdminOnboardingJourneyGraph.vue`
- Modify: `src/components/admin/adminOnboardingJourneyGraph.ts`
- Modify: `src/components.d.ts`
- Modify: `messages/en.json`
- Test: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Update the page contract test before changing the template**

Assert the approved structure and remove demo assumptions:

```ts
expect(source.match(/<AdminStackedBarChart(?:\s|\/?>)/g)).toHaveLength(1)
expect(source.match(/<AdminFunnelChart(?:\s|\/?>)/g)).toHaveLength(2)
expect(source.match(/<AdminOnboardingJourneyGraph(?:\s|\/?>)/g)).toHaveLength(1)
expect(source).toContain(`t('frontend-onboarding-funnel-v2')`)
expect(source).toContain(`t('frontend-onboarding-funnel-v1-legacy')`)
expect(source).not.toContain(`t('frontend-onboarding-demo-data')`)

const v2FunnelIndex = source.indexOf(`t('frontend-onboarding-funnel-v2')`)
const graphIndex = source.indexOf(`t('frontend-onboarding-graph-v2')`)
const legacyIndex = source.indexOf(`t('frontend-onboarding-funnel-v1-legacy')`)
expect(v2FunnelIndex).toBeLessThan(graphIndex)
expect(graphIndex).toBeLessThan(legacyIndex)
```

Assert temporary Organization interaction IDs and labels are absent:

```ts
expect(source).not.toContain("id: 'organization_name'")
expect(source).not.toContain("id: 'invite_opened'")
expect(source).not.toContain("id: 'notification_preference'")
```

- [ ] **Step 2: Run the page test and confirm it fails**

Run:

```bash
bun vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the page still has demo data, one funnel, and temporary Organization interaction nodes.

- [ ] **Step 3: Derive v1/v2 daily and funnel values from the response**

Replace the single funnel computed values:

```ts
const dailySeries = computed(() => buildFrontendOnboardingDailySeries(
  visibleAnalytics.value?.daily_attempts ?? [],
  t('frontend-onboarding-version-1'),
  t('frontend-onboarding-version-2'),
))

const v1FunnelStages = computed(() => buildFrontendOnboardingFunnelStages(
  visibleAnalytics.value?.funnels.v1 ?? [],
))
const v2FunnelStages = computed(() => buildFrontendOnboardingFunnelStages(
  visibleAnalytics.value?.funnels.v2 ?? [],
))
const v1FunnelSummaries = computed(() => buildFrontendOnboardingFunnelSummaries(
  visibleAnalytics.value?.funnels.v1 ?? [],
))
const v2FunnelSummaries = computed(() => buildFrontendOnboardingFunnelSummaries(
  visibleAnalytics.value?.funnels.v2 ?? [],
))
```

Keep KPI computed values unchanged because the backend now supplies v2 KPIs.

- [ ] **Step 4: Remove temporary Organization interaction nodes and their edges**

The graph config must retain these main stages:

```ts
{ id: 'intent', label: 'Intent', count: stageCounts.intent, totalPercent: 100, x: 145, y: 540, kind: 'stage', icon: 'intent' }
{ id: 'details', label: 'App details', count: stageCounts.details, totalPercent: stagePercents.details, parentPercent: stageConversions.details, x: 455, y: 540, kind: 'stage', icon: 'details' }
{ id: 'organization', label: 'Organization details', count: stageCounts.organization, totalPercent: stagePercents.organization, parentPercent: stageConversions.organization, x: 2200, y: 540, kind: 'stage', icon: 'organization', width: 280 }
{ id: 'setup', label: 'Setup reached', count: stageCounts.setup, totalPercent: stagePercents.setup, parentPercent: stageConversions.setup, x: 2600, y: 540, kind: 'stage', icon: 'setup', width: 250 }
```

Delete the temporary `organization_name`, `organization_size`, `invite_opened`, `invite_closed`, `invite_email`, `invite_sent`, `invite_failed`, and `notification_preference` nodes and every edge referencing them. Restore a direct independent stage arrow into Setup reached, keeping enough empty level-3 space to prevent overlap.

- [ ] **Step 5: Replace hard-coded graph counts with computed analytics metrics**

Define stable frontend relationship metadata for the App-details interactions:

```ts
const v2GraphDefinitions = [
  { key: 'onboarding_app_name_entered' },
  { key: 'onboarding_app_id_entered' },
  { key: 'onboarding_app_id_help_opened' },
  { key: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_import_hidden', parentKey: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_url_entered', parentKey: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_import_submitted', parentKey: 'onboarding_store_url_entered' },
  { key: 'onboarding_store_import_succeeded', parentKey: 'onboarding_store_import_submitted' },
  { key: 'onboarding_store_import_failed', parentKey: 'onboarding_store_import_submitted' },
  { key: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picker_open_failed', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picker_closed_without_selection', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picked', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_uploaded', parentKey: 'onboarding_app_icon_picked' },
  { key: 'onboarding_app_icon_upload_failed', parentKey: 'onboarding_app_icon_picked' },
] as const
```

Find the v2 App-details count from `analytics.funnels.v2`, build metrics, and merge them into the visual config by matching each visual node's event key. Main stage counts come from the v2 funnel. Preserve the prototype's coordinates, wrapping labels, node widths, percentage pills, and orthogonal connectors.

- [ ] **Step 6: Render sections in the approved order**

After the daily chart, render the v2 funnel section, then the graph, then the legacy funnel. Both funnel sections reuse the same markup shape and `AdminFunnelChart`; do not create another chart component.

Use these titles:

```json
{
  "frontend-onboarding-version-2": "Onboarding v2",
  "frontend-onboarding-funnel-v2": "Frontend onboarding funnel (v2)",
  "frontend-onboarding-funnel-v1-legacy": "Frontend onboarding funnel (v1, legacy)"
}
```

Remove the graph's `Demo data` badge. Keep the single date selector and existing whole-page loading/error behavior.

- [ ] **Step 7: Run page tests, lint, and frontend typecheck**

Run:

```bash
bun vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
bun run lint
bun run typecheck:frontend
```

Expected: all focused tests PASS; lint and frontend typecheck exit 0.

- [ ] **Step 8: Commit the dashboard integration**

```bash
git add src/pages/admin/dashboard/frontend-onboarding.vue src/components/admin/AdminOnboardingJourneyGraph.vue src/components/admin/adminOnboardingJourneyGraph.ts src/components.d.ts src/services/adminFrontendOnboarding.ts messages/en.json tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): show onboarding v2 journey analytics"
```

### Task 5: Verify the complete change without expanding scope

**Files:**
- Verify only; modify a listed implementation/test file only if a command exposes a regression caused by this feature.

- [ ] **Step 1: Run all focused analytics tests together**

```bash
bun vitest run tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: all focused test files PASS.

- [ ] **Step 2: Run repository lint and frontend/backend type checks**

```bash
bun run lint
bun run lint:backend
bun run typecheck:frontend
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the production build with polling to avoid the known watcher limit**

```bash
CHOKIDAR_USEPOLLING=1 bun run build
```

Expected: Vite production build succeeds.

- [ ] **Step 4: Inspect the live production-backed page**

Keep `bun run serve:prod-no-cors` running and inspect:

```text
http://127.0.0.1:5173/admin/dashboard/frontend-onboarding?range=30day
```

Verify:

- daily columns expose separate v1/v2 series;
- KPI cards represent v2;
- the v2 funnel appears above the graph;
- the graph uses real endpoint data and contains no demo badge;
- interaction nodes show `% of App details` and nested `% of previous`;
- temporary Organization interaction nodes are gone;
- Organization details and Setup reached remain main stages;
- the legacy funnel is the final page section;
- node labels do not truncate or overlap.

- [ ] **Step 5: Review the final diff for prohibited expansion**

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
git status --short
```

Confirm there are no migrations, new endpoints, refresh/session persistence, retry systems, event-order repair, or unrelated refactors.

- [ ] **Step 6: Commit only if verification required a scoped correction**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts supabase/functions/_backend/utils/frontend_onboarding_analytics.ts src/services/adminFrontendOnboarding.ts src/pages/admin/dashboard/frontend-onboarding.vue src/components/admin/AdminOnboardingJourneyGraph.vue src/components/admin/adminOnboardingJourneyGraph.ts src/components.d.ts messages/en.json tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "fix(admin): correct onboarding v2 analytics"
```

Skip this commit when verification required no changes.
