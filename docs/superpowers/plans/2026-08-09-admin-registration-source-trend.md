# Admin Registration Source Trend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily admin stacked-column chart that splits every new `auth.users` account into normal registration, organization invite, or missing profile.

**Architecture:** Extend the existing `onboarding_funnel` admin response with a date-filled aggregation sourced from `auth.users` and classified by a left join to `public.users`. Render that response through a focused reusable Chart.js stacked-bar component, then wire three translated series into the existing users dashboard and date-filter lifecycle.

**Tech Stack:** PostgreSQL, Drizzle SQL templates, Hono, Vue 3 Composition API, Chart.js, vue-chartjs, Vitest, Bun.

---

## Task 1: Add the auth-based registration source contract

**Files:**
- Modify: `tests/admin-stats.test.ts:59-71,381-418,682-712,1070-1160`
- Modify: `supabase/functions/_backend/utils/pg.ts:3160-3545`

- [ ] **Step 1: Write the failing integration assertions and fixtures**

Add two auth-only fixture IDs and timestamps next to the existing onboarding user constants:

```ts
const ONBOARDING_WITHOUT_PROFILE_USER_ID = randomUUID()
const ONBOARDING_END_BOUNDARY_USER_ID = randomUUID()
const ONBOARDING_REGISTER_CREATED_AT = '2026-02-01T09:00:00.000Z'
const ONBOARDING_WITHOUT_PROFILE_CREATED_AT = '2026-02-01T09:30:00.000Z'
const ONBOARDING_END_BOUNDARY_CREATED_AT = '2026-02-02T00:00:00.000Z'
```

In `beforeAll`, insert both IDs into `auth.users` without inserting corresponding `public.users` rows:

```ts
for (const [userId, email, createdAt] of [
  [ONBOARDING_WITHOUT_PROFILE_USER_ID, `admin-stats-onboarding-without-profile-${ONBOARDING_WITHOUT_PROFILE_USER_ID.slice(0, 8)}@capgo.app`, ONBOARDING_WITHOUT_PROFILE_CREATED_AT],
  [ONBOARDING_END_BOUNDARY_USER_ID, `admin-stats-onboarding-end-boundary-${ONBOARDING_END_BOUNDARY_USER_ID.slice(0, 8)}@capgo.app`, ONBOARDING_END_BOUNDARY_CREATED_AT],
] as const) {
  await executeSQL(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $4::timestamptz, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [userId, email, USER_PASSWORD_HASH, createdAt],
  )
}
```

Include both IDs in the existing `afterAll` auth cleanup array. Extend the onboarding payload type with:

```ts
registration_source_trend: Array<{
  date: string
  normal_registrations: number
  invite_registrations: number
  without_profile: number
}>
```

In the existing one-day onboarding test, assert the end boundary is exclusive:

```ts
expect(payload.data.registration_source_trend).toEqual([{
  date: '2026-02-01',
  normal_registrations: 4,
  invite_registrations: 1,
  without_profile: 1,
}])
```

Add a second focused test using `start_date = 2026-02-01T00:00:00.000Z` and
`end_date = 2026-02-04T00:00:00.000Z`, then assert:

```ts
expect(payload.data.registration_source_trend).toEqual([
  {
    date: '2026-02-01',
    normal_registrations: 4,
    invite_registrations: 1,
    without_profile: 1,
  },
  {
    date: '2026-02-02',
    normal_registrations: 0,
    invite_registrations: 0,
    without_profile: 1,
  },
  {
    date: '2026-02-03',
    normal_registrations: 0,
    invite_registrations: 0,
    without_profile: 0,
  },
])
```

- [ ] **Step 2: Run the focused integration test and verify RED**

Run:

```bash
bun run supabase:db:reset
bunx vitest run tests/admin-stats.test.ts -t "returns subscribed as the last onboarding funnel step without exceeding the bundle cohort|returns every auth registration in exactly one daily profile bucket"
```

Expected: FAIL because `registration_source_trend` is absent from the response.

- [ ] **Step 3: Implement the backend aggregation**

Extend `AdminOnboardingFunnel` with the same `registration_source_trend` item type used by the test. Add this query beside `inviteTrendQuery`:

```ts
const registrationSourceTrendQuery = sql`
  WITH date_series AS (
    SELECT generate_series(
      ${start_date}::timestamptz::date,
      (${end_date}::timestamptz::date - 1),
      '1 day'::interval
    )::date as date
  ),
  daily_registration_sources AS (
    SELECT
      au.created_at::date as date,
      COUNT(*) FILTER (
        WHERE u.id IS NOT NULL AND u.created_via_invite = false
      )::int as normal_registrations,
      COUNT(*) FILTER (
        WHERE u.id IS NOT NULL AND u.created_via_invite = true
      )::int as invite_registrations,
      COUNT(*) FILTER (WHERE u.id IS NULL)::int as without_profile
    FROM auth.users au
    LEFT JOIN public.users u ON u.id = au.id
    WHERE au.created_at >= ${start_date}::timestamptz
      AND au.created_at < ${end_date}::timestamptz
    GROUP BY au.created_at::date
  )
  SELECT
    ds.date,
    COALESCE(drs.normal_registrations, 0) as normal_registrations,
    COALESCE(drs.invite_registrations, 0) as invite_registrations,
    COALESCE(drs.without_profile, 0) as without_profile
  FROM date_series ds
  LEFT JOIN daily_registration_sources drs ON drs.date = ds.date
  ORDER BY ds.date ASC
`
```

Execute it in the existing `Promise.all`, map numeric values, and add it to the response:

```ts
const registrationSourceTrend = registrationSourceTrendResult.rows.map((row: any) => ({
  date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date),
  normal_registrations: Number(row.normal_registrations) || 0,
  invite_registrations: Number(row.invite_registrations) || 0,
  without_profile: Number(row.without_profile) || 0,
}))

registration_source_trend: registrationSourceTrend,
```

Place that property directly after `invite_trend: inviteTrend` in the existing
`AdminOnboardingFunnel` result. Return `registration_source_trend: []` directly
after `invite_trend: []` in the error fallback.

- [ ] **Step 4: Run the focused integration test and verify GREEN**

Run the command from Step 2.

Expected: PASS, including the auth-only account, exclusive end boundary, and zero-filled day.

- [ ] **Step 5: Commit the backend contract**

```bash
bun lint:backend
git add tests/admin-stats.test.ts supabase/functions/_backend/utils/pg.ts
git commit -m "feat(admin): report registration profile sources"
```

## Task 2: Build the reusable stacked-column chart

**Files:**
- Create: `tests/admin-stacked-bar-chart.unit.test.ts`
- Create: `src/components/admin/adminStackedBarChart.ts`
- Create: `src/components/admin/AdminStackedBarChart.vue`

- [ ] **Step 1: Write the failing chart behavior test**

Create `tests/admin-stacked-bar-chart.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildAdminStackedBarChartData,
  buildAdminStackedBarChartOptions,
  formatAdminStackedBarTooltip,
} from '../src/components/admin/adminStackedBarChart'

describe('admin stacked bar chart', () => {
  const series = [
    { label: 'Normal registration', data: [7, 4], color: '#3b82f6' },
    { label: 'Organization invite', data: [2, 1], color: '#f97316' },
    { label: 'Without profile', data: [1, 0], color: '#94a3b8' },
  ]

  it.concurrent('preserves dataset order and colors', () => {
    const data = buildAdminStackedBarChartData(['Aug 1', 'Aug 2'], series)

    expect(data.labels).toEqual(['Aug 1', 'Aug 2'])
    expect(data.datasets.map(dataset => ({
      label: dataset.label,
      data: dataset.data,
      backgroundColor: dataset.backgroundColor,
    }))).toEqual(series.map(item => ({
      label: item.label,
      data: item.data,
      backgroundColor: item.color,
    })))
  })

  it.concurrent('stacks both axes and starts counts at zero', () => {
    const options = buildAdminStackedBarChartOptions(false) as any

    expect(options.scales.x.stacked).toBe(true)
    expect(options.scales.y.stacked).toBe(true)
    expect(options.scales.y.beginAtZero).toBe(true)
  })

  it.concurrent('formats a segment as count and share of its day', () => {
    expect(formatAdminStackedBarTooltip('Organization invite', 2, 10)).toBe('Organization invite: 2 (20%)')
    expect(formatAdminStackedBarTooltip('Without profile', 0, 0)).toBe('Without profile: 0 (0%)')
  })
})
```

- [ ] **Step 2: Run the unit test and verify RED**

Run:

```bash
bunx vitest run tests/admin-stacked-bar-chart.unit.test.ts
```

Expected: FAIL because `adminStackedBarChart.ts` does not exist.

- [ ] **Step 3: Implement the tested chart helpers**

Create `src/components/admin/adminStackedBarChart.ts` with an exported series
interface and the three tested functions. `buildAdminStackedBarChartData` maps
each input series to one Chart.js dataset without reordering it.
`buildAdminStackedBarChartOptions` returns vertical, responsive options with
`interaction.mode = 'index'`, a bottom legend, count-formatted Y-axis ticks,
and `stacked: true` on both axes. Its tooltip callback must calculate the daily
total from every dataset at `context.dataIndex`, then delegate to:

```ts
export function formatAdminStackedBarTooltip(label: string, value: number, total: number) {
  const percentage = total > 0 ? (value / total) * 100 : 0
  return `${label}: ${formatNumberValue(value)} (${formatNumberValue(percentage, { maximumFractionDigits: 1 })}%)`
}
```

Create `AdminStackedBarChart.vue` as a thin renderer. It accepts:

```ts
interface DataSeries {
  label: string
  data: Array<{ date: string, value: number }>
  color: string
}
```

Register Chart.js `BarController`, `BarElement`, `CategoryScale`, `LinearScale`,
`Legend`, and `Tooltip`; format the first series' dates with `formatLocalDate`;
convert series values through `buildAdminStackedBarChartData`; compute theme-aware
options through `buildAdminStackedBarChartOptions`; and render `<Bar>` with the
same loading-container pattern as `AdminMultiLineChart.vue`.

- [ ] **Step 4: Run the chart unit test and verify GREEN**

Run the command from Step 2.

Expected: PASS with three tests.

- [ ] **Step 5: Commit the chart component**

```bash
bun lint:fix
git add tests/admin-stacked-bar-chart.unit.test.ts src/components/admin/adminStackedBarChart.ts src/components/admin/AdminStackedBarChart.vue
git commit -m "feat(admin): add stacked bar chart component"
```

## Task 3: Wire the three datasets into the users dashboard

**Files:**
- Create: `tests/admin-registration-source-dashboard.unit.test.ts`
- Modify: `src/pages/admin/dashboard/users.vue:8-70,1070-1110,1195-1230`
- Modify: `messages/en.json:1720-1740`

- [ ] **Step 1: Write the failing dashboard wiring test**

Create `tests/admin-registration-source-dashboard.unit.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('admin registration source dashboard', () => {
  it.concurrent('wires the auth registration trend to the stacked chart', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/users.vue', import.meta.url), 'utf8')

    expect(source).toContain('registration_source_trend')
    expect(source).toContain('AdminStackedBarChart')
    expect(source).toContain("t('normal-registration')")
    expect(source).toContain("t('organization-invite')")
    expect(source).toContain("t('without-profile')")
  })

  it.concurrent('defines every registration source label in English', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['registrations-by-source']).toBe('Registrations by source')
    expect(messages['registrations-by-source-description']).toBe('New authentication accounts grouped by their profile creation state')
    expect(messages['normal-registration']).toBe('Normal registration')
    expect(messages['organization-invite']).toBe('Organization invite')
    expect(messages['without-profile']).toBe('Without profile')
  })
})
```

- [ ] **Step 2: Run the dashboard unit test and verify RED**

Run:

```bash
bunx vitest run tests/admin-registration-source-dashboard.unit.test.ts
```

Expected: FAIL because the response property, component, and translations are not wired.

- [ ] **Step 3: Implement the dashboard series and card**

Import `AdminStackedBarChart`. Extend the frontend `OnboardingFunnelData` type:

```ts
registration_source_trend: Array<{
  date: string
  normal_registrations: number
  invite_registrations: number
  without_profile: number
}>
```

Add the computed series:

```ts
const registrationSourceTrendSeries = computed(() => {
  const trend = onboardingFunnelData.value?.registration_source_trend
  if (!trend || trend.length === 0)
    return []

  return [
    {
      label: t('normal-registration'),
      data: trend.map(item => ({ date: item.date, value: Number(item.normal_registrations) || 0 })),
      color: '#3b82f6',
    },
    {
      label: t('organization-invite'),
      data: trend.map(item => ({ date: item.date, value: Number(item.invite_registrations) || 0 })),
      color: '#f97316',
    },
    {
      label: t('without-profile'),
      data: trend.map(item => ({ date: item.date, value: Number(item.without_profile) || 0 })),
      color: '#94a3b8',
    },
  ]
})
```

Add the new card immediately before the existing Onboarding Trend card:

```vue
<ChartCard
  :title="t('registrations-by-source')"
  :is-loading="isLoadingOnboardingFunnel"
  :has-data="registrationSourceTrendSeries.length > 0"
>
  <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
    {{ t('registrations-by-source-description') }}
  </p>
  <AdminStackedBarChart
    :series="registrationSourceTrendSeries"
    :is-loading="isLoadingOnboardingFunnel"
  />
</ChartCard>
```

Add the exact five English translations asserted in Step 1 to `messages/en.json`.

- [ ] **Step 4: Run the dashboard and chart unit tests and verify GREEN**

Run:

```bash
bunx vitest run tests/admin-registration-source-dashboard.unit.test.ts tests/admin-stacked-bar-chart.unit.test.ts
```

Expected: PASS with five tests.

- [ ] **Step 5: Commit the dashboard integration**

```bash
bun lint:fix
git add tests/admin-registration-source-dashboard.unit.test.ts src/pages/admin/dashboard/users.vue messages/en.json
git commit -m "feat(admin): chart registration sources"
```

## Task 4: Verify the completed feature

**Files:**
- Verify: `supabase/functions/_backend/utils/pg.ts`
- Verify: `src/components/admin/AdminStackedBarChart.vue`
- Verify: `src/components/admin/adminStackedBarChart.ts`
- Verify: `src/pages/admin/dashboard/users.vue`
- Verify: `messages/en.json`
- Verify: `tests/admin-stats.test.ts`
- Verify: `tests/admin-stacked-bar-chart.unit.test.ts`
- Verify: `tests/admin-registration-source-dashboard.unit.test.ts`

- [ ] **Step 1: Run formatting and lint checks first**

Run:

```bash
bun lint
bun lint:backend
```

Expected: both commands exit 0 with no lint errors.

- [ ] **Step 2: Run focused and full unit coverage**

Run:

```bash
bunx vitest run tests/admin-stacked-bar-chart.unit.test.ts tests/admin-registration-source-dashboard.unit.test.ts
bun test:unit
```

Expected: focused tests pass, then the complete unit suite reports zero failures.

- [ ] **Step 3: Run the backend integration regression**

Run:

```bash
bun run supabase:db:reset
bunx vitest run tests/admin-stats.test.ts -t "returns subscribed as the last onboarding funnel step without exceeding the bundle cohort|returns every auth registration in exactly one daily profile bucket"
```

Expected: both focused integration tests pass.

- [ ] **Step 4: Run TypeScript validation**

Run:

```bash
bun typecheck:backend
bun typecheck:frontend
```

Expected: both typecheck commands exit 0.

- [ ] **Step 5: Review the final diff and working tree**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the pre-existing `codedb.snapshot` modification remains unstaged after all feature commits.
