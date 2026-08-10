# Frontend Onboarding Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `Frontend onboarding` platform-admin page that reports version-1 `pre_org` onboarding attempts, completion, timing, daily volume, and the Intent-to-Setup funnel from PostHog.

**Architecture:** The existing `/private/admin_stats` endpoint dispatches a new `frontend_onboarding_analytics` category to a focused backend orchestrator. A shared backend-only HogQL transport fetches one row per `onboarding_attempt_id`, pure TypeScript summarizes current and previous cohorts, and the existing Pinia admin store supplies the response to a Vue page composed from the existing filter, KPI, stacked-bar, and funnel components.

**Tech Stack:** Vue 3, Pinia, TypeScript, Hono, PostHog HogQL, Chart.js, Vitest, Bun.

**Design specification:** `docs/superpowers/specs/2026-08-10-frontend-onboarding-admin-dashboard-design.md`

---

## File Structure

**Create:**

- `supabase/functions/_backend/utils/posthog_read.ts` — reusable backend-only HogQL HTTP transport extracted from Builder Analytics.
- `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts` — pure cohort, funnel, KPI, comparison, median, and UTC daily aggregation.
- `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts` — fixed v1 HogQL query and response orchestration.
- `src/services/adminFrontendOnboarding.ts` — frontend response types and presentation adapters.
- `src/pages/admin/dashboard/frontend-onboarding.vue` — the platform-admin page.
- `tests/posthog-read.unit.test.ts` — shared PostHog transport contract.
- `tests/frontend-onboarding-analytics-model.unit.test.ts` — pure aggregation behavior.
- `tests/frontend-onboarding-analytics.unit.test.ts` — query and orchestration behavior.
- `tests/admin-frontend-onboarding-dashboard.unit.test.ts` — frontend adapters and page wiring.

**Modify:**

- `supabase/functions/_backend/utils/builder_analytics.ts` — replace its private HogQL client with the shared transport without changing its response.
- `supabase/functions/_backend/private/admin_stats.ts` — validate and dispatch the new metric category.
- `tests/admin-stats.unit.test.ts` — prove the category is accepted.
- `src/stores/adminDashboard.ts` — add the category to `MetricCategory`.
- `src/constants/adminTabs.ts` — add the `Frontend onboarding` tab.
- `messages/en.json` — add the tab, page, KPI, chart, funnel, and comparison labels.

No database migration, customer-facing onboarding change, new chart component, or new PostHog warning UI belongs in this implementation.

## Implementation Prerequisite

The implementation branch must include the merged `AdminStackedBarChart` work from current `main`. Bring the branch up to date through the repository's normal main-branch integration before Task 1. Do not recreate that component in this PR.

Verify:

```bash
test -f src/components/admin/AdminStackedBarChart.vue
test -f src/components/admin/adminStackedBarChart.ts
```

Expected: both commands exit successfully.

---

### Task 1: Share the Existing PostHog Read Transport

**Files:**

- Create: `tests/posthog-read.unit.test.ts`
- Create: `supabase/functions/_backend/utils/posthog_read.ts`
- Modify: `supabase/functions/_backend/utils/builder_analytics.ts`

- [ ] **Step 1: Write the failing transport tests**

Create `tests/posthog-read.unit.test.ts`:

```ts
import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryPosthogHogql } from '../supabase/functions/_backend/utils/posthog_read.ts'

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: vi.fn((c: Context) => (c as Context & { env?: Record<string, string> }).env ?? {}),
  }
})

function context(env: Record<string, string> = {}) {
  return {
    env,
    get: vi.fn((key: string) => key === 'requestId' ? 'frontend-onboarding-test' : undefined),
  } as unknown as Context
}

afterEach(() => vi.unstubAllGlobals())

describe('PostHog read transport', () => {
  it('does not call PostHog without a read key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryPosthogHogql(context(), 'SELECT 1')).resolves.toEqual({
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps PostHog columns onto row objects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      columns: ['attempt_id', 'intent_ms'],
      results: [['attempt-a', 1_786_320_000_000]],
    }), { status: 200 })))

    await expect(queryPosthogHogql(context({ POSTHOG_READ_KEY: 'secret' }), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ attempt_id: 'attempt-a', intent_ms: 1_786_320_000_000 }],
    })
  })

  it.each([
    ['non-2xx response', new Response('', { status: 503 }), 'unavailable'],
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'timeout'],
    ['invalid JSON', new Response('{', { status: 200 }), 'unavailable'],
  ] as const)('reports %s', async (_label, outcome, failureReason) => {
    const fetchMock = outcome instanceof Response
      ? vi.fn().mockResolvedValue(outcome)
      : vi.fn().mockRejectedValue(outcome)
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryPosthogHogql(context({ POSTHOG_READ_KEY: 'secret' }), 'SELECT 1')).resolves.toMatchObject({
      configured: true,
      connected: false,
      failureReason,
      rows: [],
    })
  })
})
```

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run:

```bash
bunx vitest run tests/posthog-read.unit.test.ts
```

Expected: FAIL because `posthog_read.ts` does not exist.

- [ ] **Step 3: Extract the Builder transport into a shared utility**

Create `supabase/functions/_backend/utils/posthog_read.ts`:

```ts
import type { Context } from 'hono'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

export type PosthogReadFailureReason = 'unconfigured' | 'timeout' | 'unavailable'

export interface PosthogReadResult {
  configured: boolean
  connected: boolean
  failureReason: PosthogReadFailureReason | null
  rows: Record<string, unknown>[]
}

export async function queryPosthogHogql(c: Context, query: string): Promise<PosthogReadResult> {
  const key = (getEnv(c, 'POSTHOG_READ_KEY') || '').trim()
  if (!key) {
    return {
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    }
  }

  const host = ((getEnv(c, 'POSTHOG_READ_HOST') || '').trim() || 'https://eu.posthog.com').replace(/\/+$/, '')
  const project = (getEnv(c, 'POSTHOG_READ_PROJECT_ID') || '').trim() || '22029'

  try {
    const response = await fetch(`${host}/api/projects/${project}/query/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_failed', status: response.status })
      return { configured: true, connected: false, failureReason: 'unavailable', rows: [] }
    }

    const body = await response.json() as { columns?: string[], results?: unknown[][] }
    const columns = body.columns ?? []
    const rows = (body.results ?? []).map((result) => {
      const row: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        row[column] = result[index]
      })
      return row
    })
    return { configured: true, connected: true, failureReason: null, rows }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_error', error: serializeError(error) })
    const name = error instanceof Error ? error.name : ''
    const failureReason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable'
    return { configured: true, connected: false, failureReason, rows: [] }
  }
}
```

- [ ] **Step 4: Make Builder Analytics consume the shared transport**

In `builder_analytics.ts`, remove the private `HogResult` and `hogql` implementation, remove `cloudlogErr` from its logging import, and add:

```ts
import { queryPosthogHogql } from './posthog_read.ts'
```

Replace the two private transport calls:

```ts
const { connected: ok, rows } = await queryPosthogHogql(c, q)
```

and:

```ts
const { rows } = await queryPosthogHogql(c, q)
```

Do not change Builder's `posthog_configured`, `posthog_connected`, query contents, limits, or warning behavior.

- [ ] **Step 5: Run focused verification**

Run:

```bash
bunx vitest run tests/posthog-read.unit.test.ts
bun run lint:backend
bun run typecheck:backend
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the extraction**

```bash
git add tests/posthog-read.unit.test.ts supabase/functions/_backend/utils/posthog_read.ts supabase/functions/_backend/utils/builder_analytics.ts
git commit -m "refactor(analytics): share PostHog read transport"
```

---

### Task 2: Build the Pure Attempt and Funnel Model

**Files:**

- Create: `tests/frontend-onboarding-analytics-model.unit.test.ts`
- Create: `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`

- [ ] **Step 1: Write the failing cohort and aggregation tests**

Create `tests/frontend-onboarding-analytics-model.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingAnalytics,
  type FrontendOnboardingAttempt,
} from '../supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts'

const ms = (value: string) => Date.parse(value)
const currentStart = ms('2026-08-08T00:00:00.000Z')
const currentEnd = ms('2026-08-10T00:00:00.000Z')

function attempt(
  attemptId: string,
  intent: string,
  steps: Partial<Record<'detailsMs' | 'organizationMs' | 'setupMs', string>> = {},
): FrontendOnboardingAttempt {
  return {
    attemptId,
    intentMs: ms(intent),
    detailsMs: steps.detailsMs ? ms(steps.detailsMs) : null,
    organizationMs: steps.organizationMs ? ms(steps.organizationMs) : null,
    setupMs: steps.setupMs ? ms(steps.setupMs) : null,
  }
}

describe('frontend onboarding analytics model', () => {
  it.concurrent('builds current KPIs, UTC days, and a monotonic funnel', () => {
    const result = buildFrontendOnboardingAnalytics([
      attempt('complete', '2026-08-08T10:00:00.000Z', {
        detailsMs: '2026-08-08T10:01:00.000Z',
        organizationMs: '2026-08-08T10:02:00.000Z',
        setupMs: '2026-08-08T10:04:00.000Z',
      }),
      attempt('setup-implies-earlier', '2026-08-08T11:00:00.000Z', {
        setupMs: '2026-08-08T11:06:00.000Z',
      }),
      attempt('details-only', '2026-08-09T12:00:00.000Z', {
        detailsMs: '2026-08-09T12:01:00.000Z',
      }),
      attempt('intent-only', '2026-08-09T13:00:00.000Z'),
    ], currentStart, currentEnd)

    expect(result.kpis).toMatchObject({
      attempts: 4,
      completed: 2,
      completion_rate: 50,
      median_completion_ms: 300_000,
    })
    expect(result.daily_attempts).toEqual([
      { date: '2026-08-08', attempts: 2 },
      { date: '2026-08-09', attempts: 2 },
    ])
    expect(result.funnel.map(stage => [stage.key, stage.reached])).toEqual([
      ['intent', 4],
      ['details', 3],
      ['organization', 2],
      ['setup', 2],
    ])
    expect(result.kpis.largest_dropoff).toMatchObject({
      from: 'details',
      to: 'organization',
      percentage: 100 / 3,
    })
  })

  it.concurrent('ignores progress before Intent or more than 24 hours later', () => {
    const result = buildFrontendOnboardingAnalytics([
      attempt('too-late', '2026-08-08T00:00:00.000Z', {
        detailsMs: '2026-08-09T00:00:00.001Z',
        setupMs: '2026-08-09T01:00:00.000Z',
      }),
      attempt('before-intent', '2026-08-08T10:00:00.000Z', {
        organizationMs: '2026-08-08T09:59:59.000Z',
      }),
    ], currentStart, currentEnd)

    expect(result.funnel.map(stage => stage.reached)).toEqual([2, 0, 0, 0])
    expect(result.kpis.completed).toBe(0)
    expect(result.kpis.median_completion_ms).toBeNull()
  })

  it.concurrent('uses the immediately preceding equal-length cohort for comparisons', () => {
    const result = buildFrontendOnboardingAnalytics([
      attempt('previous-complete', '2026-08-06T10:00:00.000Z', {
        setupMs: '2026-08-06T10:10:00.000Z',
      }),
      attempt('previous-drop', '2026-08-07T10:00:00.000Z'),
      attempt('current-complete-a', '2026-08-08T10:00:00.000Z', {
        setupMs: '2026-08-08T10:04:00.000Z',
      }),
      attempt('current-complete-b', '2026-08-09T10:00:00.000Z', {
        setupMs: '2026-08-09T10:06:00.000Z',
      }),
    ], currentStart, currentEnd)

    expect(result.kpis.comparison).toEqual({
      attempts_percent: 0,
      completion_rate_points: 50,
      median_completion_ms: -300_000,
      largest_dropoff_points: -50,
    })
  })

  it.concurrent('returns null comparisons when the previous denominator is absent', () => {
    const result = buildFrontendOnboardingAnalytics([
      attempt('current', '2026-08-08T10:00:00.000Z'),
    ], currentStart, currentEnd)

    expect(result.kpis.comparison).toEqual({
      attempts_percent: null,
      completion_rate_points: null,
      median_completion_ms: null,
      largest_dropoff_points: null,
    })
  })

  it.concurrent('returns zero-valued funnel stages and filled UTC days for no attempts', () => {
    const result = buildFrontendOnboardingAnalytics([], currentStart, currentEnd)

    expect(result.kpis.attempts).toBe(0)
    expect(result.kpis.largest_dropoff).toBeNull()
    expect(result.daily_attempts).toEqual([
      { date: '2026-08-08', attempts: 0 },
      { date: '2026-08-09', attempts: 0 },
    ])
    expect(result.funnel.map(stage => stage.reached)).toEqual([0, 0, 0, 0])
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts
```

Expected: FAIL because the model file does not exist.

- [ ] **Step 3: Implement the pure model contracts**

Create `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts` with these public contracts and constants:

```ts
export const FRONTEND_ONBOARDING_VERSION = 1 as const
export const FRONTEND_ONBOARDING_FOLLOWUP_MS = 24 * 60 * 60 * 1000

export type FrontendOnboardingStageKey = 'intent' | 'details' | 'organization' | 'setup'

export interface FrontendOnboardingAttempt {
  attemptId: string
  intentMs: number
  detailsMs: number | null
  organizationMs: number | null
  setupMs: number | null
}

export interface FrontendOnboardingFunnelStage {
  key: FrontendOnboardingStageKey
  label: 'Intent' | 'App details' | 'Organization' | 'Setup reached'
  reached: number
  of_start_percent: number
  dropoff_percent: number
}

export interface FrontendOnboardingPeriodAnalytics {
  kpis: {
    attempts: number
    completed: number
    completion_rate: number
    median_completion_ms: number | null
    largest_dropoff: {
      from: Exclude<FrontendOnboardingStageKey, 'setup'>
      to: Exclude<FrontendOnboardingStageKey, 'intent'>
      percentage: number
    } | null
  }
  daily_attempts: Array<{ date: string, attempts: number }>
  funnel: FrontendOnboardingFunnelStage[]
}
```

Implement these internal rules exactly:

```ts
const STAGES = [
  { key: 'intent', label: 'Intent' },
  { key: 'details', label: 'App details' },
  { key: 'organization', label: 'Organization' },
  { key: 'setup', label: 'Setup reached' },
] as const

function isValidProgress(timestamp: number | null, intentMs: number) {
  return timestamp !== null
    && timestamp >= intentMs
    && timestamp <= intentMs + FRONTEND_ONBOARDING_FOLLOWUP_MS
}

function median(values: number[]): number | null {
  if (values.length === 0)
    return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}
```

For each attempt in a half-open cohort `[startMs, endMs)`:

```ts
const detailsReached = isValidProgress(row.detailsMs, row.intentMs)
  || isValidProgress(row.organizationMs, row.intentMs)
  || isValidProgress(row.setupMs, row.intentMs)
const organizationReached = isValidProgress(row.organizationMs, row.intentMs)
  || isValidProgress(row.setupMs, row.intentMs)
const setupReached = isValidProgress(row.setupMs, row.intentMs)
```

Calculate `dropoff_percent` relative to the preceding stage, use `0` for Intent, and only choose a largest drop-off when the preceding stage has at least one attempt. Break equal-percentage ties by retaining the earlier transition. Fill every UTC date touched by `[startMs, endMs)` with an explicit zero before incrementing attempts.

Export:

```ts
export function buildFrontendOnboardingAnalytics(
  attempts: FrontendOnboardingAttempt[],
  currentStartMs: number,
  currentEndMs: number,
) {
  const durationMs = currentEndMs - currentStartMs
  const current = summarizePeriod(attempts, currentStartMs, currentEndMs)
  const previous = summarizePeriod(attempts, currentStartMs - durationMs, currentStartMs)

  return {
    ...current,
    kpis: {
      ...current.kpis,
      comparison: {
        attempts_percent: previous.kpis.attempts > 0
          ? ((current.kpis.attempts - previous.kpis.attempts) / previous.kpis.attempts) * 100
          : null,
        completion_rate_points: previous.kpis.attempts > 0
          ? current.kpis.completion_rate - previous.kpis.completion_rate
          : null,
        median_completion_ms: current.kpis.median_completion_ms !== null && previous.kpis.median_completion_ms !== null
          ? current.kpis.median_completion_ms - previous.kpis.median_completion_ms
          : null,
        largest_dropoff_points: current.kpis.largest_dropoff && previous.kpis.largest_dropoff
          ? current.kpis.largest_dropoff.percentage - previous.kpis.largest_dropoff.percentage
          : null,
      },
    },
  }
}
```

Implement `summarizePeriod` as a private function that filters the cohort, derives the three monotonic booleans shown above, counts each stage, fills UTC day keys, computes completion durations, and builds the funnel. Use these exact percentage helpers:

```ts
function percentage(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0
}

function dropoff(previous: number, current: number) {
  return previous > 0 ? ((previous - current) / previous) * 100 : 0
}

function utcDay(timestampMs: number) {
  return new Date(timestampMs).toISOString().slice(0, 10)
}
```

Implement the private period summarizer as follows. This starts UTC buckets at midnight for the first touched day, increments by `86_400_000`, and continues while the bucket start is before `endMs`, guaranteeing explicit zero days while preserving the half-open cohort boundary.

```ts
function summarizePeriod(
  attempts: FrontendOnboardingAttempt[],
  startMs: number,
  endMs: number,
): FrontendOnboardingPeriodAnalytics {
  const cohort = attempts.filter(row => row.intentMs >= startMs && row.intentMs < endMs)
  const counts = [cohort.length, 0, 0, 0]
  const completionDurations: number[] = []
  const daily = new Map<string, number>()
  const startDate = new Date(startMs)
  const firstDayMs = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())

  for (let dayMs = firstDayMs; dayMs < endMs; dayMs += 86_400_000)
    daily.set(utcDay(dayMs), 0)

  for (const row of cohort) {
    daily.set(utcDay(row.intentMs), (daily.get(utcDay(row.intentMs)) ?? 0) + 1)

    const detailsReached = isValidProgress(row.detailsMs, row.intentMs)
      || isValidProgress(row.organizationMs, row.intentMs)
      || isValidProgress(row.setupMs, row.intentMs)
    const organizationReached = isValidProgress(row.organizationMs, row.intentMs)
      || isValidProgress(row.setupMs, row.intentMs)
    const setupReached = isValidProgress(row.setupMs, row.intentMs)

    if (detailsReached)
      counts[1]++
    if (organizationReached)
      counts[2]++
    if (setupReached) {
      counts[3]++
      completionDurations.push((row.setupMs as number) - row.intentMs)
    }
  }

  const funnel: FrontendOnboardingFunnelStage[] = STAGES.map((stage, index) => ({
    ...stage,
    reached: counts[index],
    of_start_percent: percentage(counts[index], counts[0]),
    dropoff_percent: index === 0 ? 0 : dropoff(counts[index - 1], counts[index]),
  }))

  let largestDropoff: FrontendOnboardingPeriodAnalytics['kpis']['largest_dropoff'] = null
  for (let index = 1; index < funnel.length; index++) {
    if (funnel[index - 1].reached === 0)
      continue
    const candidate = funnel[index].dropoff_percent
    if (largestDropoff === null || candidate > largestDropoff.percentage) {
      largestDropoff = {
        from: STAGES[index - 1].key as Exclude<FrontendOnboardingStageKey, 'setup'>,
        to: STAGES[index].key as Exclude<FrontendOnboardingStageKey, 'intent'>,
        percentage: candidate,
      }
    }
  }

  return {
    kpis: {
      attempts: counts[0],
      completed: counts[3],
      completion_rate: percentage(counts[3], counts[0]),
      median_completion_ms: median(completionDurations),
      largest_dropoff: largestDropoff,
    },
    daily_attempts: [...daily.entries()].map(([date, attemptCount]) => ({ date, attempts: attemptCount })),
    funnel,
  }
}
```

- [ ] **Step 4: Run the model tests and backend checks**

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts
bun run lint:backend
bun run typecheck:backend
```

Expected: all commands PASS.

- [ ] **Step 5: Commit the pure model**

```bash
git add tests/frontend-onboarding-analytics-model.unit.test.ts supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts
git commit -m "feat(admin): model frontend onboarding funnel"
```

---

### Task 3: Query PostHog and Build the Backend Response

**Files:**

- Create: `tests/frontend-onboarding-analytics.unit.test.ts`
- Create: `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`

- [ ] **Step 1: Write failing query and orchestration tests**

Create `tests/frontend-onboarding-analytics.unit.test.ts`:

```ts
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildFrontendOnboardingHogql,
  getAdminFrontendOnboardingAnalytics,
} from '../supabase/functions/_backend/utils/frontend_onboarding_analytics.ts'
import { queryPosthogHogql } from '../supabase/functions/_backend/utils/posthog_read.ts'

vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({
  queryPosthogHogql: vi.fn(),
}))

const context = { get: vi.fn(() => 'frontend-onboarding-test') } as unknown as Context
const queryMock = vi.mocked(queryPosthogHogql)

beforeEach(() => queryMock.mockReset())

describe('frontend onboarding PostHog analytics', () => {
  it('builds a fixed v1 pre-org viewed-event query', () => {
    const query = buildFrontendOnboardingHogql(
      '2026-08-06T00:00:00.000Z',
      '2026-08-11T00:00:00.000Z',
    )

    expect(query).toContain(`event = 'onboarding_step_viewed'`)
    expect(query).toContain(`'flow') = 'pre_org'`)
    expect(query).toContain(`toInt64OrZero(toString(properties.onboarding_version)) = 1`)
    expect(query).toContain(`'onboarding_attempt_id'`)
    expect(query).toContain(`minIf(timestamp, step = 'intent')`)
    expect(query).toContain(`minIf(timestamp, step = 'details')`)
    expect(query).toContain(`minIf(timestamp, step = 'organization')`)
    expect(query).toContain(`minIf(timestamp, step = 'setup')`)
    expect(query).toContain(`GROUP BY attempt_id`)
  })

  it('maps one PostHog row per attempt and returns current analytics', async () => {
    queryMock.mockResolvedValue({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{
        attempt_id: 'attempt-a',
        intent_ms: Date.parse('2026-08-08T10:00:00.000Z'),
        details_ms: Date.parse('2026-08-08T10:01:00.000Z'),
        organization_ms: Date.parse('2026-08-08T10:02:00.000Z'),
        setup_ms: Date.parse('2026-08-08T10:04:00.000Z'),
      }],
    })

    const result = await getAdminFrontendOnboardingAnalytics(
      context,
      '2026-08-08T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
    )

    expect(result).toMatchObject({
      onboarding_version: 1,
      posthog_configured: true,
      posthog_connected: true,
      kpis: { attempts: 1, completed: 1, completion_rate: 100 },
    })
    expect(queryMock).toHaveBeenCalledOnce()
  })

  it('keeps connection metadata in the response without throwing', async () => {
    queryMock.mockResolvedValue({
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    })

    const result = await getAdminFrontendOnboardingAnalytics(
      context,
      '2026-08-08T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
    )

    expect(result.posthog_configured).toBe(false)
    expect(result.posthog_connected).toBe(false)
    expect(result.kpis.attempts).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: FAIL because `frontend_onboarding_analytics.ts` does not exist.

- [ ] **Step 3: Implement the fixed query and row mapping**

Create `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts` with these imports and the same SQL-string escaping already used by Builder Analytics:

```ts
import type { Context } from 'hono'
import {
  buildFrontendOnboardingAnalytics,
  FRONTEND_ONBOARDING_FOLLOWUP_MS,
  FRONTEND_ONBOARDING_VERSION,
  type FrontendOnboardingAttempt,
} from './frontend_onboarding_analytics_model.ts'
import { queryPosthogHogql } from './posthog_read.ts'

function sqlString(value: string) {
  return `'${value.replace(/'/g, '\'\'')}'`
}
```

The query builder must use server-generated ISO timestamps, a fixed event/flow/version, and one grouped row per attempt:

```ts
export function buildFrontendOnboardingHogql(startDate: string, followupEndDate: string) {
  return `
    WITH
      JSONExtractString(toString(properties), 'onboarding_attempt_id') AS attempt_id,
      JSONExtractString(toString(properties), 'step') AS step
    SELECT
      attempt_id,
      toUnixTimestamp(minIf(timestamp, step = 'intent')) * 1000 AS intent_ms,
      toUnixTimestamp(minIf(timestamp, step = 'details')) * 1000 AS details_ms,
      toUnixTimestamp(minIf(timestamp, step = 'organization')) * 1000 AS organization_ms,
      toUnixTimestamp(minIf(timestamp, step = 'setup')) * 1000 AS setup_ms
    FROM events
    WHERE event = 'onboarding_step_viewed'
      AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
      AND toInt64OrZero(toString(properties.onboarding_version)) = 1
      AND timestamp >= parseDateTimeBestEffort(${sqlString(startDate)})
      AND timestamp < parseDateTimeBestEffort(${sqlString(followupEndDate)})
      AND JSONExtractString(toString(properties), 'onboarding_attempt_id') != ''
    GROUP BY attempt_id
    HAVING intent_ms > 0
  `
}
```

Map PostHog fields defensively:

```ts
function nullableMs(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function mapAttempt(row: Record<string, unknown>): FrontendOnboardingAttempt | null {
  const attemptId = String(row.attempt_id ?? '').trim()
  const intentMs = nullableMs(row.intent_ms)
  if (!attemptId || intentMs === null)
    return null
  return {
    attemptId,
    intentMs,
    detailsMs: nullableMs(row.details_ms),
    organizationMs: nullableMs(row.organization_ms),
    setupMs: nullableMs(row.setup_ms),
  }
}
```

- [ ] **Step 4: Implement the backend orchestrator**

The exported function uses the current period plus the immediately previous equal-length period. Extend only the query's upper bound by 24 hours so both cohorts can receive follow-up events:

```ts
export async function getAdminFrontendOnboardingAnalytics(
  c: Context,
  startDate: string,
  endDate: string,
) {
  const startMs = Date.parse(startDate)
  const endMs = Date.parse(endDate)
  const durationMs = endMs - startMs
  const previousStartMs = startMs - durationMs
  const followupEndMs = endMs + FRONTEND_ONBOARDING_FOLLOWUP_MS

  const posthog = await queryPosthogHogql(c, buildFrontendOnboardingHogql(
    new Date(previousStartMs).toISOString(),
    new Date(followupEndMs).toISOString(),
  ))
  const attempts = posthog.rows.map(mapAttempt).filter((row): row is FrontendOnboardingAttempt => row !== null)
  const analytics = buildFrontendOnboardingAnalytics(attempts, startMs, endMs)

  return {
    onboarding_version: FRONTEND_ONBOARDING_VERSION,
    ...analytics,
    posthog_configured: posthog.configured,
    posthog_connected: posthog.connected,
  }
}
```

Do not add a row-limit warning, connection banner contract, retry API, database query, or client-side PostHog credential.

- [ ] **Step 5: Run focused verification**

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts tests/frontend-onboarding-analytics-model.unit.test.ts tests/posthog-read.unit.test.ts
bun run lint:backend
bun run typecheck:backend
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the backend analytics helper**

```bash
git add tests/frontend-onboarding-analytics.unit.test.ts supabase/functions/_backend/utils/frontend_onboarding_analytics.ts
git commit -m "feat(admin): query frontend onboarding analytics"
```

---

### Task 4: Register the New Admin Stats Metric

**Files:**

- Modify: `supabase/functions/_backend/private/admin_stats.ts`
- Modify: `tests/admin-stats.unit.test.ts`
- Modify: `src/stores/adminDashboard.ts`

- [ ] **Step 1: Add the failing schema test**

Inside the existing `admin stats validation` suite in `tests/admin-stats.unit.test.ts`, add:

```ts
it.concurrent('accepts the frontend onboarding analytics metric', () => {
  const parsed = safeParseSchema(adminStatsBodySchema, {
    ...baseBody,
    metric_category: 'frontend_onboarding_analytics',
  })

  expect(parsed.success).toBe(true)
})
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run:

```bash
bunx vitest run tests/admin-stats.unit.test.ts
```

Expected: FAIL because the enum rejects `frontend_onboarding_analytics`.

- [ ] **Step 3: Register and dispatch the backend category**

In `admin_stats.ts`, import:

```ts
import { getAdminFrontendOnboardingAnalytics } from '../utils/frontend_onboarding_analytics.ts'
```

Add this exact item to `metricCategories`:

```ts
'frontend_onboarding_analytics',
```

Add this switch branch beside the other PostHog-backed admin analytics:

```ts
case 'frontend_onboarding_analytics':
  result = await getAdminFrontendOnboardingAnalytics(c, start_date, end_date)
  break
```

The existing admin middleware and platform-admin check remain the only authorization path. Do not create another endpoint.

- [ ] **Step 4: Register the frontend store category**

Append the category to the `MetricCategory` union in `src/stores/adminDashboard.ts`:

```ts
| 'frontend_onboarding_analytics'
```

Do not add a new request method, date state, or cache. `fetchStats` already sends the current range and caches by category plus range.

- [ ] **Step 5: Run endpoint-contract checks**

Run:

```bash
bunx vitest run tests/admin-stats.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts
bun run lint:backend
bun run typecheck:backend
bun run typecheck:frontend
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the endpoint/store integration**

```bash
git add supabase/functions/_backend/private/admin_stats.ts tests/admin-stats.unit.test.ts src/stores/adminDashboard.ts
git commit -m "feat(admin): expose frontend onboarding analytics"
```

---

### Task 5: Add Frontend Types and Presentation Adapters

**Files:**

- Create: `src/services/adminFrontendOnboarding.ts`
- Create: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `tests/admin-frontend-onboarding-dashboard.unit.test.ts` with the pure adapter tests first:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingFunnelStages,
  formatFrontendOnboardingDuration,
  type FrontendOnboardingAnalytics,
} from '../src/services/adminFrontendOnboarding'

const analytics = {
  onboarding_version: 1,
  kpis: {
    attempts: 10,
    completed: 4,
    completion_rate: 40,
    median_completion_ms: 222_000,
    largest_dropoff: { from: 'details', to: 'organization', percentage: 37.5 },
    comparison: {
      attempts_percent: 25,
      completion_rate_points: 5,
      median_completion_ms: -28_000,
      largest_dropoff_points: -3,
    },
  },
  daily_attempts: [{ date: '2026-08-08', attempts: 10 }],
  funnel: [
    { key: 'intent', label: 'Intent', reached: 10, of_start_percent: 100, dropoff_percent: 0 },
    { key: 'details', label: 'App details', reached: 8, of_start_percent: 80, dropoff_percent: 20 },
    { key: 'organization', label: 'Organization', reached: 5, of_start_percent: 50, dropoff_percent: 37.5 },
    { key: 'setup', label: 'Setup reached', reached: 4, of_start_percent: 40, dropoff_percent: 20 },
  ],
  posthog_configured: true,
  posthog_connected: true,
} satisfies FrontendOnboardingAnalytics

describe('admin frontend onboarding dashboard', () => {
  it.concurrent('adapts daily attempts to the existing stacked chart', () => {
    expect(buildFrontendOnboardingDailySeries(analytics.daily_attempts, 'New user onboarding')).toEqual([{
      label: 'New user onboarding',
      color: '#5667d8',
      data: [{ date: '2026-08-08', value: 10 }],
    }])
  })

  it.concurrent('adapts the funnel to the existing funnel chart', () => {
    expect(buildFrontendOnboardingFunnelStages(analytics.funnel)).toEqual([
      { label: 'Intent', value: 10, color: '#119eff' },
      { label: 'App details', value: 8, color: '#6366f1' },
      { label: 'Organization', value: 5, color: '#8b5cf6' },
      { label: 'Setup reached', value: 4, color: '#10b981' },
    ])
  })

  it.concurrent('formats completion durations without inventing a value', () => {
    expect(formatFrontendOnboardingDuration(222_000)).toBe('3m 42s')
    expect(formatFrontendOnboardingDuration(28_000)).toBe('28s')
    expect(formatFrontendOnboardingDuration(null)).toBe('—')
  })
})
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the frontend service and page do not exist.

- [ ] **Step 3: Implement the response types and chart adapters**

Create `src/services/adminFrontendOnboarding.ts` with this complete response contract:

```ts
export type FrontendOnboardingStageKey = 'intent' | 'details' | 'organization' | 'setup'

export interface FrontendOnboardingAnalytics {
  onboarding_version: 1
  kpis: {
    attempts: number
    completed: number
    completion_rate: number
    median_completion_ms: number | null
    largest_dropoff: {
      from: Exclude<FrontendOnboardingStageKey, 'setup'>
      to: Exclude<FrontendOnboardingStageKey, 'intent'>
      percentage: number
    } | null
    comparison: {
      attempts_percent: number | null
      completion_rate_points: number | null
      median_completion_ms: number | null
      largest_dropoff_points: number | null
    }
  }
  daily_attempts: Array<{ date: string, attempts: number }>
  funnel: Array<{
    key: FrontendOnboardingStageKey
    label: string
    reached: number
    of_start_percent: number
    dropoff_percent: number
  }>
  posthog_configured: boolean
  posthog_connected: boolean
}
```

Add these adapters beneath the interface:

```ts
const FUNNEL_COLORS = ['#119eff', '#6366f1', '#8b5cf6', '#10b981'] as const

export function buildFrontendOnboardingDailySeries(
  dailyAttempts: FrontendOnboardingAnalytics['daily_attempts'],
  label: string,
) {
  return [{
    label,
    color: '#5667d8',
    data: dailyAttempts.map(point => ({ date: point.date, value: point.attempts })),
  }]
}

export function buildFrontendOnboardingFunnelStages(
  funnel: FrontendOnboardingAnalytics['funnel'],
) {
  return funnel.map((stage, index) => ({
    label: stage.label,
    value: stage.reached,
    color: FUNNEL_COLORS[index] ?? '#64748b',
  }))
}

export function formatFrontendOnboardingDuration(value: number | null) {
  if (value === null)
    return '—'
  const totalSeconds = Math.max(0, Math.round(value / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}
```

Keep all response property names identical to the backend's snake-case contract. Do not add PostHog connectivity presentation state.

- [ ] **Step 4: Run the adapter subset**

Run the adapter tests:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the frontend service**

```bash
git add src/services/adminFrontendOnboarding.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): adapt frontend onboarding analytics"
```

---

### Task 6: Build and Wire the Frontend Onboarding Page

**Files:**

- Create: `src/pages/admin/dashboard/frontend-onboarding.vue`
- Modify: `src/constants/adminTabs.ts`
- Modify: `messages/en.json`
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Extend the frontend contract test for navigation and translations**

Add this import and these tests to `tests/admin-frontend-onboarding-dashboard.unit.test.ts`:

```ts
import { readFile } from 'node:fs/promises'

it.concurrent('wires the page to existing admin components without PostHog warning UI', async () => {
  const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')

  expect(source).toContain(`fetchStats('frontend_onboarding_analytics')`)
  expect(source).toContain('<AdminFilterBar')
  expect(source).toContain('<AdminStatsCard')
  expect(source).toContain('<AdminStackedBarChart')
  expect(source).toContain('<AdminFunnelChart')
  expect(source).toContain(`t('frontend-onboarding-version-1')`)
  expect(source).not.toContain('posthogWarning')
  expect(source).not.toContain('posthog_configured')
  expect(source).not.toContain('posthog_connected')
})

it.concurrent('registers the frontend onboarding admin tab', async () => {
  const source = await readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8')
  expect(source).toContain(`label: 'frontend-onboarding'`)
  expect(source).toContain(`key: '/frontend-onboarding'`)
})

it.concurrent('defines every page label in English', async () => {
  const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>
  expect(messages['frontend-onboarding']).toBe('Frontend onboarding')
  expect(messages['frontend-onboarding-version-1']).toBe('Onboarding v1')
  expect(messages['frontend-onboarding-attempts']).toBe('Onboarding attempts')
  expect(messages['frontend-onboarding-completed']).toBe('Frontend onboarding completed')
  expect(messages['frontend-onboarding-median-time']).toBe('Median completion time')
  expect(messages['frontend-onboarding-largest-dropoff']).toBe('Largest drop-off')
  expect(messages['frontend-onboarding-daily-attempts']).toBe('Daily onboarding attempts')
  expect(messages['frontend-onboarding-funnel']).toBe('Frontend onboarding funnel')
  expect(messages['frontend-onboarding-new-users']).toBe('New user onboarding')
  expect(messages['frontend-onboarding-setup-reached']).toBe('Setup reached')
})
```

- [ ] **Step 2: Run the expanded contract test and verify the intended failures**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the page, tab, and translation keys do not exist yet.

- [ ] **Step 3: Add the tab and translation keys**

In `src/constants/adminTabs.ts`, import an appropriate existing Heroicon such as `~icons/heroicons/chart-bar-square` and add:

```ts
{ label: 'frontend-onboarding', icon: IconChartBarSquare, key: '/frontend-onboarding' },
```

Place it beside `users`, not inside a customer dashboard navigation group.

Add these English keys to `messages/en.json`:

```json
"frontend-onboarding": "Frontend onboarding",
"frontend-onboarding-version-1": "Onboarding v1",
"frontend-onboarding-attempts": "Onboarding attempts",
"frontend-onboarding-attempts-subtitle": "Unique frontend attempts",
"frontend-onboarding-completed": "Frontend onboarding completed",
"frontend-onboarding-completed-subtitle": "{count} attempts reached setup",
"frontend-onboarding-median-time": "Median completion time",
"frontend-onboarding-median-time-subtitle": "Completed attempts only",
"frontend-onboarding-largest-dropoff": "Largest drop-off",
"frontend-onboarding-daily-attempts": "Daily onboarding attempts",
"frontend-onboarding-funnel": "Frontend onboarding funnel",
"frontend-onboarding-funnel-description": "Progress through the new-user app-creation wizard",
"frontend-onboarding-new-users": "New user onboarding",
"frontend-onboarding-setup-reached": "Setup reached",
"frontend-onboarding-selected-period": "Selected period",
"frontend-onboarding-vs-previous-period": "Compared with the previous period",
"frontend-onboarding-no-dropoff": "No drop-off",
"frontend-onboarding-transition": "{from} → {to}"
```

- [ ] **Step 4: Create the page using existing admin patterns**

Create `src/pages/admin/dashboard/frontend-onboarding.vue` with:

```vue
<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminFunnelChart from '~/components/admin/AdminFunnelChart.vue'
import AdminStackedBarChart from '~/components/admin/AdminStackedBarChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingFunnelStages,
  formatFrontendOnboardingDuration,
  type FrontendOnboardingAnalytics,
} from '~/services/adminFrontendOnboarding'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const adminStore = useAdminDashboardStore()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const isLoading = ref(true)
const isLoadingStats = ref(false)
const analytics = ref<FrontendOnboardingAnalytics | null>(null)

async function loadAnalytics() {
  isLoadingStats.value = true
  try {
    analytics.value = await adminStore.fetchStats('frontend_onboarding_analytics') || null
  }
  catch (error) {
    console.error('[Admin Frontend Onboarding] Error loading analytics:', error)
    analytics.value = null
  }
  finally {
    isLoadingStats.value = false
  }
}

const kpis = computed(() => analytics.value?.kpis)
const dailySeries = computed(() => buildFrontendOnboardingDailySeries(
  analytics.value?.daily_attempts ?? [],
  t('frontend-onboarding-new-users'),
))
const funnelStages = computed(() => buildFrontendOnboardingFunnelStages(analytics.value?.funnel ?? []))
const hasAttempts = computed(() => (kpis.value?.attempts ?? 0) > 0)
const completionValue = computed(() => `${formatNumberValue(kpis.value?.completion_rate ?? 0, { maximumFractionDigits: 1 })}%`)
const completionSubtitle = computed(() => t('frontend-onboarding-completed-subtitle', { count: kpis.value?.completed ?? 0 }))
const largestDropoffValue = computed(() => kpis.value?.largest_dropoff
  ? `${formatNumberValue(kpis.value.largest_dropoff.percentage, { maximumFractionDigits: 1 })}%`
  : '—')
const largestDropoffSubtitle = computed(() => {
  const dropoff = kpis.value?.largest_dropoff
  if (!dropoff)
    return t('frontend-onboarding-no-dropoff')
  const stages = analytics.value?.funnel ?? []
  const from = stages.find(stage => stage.key === dropoff.from)?.label ?? dropoff.from
  const to = stages.find(stage => stage.key === dropoff.to)?.label ?? dropoff.to
  return t('frontend-onboarding-transition', { from, to })
})

watch(() => adminStore.activeDateRange, loadAnalytics, { deep: true })
watch(() => adminStore.refreshTrigger, loadAnalytics)

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access frontend onboarding analytics')
    await router.push('/dashboard')
    return
  }
  await loadAnalytics()
  isLoading.value = false
  displayStore.NavTitle = t('frontend-onboarding')
})

displayStore.NavTitle = t('frontend-onboarding')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div class="h-full pb-4 overflow-hidden">
    <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <AdminFilterBar />
      <PageLoader v-if="isLoading" />

      <div v-else class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
            {{ t('frontend-onboarding') }}
          </h1>
          <span class="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">
            {{ t('frontend-onboarding-version-1') }}
          </span>
        </div>

        <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          <AdminStatsCard
            :title="t('frontend-onboarding-attempts')"
            :value="kpis?.attempts ?? 0"
            :subtitle="t('frontend-onboarding-attempts-subtitle')"
            color-class="text-indigo-500"
            :is-loading="isLoadingStats"
          />
          <AdminStatsCard
            :title="t('frontend-onboarding-completed')"
            :value="completionValue"
            :subtitle="completionSubtitle"
            color-class="text-emerald-500"
            :is-loading="isLoadingStats"
          />
          <AdminStatsCard
            :title="t('frontend-onboarding-median-time')"
            :value="formatFrontendOnboardingDuration(kpis?.median_completion_ms ?? null)"
            :subtitle="t('frontend-onboarding-median-time-subtitle')"
            color-class="text-amber-500"
            :is-loading="isLoadingStats"
          />
          <AdminStatsCard
            :title="t('frontend-onboarding-largest-dropoff')"
            :value="largestDropoffValue"
            :subtitle="largestDropoffSubtitle"
            color-class="text-rose-500"
            :is-loading="isLoadingStats"
          />
        </div>

        <ChartCard
          :title="t('frontend-onboarding-daily-attempts')"
          :is-loading="isLoadingStats"
          :has-data="hasAttempts"
        >
          <AdminStackedBarChart :series="dailySeries" :is-loading="isLoadingStats" />
        </ChartCard>

        <section class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
          <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
            {{ t('frontend-onboarding-funnel') }}
          </h2>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {{ t('frontend-onboarding-funnel-description') }}
          </p>
          <div class="h-72 mt-6 sm:h-80">
            <AdminFunnelChart :stages="funnelStages" :is-loading="isLoadingStats" />
          </div>
          <div class="grid grid-cols-2 gap-4 pt-5 mt-5 border-t border-slate-200 md:grid-cols-4 dark:border-slate-700">
            <div v-for="stage in analytics?.funnel ?? []" :key="stage.key" class="text-center">
              <p class="text-xl font-bold text-slate-900 dark:text-white">
                {{ formatNumberValue(stage.of_start_percent, { maximumFractionDigits: 1 }) }}%
              </p>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ stage.label }} · {{ stage.reached }}
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
```

Do not reference `posthog_configured` or `posthog_connected` in this page. They remain visible in the endpoint response for network inspection only.

- [ ] **Step 5: Run the complete frontend contract test**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run frontend lint and type checking**

Run:

```bash
bun run lint
bun run typecheck:frontend
```

Expected: both commands PASS. If formatting changes are required, run `bun run lint:fix`, inspect the diff, and rerun both commands.

- [ ] **Step 7: Commit the page**

```bash
git add src/pages/admin/dashboard/frontend-onboarding.vue src/constants/adminTabs.ts messages/en.json tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): add frontend onboarding dashboard"
```

---

### Task 7: Verify the Complete Feature and Prepare the PR

**Files:**

- Verify all files listed above.
- Do not modify `codedb.snapshot` unless the user explicitly asks to commit generated index state.

- [ ] **Step 1: Run all focused unit tests together**

```bash
bunx vitest run \
  tests/posthog-read.unit.test.ts \
  tests/frontend-onboarding-analytics-model.unit.test.ts \
  tests/frontend-onboarding-analytics.unit.test.ts \
  tests/admin-stats.unit.test.ts \
  tests/admin-frontend-onboarding-dashboard.unit.test.ts \
  tests/admin-stacked-bar-chart.unit.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run repository lint and type checks**

```bash
bun run lint
bun run lint:backend
bun run typecheck
```

Expected: all commands PASS.

- [ ] **Step 3: Run the complete unit suite**

```bash
bun run test:unit
```

Expected: PASS with no regressions.

- [ ] **Step 4: Inspect the implementation diff for scope**

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only the design/plan documents and files named in this plan are changed; `codedb.snapshot` remains unstaged; `git diff --check` produces no output.

- [ ] **Step 5: Perform a local admin-page smoke test**

Run:

```bash
bun serve:dev
```

Open `/admin/dashboard/frontend-onboarding` as the local admin account and verify:

- the shared date selector loads and changing it requests `frontend_onboarding_analytics` with new ISO timestamps;
- the page contains four KPI cards, one daily column chart, and one full-width funnel;
- the fixed badge reads `Onboarding v1`;
- there is no version filter, intent filter, existing-org funnel, or PostHog warning banner;
- the network response contains `posthog_configured` and `posthog_connected` for debugging;
- a zero-attempt period renders ordinary zero/no-data states without a bespoke warning.

- [ ] **Step 6: Invoke the required PR-readiness workflow**

Before creating, updating, or handing off the pull request, invoke the repository's `pr-ready` skill and follow it until stable green. Do not include `codedb.snapshot` or unrelated work in the PR.

- [ ] **Step 7: Create the pull request**

Use a title that does not begin with `[CODEX]`, for example:

```text
feat(admin): add frontend onboarding analytics
```

The PR description must state:

- only `pre_org` and `onboarding_version = 1` are included;
- an attempt is grouped by `onboarding_attempt_id` and cohort-started by first Intent view;
- progress is accepted for 24 hours;
- completion means `setup` viewed, not CLI executed;
- existing admin/PostHog/chart infrastructure is reused;
- the focused tests, unit suite, lint, and type checks run successfully.
