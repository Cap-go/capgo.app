# Plans Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only admin Plans analytics page that reconstructs logical Plans openings, classifies daily visitor organizations by historical billing state, and attributes checkout intent across midnight.

**Architecture:** `/private/admin_stats` dispatches one `plans_analytics` request to a focused backend orchestrator. PostHog supplies behavior and timestamped billing transitions, PostgreSQL supplies billing and credit history, pure functions build the reconciled UTC chart datasets, and the existing Pinia cache supplies five-minute frontend caching. Unavailable, ambiguous, and oversized data is reported explicitly rather than rendered as zero.

**Tech Stack:** Vue 3, Pinia, TypeScript, Hono, PostgreSQL, PostHog HogQL, Chart.js, Vitest, Bun.

**Design specification:** `docs/superpowers/specs/2026-08-10-plans-analytics-dashboard-design.md`

## Evidence Record — 2026-08-10

The exact tracking prerequisite was merged via `main`: commit `918f7dc15` (`fix(analytics): deduplicate plans page visit tracking (#2964)`) emits one Plans `User visit` per activation with `tags: { page: 'plans' }`; merge commit `060a4abaa` includes it on this branch.

The Task 1 PostHog project lookup, schema lookup, bounded event sample, and legacy gap-histogram calls were attempted, and every call returned MCP error `-32603 Internal error`. Therefore no production event-time pathname or inter-event gap distribution was proven. The implementation must keep `LEGACY_PATH_SOURCE = 'unavailable'`, return `legacyUnavailableReason = 'missing_event_time_path'`, and return `legacyDeduplicationSeconds = null`; 30 seconds remains an unvalidated candidate and must not be interpreted as active or numerically trustworthy.

Legacy reconstruction may be re-enabled only after a successful event-time pathname proof, validation of a real same-organization/session gap histogram, and tests for the enabled path, threshold boundaries, and DTO metadata. The failed calls support no claims about production data.

---

## File Structure

**Create:**

- `supabase/functions/_backend/utils/posthog_read.ts` — reusable, bounded PostHog HogQL transport with structured failure reasons.
- `supabase/functions/_backend/utils/plans_analytics_model.ts` — pure visit repair, checkout attribution, UTC bucketing, and chart aggregation.
- `supabase/functions/_backend/utils/plans_billing_history.ts` — pure billing timeline reconstruction plus bounded PostgreSQL history loading.
- `supabase/functions/_backend/utils/plans_analytics.ts` — PostHog query builders and orchestration of behavior, billing, and response metadata.
- `src/services/adminPlansAnalytics.ts` — frontend response types and chart-series adapters.
- `src/pages/admin/dashboard/plans.vue` — the read-only admin page.
- `docs/admin/plans-checkout-completion.md` — deferred Graph 5 definition.
- `tests/posthog-read.unit.test.ts` — PostHog read transport tests.
- `tests/plans-analytics-model.unit.test.ts` — deduplication, attribution, UTC, and graph invariant tests.
- `tests/plans-billing-history.unit.test.ts` — paid/trial/canceled/payment/credits classification tests.
- `tests/plans-analytics-orchestration.unit.test.ts` — HogQL, PostgreSQL loader, response, and failure-state tests.
- `tests/admin-plans-analytics-dashboard.unit.test.ts` — frontend adapters, page wiring, translations, tab, and deferred-document tests.

**Modify:**

- `supabase/functions/_backend/utils/builder_analytics.ts` — consume the shared PostHog read transport.
- `supabase/functions/_backend/private/admin_stats.ts` — validate and dispatch `plans_analytics`.
- `src/stores/adminDashboard.ts` — add the metric category.
- `src/constants/adminTabs.ts` — add the Plans tab.
- `messages/en.json` — add all user-visible page, graph, category, and failure-state labels.

No database migration or customer-facing Plans-page change belongs in this implementation.

---

### Task 1: Verify the Historical PostHog Contract

**Files:**

- Read: `src/pages/settings/organization/Plans.vue`
- Read: `src/pages/settings/organization/Usage.vue`
- Read: `supabase/functions/_backend/utils/posthog.ts`
- Read: `supabase/functions/_backend/private/events.ts`
- Modify if evidence changes: `docs/superpowers/specs/2026-08-10-plans-analytics-dashboard-design.md`

- [ ] **Step 1: Verify the exact tracking prerequisite without copying it into this branch**

Run:

```bash
rg -n "page: 'plans'|plansVisitTracking" src/pages/settings/organization/Plans.vue src/services
```

Expected after the tracking PR has merged: an exact `User visit` emission with event property `page: 'plans'`. If it is absent, merge the prerequisite through `main`; do not recreate or cherry-pick its implementation into this analytics PR.

- [ ] **Step 2: Run the bounded PostHog schema/sample probe**

Run this HogQL through the configured PostHog SQL reader or SQL editor:

```sql
SELECT
  timestamp,
  properties.org_id AS org_id,
  properties.page AS page,
  properties.$current_url AS event_current_url,
  properties.$pathname AS event_pathname,
  properties.$session_id AS session_id,
  properties.$groups.organization AS grouped_org_id,
  distinct_id,
  person.properties.$current_url AS person_current_url
FROM events
WHERE event = 'User visit'
  AND timestamp >= parseDateTimeBestEffort('2026-02-23T00:00:00.000Z')
  AND timestamp < now()
ORDER BY timestamp DESC
LIMIT 100
```

Expected: exact events expose `page = 'plans'`; legacy rows expose a usable organization identifier. Record whether `event_current_url` or `event_pathname` contains an event-time Plans path. Only use `person_current_url` if the PostHog project metadata confirms person-on-events ingestion-time semantics.

- [ ] **Step 3: Decide the legacy availability flag from evidence**

Use this fixed rule:

```text
event_current_url or event_pathname available on legacy rows
  => legacyReconstructionAvailable = true

only person_current_url available AND person-on-events is event-time
  => legacyReconstructionAvailable = true

only query-time person URL available
  => legacyReconstructionAvailable = false
     legacyUnavailableReason = 'missing_event_time_path'
```

Expected: the implementation never turns a current person URL into a historical Plans visit.

- [ ] **Step 4: Validate the 30-second legacy burst threshold**

Run:

```sql
SELECT
  multiIf(
    gap_seconds <= 1, '00-01s',
    gap_seconds <= 5, '02-05s',
    gap_seconds <= 10, '06-10s',
    gap_seconds <= 30, '11-30s',
    gap_seconds <= 60, '31-60s',
    gap_seconds <= 300, '01-05m',
    'over-05m'
  ) AS gap_bucket,
  count() AS events
FROM (
  SELECT dateDiff(
    'second',
    lagInFrame(timestamp) OVER (
      PARTITION BY
        properties.org_id,
        coalesce(nullIf(toString(properties.$session_id), ''), toString(distinct_id))
      ORDER BY timestamp
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ),
    timestamp
  ) AS gap_seconds
  FROM events
  WHERE event = 'User visit'
    AND timestamp >= parseDateTimeBestEffort('2026-02-23T00:00:00.000Z')
    AND timestamp < now()
)
WHERE gap_seconds >= 0
GROUP BY gap_bucket
ORDER BY gap_bucket
```

Expected before enabling legacy repair: duplicate bursts concentrate at or below the selected cutoff when partitioned by the same organization plus session-or-actor identity used at runtime. Thirty seconds remains only a candidate until this query succeeds. If the distribution validates a cutoff, update the constant, enabled-path tests, response metadata, and design document together; otherwise keep legacy reconstruction unavailable and its reported threshold null.

- [ ] **Step 5: Commit any evidence-driven specification correction**

```bash
git add docs/superpowers/specs/2026-08-10-plans-analytics-dashboard-design.md
git commit -m "docs: record plans analytics data contract"
```

Expected: either a focused spec commit, or a clean worktree when the existing contract is confirmed unchanged.

---

### Task 2: Extract a Structured PostHog Read Transport

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
    get: vi.fn((key: string) => key === 'requestId' ? 'plans-test' : undefined),
  } as unknown as Context
}

afterEach(() => vi.unstubAllGlobals())

describe('PostHog read transport', () => {
  it.concurrent('reports unconfigured without calling fetch', async () => {
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

  it('maps columns to objects on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      columns: ['org_id', 'opens'],
      results: [['org-a', 3]],
    }), { status: 200 })))
    await expect(queryPosthogHogql(context({ POSTHOG_READ_KEY: 'key' }), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ org_id: 'org-a', opens: 3 }],
    })
  })

  it.each([
    ['HTTP failure', new Response('', { status: 503 }), 'unavailable'],
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'timeout'],
  ] as const)('reports %s', async (_label, outcome, failureReason) => {
    const fetchMock = outcome instanceof Response
      ? vi.fn().mockResolvedValue(outcome)
      : vi.fn().mockRejectedValue(outcome)
    vi.stubGlobal('fetch', fetchMock)
    const result = await queryPosthogHogql(context({ POSTHOG_READ_KEY: 'key' }), 'SELECT 1')
    expect(result).toMatchObject({ configured: true, connected: false, failureReason, rows: [] })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bunx vitest run tests/posthog-read.unit.test.ts
```

Expected: FAIL because `posthog_read.ts` does not exist.

- [ ] **Step 3: Implement the shared transport**

Create `supabase/functions/_backend/utils/posthog_read.ts` with this public contract:

```ts
import type { Context } from 'hono'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

export const MAX_POSTHOG_RESPONSE_BYTES = 8 * 1024 * 1024

export type PosthogReadFailureReason = 'too_large' | 'unconfigured' | 'timeout' | 'unavailable'

export interface PosthogReadResult {
  configured: boolean
  connected: boolean
  failureReason: PosthogReadFailureReason | null
  rows: Record<string, unknown>[]
}

export async function queryPosthogHogql(c: Context, query: string, options: { maxResponseBytes?: number } = {}): Promise<PosthogReadResult> {
  const key = (getEnv(c, 'POSTHOG_READ_KEY') || '').trim()
  const hostOverride = (getEnv(c, 'POSTHOG_READ_HOST') || '').trim()
  const projectOverride = (getEnv(c, 'POSTHOG_READ_PROJECT_ID') || '').trim()
  if (!key || Boolean(hostOverride) !== Boolean(projectOverride))
    return { configured: false, connected: false, failureReason: 'unconfigured', rows: [] }
  const host = (hostOverride || 'https://eu.posthog.com').replace(/\/+$/, '')
  const project = projectOverride || '22029'
  try {
    const response = await fetch(`${host}/api/projects/${project}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_failed', status: response.status })
      return { configured: true, connected: false, failureReason: 'unavailable', rows: [] }
    }
    const body = await readBoundedResponse(response, options.maxResponseBytes ?? MAX_POSTHOG_RESPONSE_BYTES)
    if (body === null)
      return { configured: true, connected: true, failureReason: 'too_large', rows: [] }
    const json = JSON.parse(body) as { columns?: string[], results?: unknown[][] }
    const columns = json.columns ?? []
    return {
      configured: true,
      connected: true,
      failureReason: null,
      rows: (json.results ?? []).map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
    }
  }
  catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_error', error: serializeError(error) })
    return { configured: true, connected: false, failureReason: timeout ? 'timeout' : 'unavailable', rows: [] }
  }
}
```

`readBoundedResponse` must reject an oversized declared `Content-Length` before reading, stream and cancel an undeclared/chunked response as soon as it exceeds the byte limit, and only then decode and parse JSON. Clamp caller-provided limits to the global 8 MiB ceiling. Key-only configuration intentionally retains the established production EU project defaults; an explicit host and project must be supplied together, and a partial override is unconfigured so a key is never sent to a lone override.

- [ ] **Step 4: Refactor Builder analytics to use the transport**

In `builder_analytics.ts`, remove its private `HogResult`/`hogql` implementation and import:

```ts
import { queryPosthogHogql } from './posthog_read.ts'
```

Replace calls with:

```ts
const { connected: ok, rows } = await queryPosthogHogql(c, q)
```

Keep Builder's existing `posthog_configured` and `posthog_connected` response semantics unchanged.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
bunx vitest run tests/posthog-read.unit.test.ts
bun run typecheck:backend
```

Expected: PASS.

Commit:

```bash
git add tests/posthog-read.unit.test.ts supabase/functions/_backend/utils/posthog_read.ts supabase/functions/_backend/utils/builder_analytics.ts
git commit -m "refactor(analytics): share PostHog read transport"
```

---

### Task 3: Implement Logical Openings, Checkout Attribution, and Graph Invariants

**Files:**

- Create: `tests/plans-analytics-model.unit.test.ts`
- Create: `supabase/functions/_backend/utils/plans_analytics_model.ts`

- [ ] **Step 1: Write failing model tests**

Create `tests/plans-analytics-model.unit.test.ts` using these fixtures and assertions:

```ts
import { describe, expect, it } from 'vitest'
import {
  attributeCheckoutStarts,
  buildLogicalPlansOpenings,
  buildPlansChartData,
  type PlansBehaviorEvent,
} from '../supabase/functions/_backend/utils/plans_analytics_model.ts'

const ms = (value: string) => Date.parse(value)
const event = (partial: Partial<PlansBehaviorEvent> & Pick<PlansBehaviorEvent, 'timestampMs' | 'orgId'>): PlansBehaviorEvent => ({
  actorId: 'user-a',
  event: 'User visit',
  page: '',
  path: '/settings/organization/plans',
  sessionId: '',
  ...partial,
})

describe('Plans analytics model', () => {
  it.concurrent('collapses only legacy bursts and preserves exact repeat openings', () => {
    const events = [
      event({ timestampMs: ms('2026-08-01T10:00:00Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T10:00:08Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T10:05:00Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T11:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-01T11:00:02Z'), orgId: 'org-a', page: 'plans', path: '' }),
    ]
    expect(buildLogicalPlansOpenings(events, ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'), 30))
      .toHaveLength(4)
  })

  it.concurrent('uses session then actor fallback and suppresses a boundary-crossing duplicate', () => {
    const events = [
      event({ timestampMs: ms('2026-07-31T23:59:50Z'), orgId: 'org-a', actorId: 'user-a' }),
      event({ timestampMs: ms('2026-08-01T00:00:05Z'), orgId: 'org-a', actorId: 'user-a' }),
      event({ timestampMs: ms('2026-08-01T00:00:05Z'), orgId: 'org-a', actorId: 'user-b' }),
    ]
    const openings = buildLogicalPlansOpenings(events, ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'), 30)
    expect(openings.map(item => item.actorId)).toEqual(['user-b'])
  })

  it.concurrent('attributes a post-midnight checkout to the latest preceding opening within 24 hours', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T23:55:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'), 30)
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T00:05:00Z'), orgId: 'org-a', path: '' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-03T00:06:00Z'), orgId: 'org-a', path: '' }),
    ])
    expect(matches).toHaveLength(1)
    expect(matches[0].attributedDate).toBe('2026-08-01')
  })

  it.concurrent('keeps range-wide uniques distinct from daily uniques and reconciles graph totals', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T08:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-02T08:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-02T12:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-02T09:00:00Z'), orgId: 'org-b', page: 'plans', path: '' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-03T00:00:00Z'), 30)
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T08:10:00Z'), orgId: 'org-a', path: '' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T12:10:00Z'), orgId: 'org-a', path: '' }),
    ])
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T00:00:00Z'),
      endMs: ms('2026-08-03T00:00:00Z'),
      classifyAt: (orgId, timestampMs) => orgId === 'org-b'
        ? 'active_trial'
        : timestampMs < ms('2026-08-02T10:00:00Z') ? 'paying' : 'credits_only',
    })
    expect(result.traffic.uniqueVisitorOrganizations).toEqual([1, 1])
    expect(result.traffic.totalOpens).toEqual([1, 2])
    expect(result.visitorBreakdown.map(day => day.total)).toEqual([1, 2])
    expect(result.checkoutIntent.map(day => day.startedCheckout + day.didNotStart)).toEqual([1, 2])
    expect(result.checkoutVisitorBreakdown.map(day => day.total)).toEqual([0, 1])
    expect(result.checkoutIntent[1].startedCheckout).toBe(1)
    expect(result.checkoutVisitorBreakdown[1]).toMatchObject({ paying: 1, creditsOnly: 0 })
  })
})
```

- [ ] **Step 2: Run the model tests to verify they fail**

```bash
bunx vitest run tests/plans-analytics-model.unit.test.ts
```

Expected: FAIL because the model module does not exist.

- [ ] **Step 3: Define the pure model contract**

Create `plans_analytics_model.ts` with these exported types and constants:

```ts
export const LEGACY_BURST_SECONDS = 30
export const CHECKOUT_ATTRIBUTION_MS = 24 * 60 * 60 * 1000

export type PlansBillingCategory =
  | 'paying'
  | 'active_trial'
  | 'expired_trial'
  | 'canceled'
  | 'payment_problem'
  | 'credits_only'
  | 'unknown'

export interface PlansBehaviorEvent {
  event: 'User visit' | 'Checkout Started'
  timestampMs: number
  orgId: string
  actorId: string
  sessionId: string
  page: string
  path: string
}

export interface LogicalPlansOpening extends PlansBehaviorEvent {
  source: 'exact' | 'legacy'
}

export interface AttributedCheckout {
  checkoutTimestampMs: number
  orgId: string
  opening: LogicalPlansOpening
  attributedDate: string
}
```

The output daily types must contain explicit keys rather than arbitrary records:

```ts
export interface DailyBillingPoint {
  date: string
  paying: number
  activeTrial: number
  expiredTrial: number
  canceled: number
  paymentProblem: number
  creditsOnly: number
  unknown: number
  total: number
}

export interface DailyCheckoutIntentPoint {
  date: string
  startedCheckout: number
  didNotStart: number
}
```

- [ ] **Step 4: Implement visit repair and checkout attribution**

Implement these rules directly in the exported functions:

```ts
export function buildLogicalPlansOpenings(
  events: PlansBehaviorEvent[],
  startMs: number,
  endMs: number,
  burstSeconds = LEGACY_BURST_SECONDS,
): LogicalPlansOpening[]

export function attributeCheckoutStarts(
  openings: LogicalPlansOpening[],
  checkoutEvents: PlansBehaviorEvent[],
): AttributedCheckout[]
```

Implementation requirements:

```text
exact candidate: event === 'User visit' && page === 'plans'
legacy candidate: event === 'User visit' && page !== 'plans' && normalized path === '/settings/organization/plans'
legacy identity: orgId + (sessionId || actorId)
legacy new opening: first event or previous gap > burstSeconds
visible opening: timestampMs >= startMs && timestampMs < endMs
checkout match: maximum opening.timestampMs <= checkout.timestampMs with gap <= 24h
```

Normalize paths with `new URL(value, 'https://capgo.app').pathname`, then remove a trailing slash except for `/`.

- [ ] **Step 5: Implement graph aggregation**

Export:

```ts
export function buildPlansChartData(input: {
  openings: LogicalPlansOpening[]
  attributedCheckouts: AttributedCheckout[]
  startMs: number
  endMs: number
  classifyAt: (orgId: string, timestampMs: number) => PlansBillingCategory
}): {
  traffic: { dates: string[], uniqueVisitorOrganizations: number[], totalOpens: number[] }
  visitorBreakdown: DailyBillingPoint[]
  checkoutIntent: DailyCheckoutIntentPoint[]
  checkoutVisitorBreakdown: DailyBillingPoint[]
}
```

Use the first opening per organization in the selected range for Graph 1, the first opening per organization/day for Graph 2, any attributed checkout per organization/day for Graph 3, and the earliest attributed checkout per organization/day for Graph 4. Generate all UTC day keys intersecting `[startMs, endMs)`, including zero days.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run tests/plans-analytics-model.unit.test.ts
bun run typecheck:backend
git add tests/plans-analytics-model.unit.test.ts supabase/functions/_backend/utils/plans_analytics_model.ts
git commit -m "feat(admin): model plans visit analytics"
```

Expected: PASS.

---

### Task 4: Reconstruct Historical Billing State

**Files:**

- Create: `tests/plans-billing-history.unit.test.ts`
- Create: `supabase/functions/_backend/utils/plans_billing_history.ts`

- [ ] **Step 1: Write the failing classification tests**

Create a table-driven test with the complete precedence set:

```ts
import { describe, expect, it } from 'vitest'
import { classifyPlansBillingAt, type OrganizationBillingHistory } from '../supabase/functions/_backend/utils/plans_billing_history.ts'

const at = Date.parse('2026-08-01T12:00:00Z')
const base = (): OrganizationBillingHistory => ({
  orgId: 'org-a', customerId: 'cus-a', trialEndsAtMs: Date.parse('2026-07-01T00:00:00Z'),
  paidAtMs: null, canceledAtMs: null, currentPastDueAtMs: null, churnReason: null,
  revenueMovements: [], transitions: [], creditGrants: [], creditConsumptions: [],
})

describe('Plans billing history', () => {
  it.each([
    ['payment problem beats paying', {
      ...base(), paidAtMs: Date.parse('2026-06-01T00:00:00Z'), currentPastDueAtMs: Date.parse('2026-07-20T00:00:00Z'),
    }, 'payment_problem'],
    ['positive carried MRR is paying', {
      ...base(), paidAtMs: Date.parse('2026-06-01T00:00:00Z'), revenueMovements: [{
        date: '2026-06-01', openingMrr: 0, newBusinessMrr: 12, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null,
      }],
    }, 'paying'],
    ['future trial end is active trial', {
      ...base(), trialEndsAtMs: Date.parse('2026-08-10T00:00:00Z'),
    }, 'active_trial'],
    ['historically positive credits are credits only', {
      ...base(), creditGrants: [{ id: 'grant-a', grantedAtMs: Date.parse('2026-07-01T00:00:00Z'), expiresAtMs: Date.parse('2026-09-01T00:00:00Z'), creditsTotal: 10 }],
    }, 'credits_only'],
    ['previously paid voluntary end is canceled', {
      ...base(), paidAtMs: Date.parse('2026-06-01T00:00:00Z'), canceledAtMs: Date.parse('2026-07-01T00:00:00Z'),
    }, 'canceled'],
    ['never-paid ended trial is expired trial', base(), 'expired_trial'],
  ] as const)('%s', (_label, history, expected) => {
    expect(classifyPlansBillingAt(history, at)).toBe(expected)
  })

  it.concurrent('uses exact intraday transitions and returns unknown for an unresolved movement day', () => {
    const history = {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: null }],
    }
    expect(classifyPlansBillingAt(history, at)).toBe('unknown')
    expect(classifyPlansBillingAt({
      ...history,
      transitions: [{ timestampMs: Date.parse('2026-08-01T14:00:00Z'), kind: 'canceled' }],
    }, Date.parse('2026-08-01T13:00:00Z'))).toBe('paying')
  })

  it.each([
    ['payment-failure churn', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: 'past_due_unresolved' }],
      transitions: [{ timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'payment_problem' as const }],
    }, at, 'payment_problem'],
    ['recovered past due', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-06-01', openingMrr: 0, newBusinessMrr: 12, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }],
      transitions: [
        { timestampMs: Date.parse('2026-08-01T09:00:00Z'), kind: 'payment_problem' as const },
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'recovered' as const },
      ],
    }, at, 'paying'],
    ['resubscribed after cancellation', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      canceledAtMs: Date.parse('2026-07-01T00:00:00Z'),
      transitions: [
        { timestampMs: Date.parse('2026-07-01T00:00:00Z'), kind: 'canceled' as const },
        { timestampMs: Date.parse('2026-08-01T11:00:00Z'), kind: 'paid' as const },
      ],
    }, at, 'paying'],
    ['credits consumed before visit', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: Date.parse('2026-07-01T00:00:00Z'), expiresAtMs: Date.parse('2026-09-01T00:00:00Z'), creditsTotal: 10 }],
      creditConsumptions: [{ grantId: 'grant-a', appliedAtMs: Date.parse('2026-07-20T00:00:00Z'), creditsUsed: 10 }],
    }, at, 'expired_trial'],
    ['credits expired before visit', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: Date.parse('2026-06-01T00:00:00Z'), expiresAtMs: Date.parse('2026-07-01T00:00:00Z'), creditsTotal: 10 }],
    }, at, 'expired_trial'],
  ] as const)('%s', (_label, history, timestamp, expected) => {
    expect(classifyPlansBillingAt(history, timestamp)).toBe(expected)
  })

  it.concurrent('returns unknown for contradictory transitions at one instant', () => {
    expect(classifyPlansBillingAt({
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      transitions: [
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'paid' },
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'canceled' },
      ],
    }, at)).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run the test to verify failure**

```bash
bunx vitest run tests/plans-billing-history.unit.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Define billing evidence types and calculation helpers**

Create `plans_billing_history.ts` with explicit evidence types:

```ts
export interface RevenueMovement {
  date: string
  openingMrr: number
  newBusinessMrr: number
  expansionMrr: number
  contractionMrr: number
  churnMrr: number
  churnReason: string | null
}

export interface BillingTransition {
  timestampMs: number
  kind: 'paid' | 'canceled' | 'payment_problem' | 'recovered'
}

export interface OrganizationBillingHistory {
  orgId: string
  customerId: string | null
  trialEndsAtMs: number | null
  paidAtMs: number | null
  canceledAtMs: number | null
  currentPastDueAtMs: number | null
  churnReason: string | null
  revenueMovements: RevenueMovement[]
  transitions: BillingTransition[]
  creditGrants: Array<{ id: string, grantedAtMs: number, expiresAtMs: number, creditsTotal: number }>
  creditConsumptions: Array<{ grantId: string, appliedAtMs: number, creditsUsed: number }>
}
```

Implement `endingMrr()`, `hasCreditsAt()`, an internal `billingEvidenceAt()`, and the exported `classifyPlansBillingAt()`. Never read the mutable current Stripe status as historical truth; do not expose a redundant paid-state wrapper.

- [ ] **Step 4: Implement the exact precedence**

`classifyPlansBillingAt(history, timestampMs)` must follow:

```text
1. payment_problem: active past-due episode or payment-failure churn at timestamp
2. paying: positive reconstructed entitlement at timestamp
3. active_trial: timestamp < trialEndsAtMs and no paid entitlement
4. credits_only: positive unexpired historical credit balance
5. canceled: paidAtMs <= timestamp and a voluntary cancellation is active
6. expired_trial: timestamp >= trialEndsAtMs and no payment before timestamp
7. unknown
```

For a movement day, use `openingMrr` at 00:00 UTC and apply timestamped transitions in order. If opening and ending MRR disagree and no transition locates the change relative to the visit, return `unknown` for that visit.

- [ ] **Step 5: Add the bounded PostgreSQL loader**

Export:

```ts
export async function loadPlansBillingHistories(
  c: Context,
  orgIds: string[],
  startDate: string,
  endDate: string,
  transitions: Map<string, BillingTransition[]>,
): Promise<Map<string, OrganizationBillingHistory>>
```

Before calling the loader, normalize and validate every PostHog organization identifier as a UUID. Count invalid or missing identifiers in `excludedMissingOrganization` and pass only validated UUIDs to the parameterized database queries. Use one `getPgClient(c, true)` lifecycle and parameterized `ANY($1::uuid[])`/`ANY($1::text[])` queries. Load:

```sql
SELECT o.id::text AS org_id, o.customer_id, si.trial_at, si.paid_at,
       si.canceled_at, si.past_due_at, si.churn_reason
FROM public.orgs o
LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
WHERE o.id = ANY($1::uuid[])
```

For revenue, union the last row before `startDate` per relevant customer with every row in `[startDate, endDate]`; do not scan unrelated customers. For credits, load grants whose lifetime overlaps the selected range and their consumptions through `endDate`.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run tests/plans-billing-history.unit.test.ts
bun run typecheck:backend
git add tests/plans-billing-history.unit.test.ts supabase/functions/_backend/utils/plans_billing_history.ts
git commit -m "feat(admin): classify historical plans billing state"
```

Expected: PASS.

---

### Task 5: Query PostHog and Assemble the Analytics Response

**Files:**

- Create: `tests/plans-analytics-orchestration.unit.test.ts`
- Create: `supabase/functions/_backend/utils/plans_analytics.ts`

- [ ] **Step 1: Write failing query and response tests**

Create `tests/plans-analytics-orchestration.unit.test.ts` with mocked transports and these assertions:

```ts
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPlansBillingHistories } from '../supabase/functions/_backend/utils/plans_billing_history.ts'
import {
  buildBillingTransitionsQuery,
  buildExactTrackingStartQuery,
  buildPlansBehaviorQuery,
  getAdminPlansAnalytics,
  MAX_POSTHOG_ROWS,
} from '../supabase/functions/_backend/utils/plans_analytics.ts'
import { queryPosthogHogql } from '../supabase/functions/_backend/utils/posthog_read.ts'

vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({ queryPosthogHogql: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/plans_billing_history.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/plans_billing_history.ts')>(),
  loadPlansBillingHistories: vi.fn(),
}))

const start = '2026-08-01T00:00:00.000Z'
const end = '2026-08-02T00:00:00.000Z'
const context = { get: vi.fn(() => 'request-id') } as unknown as Context

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadPlansBillingHistories).mockResolvedValue(new Map())
})

describe('Plans analytics orchestration', () => {
  it.concurrent('builds bounded scalar-only queries', () => {
    expect(buildPlansBehaviorQuery(start, end)).toContain("event IN ('User visit', 'Checkout Started')")
    expect(buildPlansBehaviorQuery(start, end)).toContain('2026-07-31T23:59:30.000Z')
    expect(buildPlansBehaviorQuery(start, end)).toContain('2026-08-03T00:00:00.000Z')
    expect(buildPlansBehaviorQuery(start, end)).not.toContain('SELECT properties')
    expect(buildBillingTransitionsQuery(end)).toContain("event IN ('User subscribe', 'User update subscribe', 'User cancel', '$groupidentify')")
    expect(buildExactTrackingStartQuery()).toContain("properties.page = 'plans'")
    expect(buildExactTrackingStartQuery()).toContain('2026-02-23T00:00:00.000Z')
  })

  it.each([
    ['unconfigured', { configured: false, connected: false, failureReason: 'unconfigured' as const, rows: [] }],
    ['timeout', { configured: true, connected: false, failureReason: 'timeout' as const, rows: [] }],
    ['unavailable', { configured: true, connected: false, failureReason: 'unavailable' as const, rows: [] }],
  ])('returns a structured %s state', async (_label, failure) => {
    vi.mocked(queryPosthogHogql).mockResolvedValue(failure)
    const result = await getAdminPlansAnalytics(context, start, end)
    expect(result.dataQuality.posthogFailureReason).toBe(failure.failureReason)
    expect(result.traffic.totalOpens).toEqual([0])
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('rejects a row-ceiling result instead of returning partial charts', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: Array.from({ length: MAX_POSTHOG_ROWS + 1 }, () => ({})) })
      .mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [] })
    const result = await getAdminPlansAnalytics(context, start, end)
    expect(result.dataQuality.posthogFailureReason).toBe('too_large')
    expect(result.traffic.totalOpens).toEqual([0])
  })

  it('distinguishes connected empty data from unavailable data', async () => {
    vi.mocked(queryPosthogHogql).mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [] })
    const result = await getAdminPlansAnalytics(context, start, end)
    expect(result.dataQuality).toMatchObject({ posthogConnected: true, posthogFailureReason: null })
    expect(result.traffic).toEqual({ dates: ['2026-08-01'], uniqueVisitorOrganizations: [0], totalOpens: [0] })
  })
})
```

Add these fixture tests to the same file for exact/legacy quality accounting:

```ts
it('retains exact rows while reporting unavailable legacy reconstruction and unmatched data', async () => {
  vi.mocked(queryPosthogHogql)
    .mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { timestamp_ms: Date.parse('2026-08-01T10:00:00Z'), event: 'User visit', org_id: 'org-a', grouped_org_id: '', page: 'plans', event_current_url: '', event_pathname: '', person_current_url: '', session_id: '', distinct_id: 'user-a' },
        { timestamp_ms: Date.parse('2026-08-01T10:01:00Z'), event: 'User visit', org_id: 'org-b', grouped_org_id: '', page: '', event_current_url: '', event_pathname: '', person_current_url: '/settings/organization/plans', session_id: '', distinct_id: 'user-b' },
        { timestamp_ms: Date.parse('2026-08-01T10:02:00Z'), event: 'User visit', org_id: '', grouped_org_id: '', page: 'plans', event_current_url: '', event_pathname: '', person_current_url: '', session_id: '', distinct_id: 'user-c' },
        { timestamp_ms: Date.parse('2026-08-01T10:05:00Z'), event: 'Checkout Started', org_id: 'org-a', grouped_org_id: '', page: '', event_current_url: '', event_pathname: '', person_current_url: '', session_id: '', distinct_id: 'user-a' },
        { timestamp_ms: Date.parse('2026-08-01T12:00:00Z'), event: 'Checkout Started', org_id: 'org-x', grouped_org_id: '', page: '', event_current_url: '', event_pathname: '', person_current_url: '', session_id: '', distinct_id: 'user-x' },
      ],
    })
    .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
    .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [{ exact_tracking_started_at: '2026-08-01T10:00:00Z' }] })
  vi.mocked(loadPlansBillingHistories).mockResolvedValue(new Map([['org-a', {
    orgId: 'org-a', customerId: 'cus-a', trialEndsAtMs: Date.parse('2026-07-01T00:00:00Z'),
    paidAtMs: null, canceledAtMs: null, currentPastDueAtMs: null, churnReason: null,
    revenueMovements: [], transitions: [], creditGrants: [], creditConsumptions: [],
  }]]))

  const result = await getAdminPlansAnalytics(context, start, end)
  expect(result.dataQuality).toMatchObject({
    exactLogicalOpens: 1,
    legacyLogicalOpens: 0,
    legacyReconstructionAvailable: false,
    legacyUnavailableReason: 'missing_event_time_path',
    excludedMissingOrganization: 1,
    unmatchedCheckoutStarts: 1,
    unknownBillingOrganizations: 0,
  })
  expect(result.checkoutIntent[0]).toMatchObject({ startedCheckout: 1, didNotStart: 0 })
})

it('uses a verified event pathname for repaired legacy openings', async () => {
  vi.mocked(queryPosthogHogql)
    .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [
      { timestamp_ms: Date.parse('2026-08-01T10:00:00Z'), event: 'User visit', org_id: 'org-a', grouped_org_id: '', page: '', event_current_url: 'https://console.capgo.app/settings/organization/plans?from=dashboard', event_pathname: '', person_current_url: '', session_id: '', distinct_id: 'user-a' },
      { timestamp_ms: Date.parse('2026-08-01T10:00:05Z'), event: 'User visit', org_id: 'org-a', grouped_org_id: '', page: '', event_current_url: 'https://console.capgo.app/settings/organization/plans', event_pathname: '', person_current_url: '', session_id: '', distinct_id: 'user-a' },
    ] })
    .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
    .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
  const result = await getAdminPlansAnalytics(context, start, end)
  expect(result.dataQuality).toMatchObject({ legacyReconstructionAvailable: true, legacyLogicalOpens: 1 })
})
```

- [ ] **Step 2: Run the test to verify failure**

```bash
bunx vitest run tests/plans-analytics-orchestration.unit.test.ts
```

Expected: FAIL because `plans_analytics.ts` does not exist.

- [ ] **Step 3: Define the response and failure contract**

Create `plans_analytics.ts` with:

```ts
export const MAX_POSTHOG_ROWS = 200_000
export const TRACKING_HISTORY_START = '2026-02-23T00:00:00.000Z'
export const LEGACY_PATH_SOURCE = 'unavailable' as const

export interface PlansAnalyticsResponse {
  traffic: { dates: string[], uniqueVisitorOrganizations: number[], totalOpens: number[] }
  visitorBreakdown: DailyBillingPoint[]
  checkoutIntent: DailyCheckoutIntentPoint[]
  checkoutVisitorBreakdown: DailyBillingPoint[]
  dataQuality: {
    exactTrackingStartedAt: string | null
    legacyLogicalOpens: number
    exactLogicalOpens: number
    legacyReconstructionAvailable: boolean
    legacyUnavailableReason: 'missing_event_time_path' | null
    excludedMissingOrganization: number
    unmatchedCheckoutStarts: number
    unknownBillingOrganizations: number
    posthogConfigured: boolean
    posthogConnected: boolean
    posthogFailureReason: 'unconfigured' | 'timeout' | 'unavailable' | 'too_large' | null
    legacyDeduplicationSeconds: number | null
  }
}
```

Add `emptyPlansAnalyticsResponse(startMs, endMs, quality)` so every failure path shares one deterministic shape.

- [ ] **Step 4: Implement safe HogQL builders**

Use a local `sqlString(value)` that doubles apostrophes. The behavior query must select only required scalar fields:

```sql
SELECT
  toUnixTimestamp(timestamp) * 1000 AS timestamp_ms,
  event,
  properties.org_id AS org_id,
  properties.$groups.organization AS grouped_org_id,
  properties.page AS page,
  properties.$session_id AS session_id,
  distinct_id
FROM events
WHERE event IN ('User visit', 'Checkout Started')
  AND (
    (event = 'User visit'
      AND properties.page = 'plans'
      AND timestamp >= parseDateTimeBestEffort('2026-07-31T23:59:30.000Z')
      AND timestamp < parseDateTimeBestEffort('2026-08-02T00:00:00.000Z'))
    OR
    (event = 'Checkout Started'
      AND timestamp >= parseDateTimeBestEffort('2026-08-01T00:00:00.000Z')
      AND timestamp < parseDateTimeBestEffort('2026-08-03T00:00:00.000Z'))
  )
ORDER BY timestamp
LIMIT 200001
```

The concrete timestamps above illustrate a request for `[2026-08-01, 2026-08-02)`. In the builder, calculate them with:

```ts
const queryStart = new Date(Date.parse(startDate) - (LEGACY_BURST_SECONDS * 1000)).toISOString()
const queryEnd = new Date(Date.parse(endDate) + CHECKOUT_ATTRIBUTION_MS).toISOString()
```

Then insert them with `sqlString(queryStart)` and `sqlString(queryEnd)`. Restrict checkout rows to `[startDate, queryEnd)` and visit rows to `[queryStart, endDate)`; the extra pre-range window exists only for visit burst repair. Keep `LEGACY_PATH_SOURCE = 'unavailable'`, return `missing_event_time_path`, and report a null legacy threshold. Only switch to an event-time source after Task 1 proves it and the enabled mapper, burst boundaries, and wire metadata are covered by tests. Never use `person_current_url`, and do not select the full `properties` object.

The transition query begins at `TRACKING_HISTORY_START`, ends at `end + 24h`, and selects `$group_key`, `$group_type`, `$group_set.plan_status`, `$group_set.canceled_at`, organization group ID, and event name.

Add a third, bounded aggregation query for the global exact-tracking boundary:

```sql
SELECT min(timestamp) AS exact_tracking_started_at
FROM events
WHERE event = 'User visit'
  AND properties.page = 'plans'
  AND timestamp >= parseDateTimeBestEffort('2026-02-23T00:00:00.000Z')
  AND timestamp < now()
```

- [ ] **Step 5: Implement orchestration**

Export:

```ts
export async function getAdminPlansAnalytics(c: Context, startDate: string, endDate: string): Promise<PlansAnalyticsResponse>
```

The function must:

```text
1. parse and validate finite start/end with start < end
2. query behavior, billing transitions, and the exact-tracking boundary through queryPosthogHogql
3. return a structured empty response for any PostHog failure
4. reject rows.length > MAX_POSTHOG_ROWS as too_large
5. map only valid scalar rows into PlansBehaviorEvent/BillingTransition
6. repair logical openings before removing the 30-second lookback
7. attribute checkout through end + 24h
8. cap unique opening organizations at 4,000 before transition or billing work
9. run at most four 1,000-organization transition queries concurrently, each with a 2 MiB response budget so the whole wave remains within 8 MiB
10. batch-load billing histories for unique opening org IDs
11. build all charts with classifyPlansBillingAt
12. compute data-quality counts and log only aggregate durations/counts
```

Do not log organization IDs, PostHog keys, URLs containing credentials, or raw event properties.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run tests/plans-analytics-model.unit.test.ts tests/plans-billing-history.unit.test.ts tests/plans-analytics-orchestration.unit.test.ts tests/posthog-read.unit.test.ts
bun run typecheck:backend
git add tests/plans-analytics-orchestration.unit.test.ts supabase/functions/_backend/utils/plans_analytics.ts
git commit -m "feat(admin): aggregate plans analytics"
```

Expected: PASS.

---

### Task 6: Wire the Admin Endpoint and Store

**Files:**

- Modify: `tests/admin-stats.unit.test.ts`
- Modify: `supabase/functions/_backend/private/admin_stats.ts`
- Modify: `src/stores/adminDashboard.ts`

- [ ] **Step 1: Add the failing validation assertion**

In `tests/admin-stats.unit.test.ts` add:

```ts
it.concurrent('accepts the plans analytics metric', () => {
  const parsed = safeParseSchema(adminStatsBodySchema, {
    ...baseBody,
    metric_category: 'plans_analytics',
  })
  expect(parsed.success).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify failure**

```bash
bunx vitest run tests/admin-stats.unit.test.ts
```

Expected: FAIL because the enum rejects `plans_analytics`.

- [ ] **Step 3: Add endpoint dispatch**

In `admin_stats.ts`:

```ts
import { getAdminPlansAnalytics } from '../utils/plans_analytics.ts'
```

Add `'plans_analytics'` to `metricCategories` and add:

```ts
case 'plans_analytics':
  result = await getAdminPlansAnalytics(c, start_date, end_date)
  break
```

Keep the existing platform-admin authorization before dispatch. The analytics function returns structured PostHog failures, so these states remain HTTP 200 data; unexpected programming/database failures continue through the existing `admin_stats_error` path.

- [ ] **Step 4: Add the Pinia metric category**

Append `'plans_analytics'` to `MetricCategory` in `src/stores/adminDashboard.ts`. Do not add a new cache: `fetchStats()` already caches by category and exact selected range for five minutes and refresh already invalidates it.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run tests/admin-stats.unit.test.ts tests/plans-analytics-orchestration.unit.test.ts
bun run typecheck
git add tests/admin-stats.unit.test.ts supabase/functions/_backend/private/admin_stats.ts src/stores/adminDashboard.ts
git commit -m "feat(admin): expose plans analytics metric"
```

Expected: PASS.

---

### Task 7: Add Frontend Types, Series Adapters, Navigation, Copy, and Deferred Documentation

**Files:**

- Create: `tests/admin-plans-analytics-dashboard.unit.test.ts`
- Create: `src/services/adminPlansAnalytics.ts`
- Create: `docs/admin/plans-checkout-completion.md`
- Modify: `src/constants/adminTabs.ts`
- Modify: `messages/en.json`

- [ ] **Step 1: Write failing frontend adapter and wiring tests**

Create `tests/admin-plans-analytics-dashboard.unit.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildPlansAnalyticsSeries } from '../src/services/adminPlansAnalytics.ts'

describe('admin Plans analytics dashboard', () => {
  it.concurrent('maps all API datasets into stable chart series', () => {
    const series = buildPlansAnalyticsSeries({
      traffic: { dates: ['2026-08-01'], uniqueVisitorOrganizations: [2], totalOpens: [4] },
      visitorBreakdown: [{ date: '2026-08-01', paying: 1, activeTrial: 1, expiredTrial: 0, canceled: 0, paymentProblem: 0, creditsOnly: 0, unknown: 0, total: 2 }],
      checkoutIntent: [{ date: '2026-08-01', startedCheckout: 1, didNotStart: 1 }],
      checkoutVisitorBreakdown: [{ date: '2026-08-01', paying: 1, activeTrial: 0, expiredTrial: 0, canceled: 0, paymentProblem: 0, creditsOnly: 0, unknown: 0, total: 1 }],
      dataQuality: {
        exactTrackingStartedAt: '2026-08-01T00:00:00Z', legacyLogicalOpens: 3, exactLogicalOpens: 1,
        legacyReconstructionAvailable: true, legacyUnavailableReason: null,
        excludedMissingOrganization: 0, unmatchedCheckoutStarts: 0, unknownBillingOrganizations: 0,
        posthogConfigured: true, posthogConnected: true, posthogFailureReason: null, legacyDeduplicationSeconds: 30,
      },
    }, key => key)
    expect(series.traffic.map(item => item.data[0].value)).toEqual([2, 4])
    expect(series.visitors).toHaveLength(7)
    expect(series.checkoutIntent.map(item => item.data[0].value)).toEqual([1, 1])
    expect(series.checkoutVisitors.reduce((sum, item) => sum + item.data[0].value, 0)).toBe(1)
  })

  it.concurrent('wires a full-width Plans page and deferred documentation', async () => {
    const [page, tabs, completionDoc, messagesText] = await Promise.all([
      readFile(new URL('../src/pages/admin/dashboard/plans.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8'),
      readFile(new URL('../docs/admin/plans-checkout-completion.md', import.meta.url), 'utf8'),
      readFile(new URL('../messages/en.json', import.meta.url), 'utf8'),
    ])
    expect(page).toContain("fetchStats('plans_analytics')")
    expect(page.match(/AdminStackedBarChart/g)?.length).toBeGreaterThanOrEqual(4)
    expect(page).toContain('AdminMultiLineChart')
    expect(page).toContain('UTC')
    expect(tabs).toContain("key: '/plans'")
    expect(completionDoc).toContain('Checkout Completed')
    const messages = JSON.parse(messagesText) as Record<string, string>
    expect(messages['plans-analytics-title']).toBe('Plans analytics')
    expect(messages['plans-analytics-checkout-intent']).toBe('Checkout intent')
  })
})
```

Keep raw-source checks limited to stable wiring contracts: the admin guard, `fetchStats('plans_analytics')`, response parsing, the UTC key, and the secured documentation link. Test response validation and presentation behavior through exported pure helpers. Cover initial/pending request coordination, valid empty data, partial-billing and unavailable-legacy warnings, each of `unconfigured`, `timeout`, `too_large`, and `unavailable`, plus request-error precedence. Assert required translation-key presence rather than exact copy, except where the design explicitly fixes the wording.

- [ ] **Step 2: Run the test to verify failure**

```bash
bunx vitest run tests/admin-plans-analytics-dashboard.unit.test.ts
```

Expected: FAIL because the adapter, page, and document do not exist.

- [ ] **Step 3: Implement typed series adapters**

Create `src/services/adminPlansAnalytics.ts` with the response interfaces from Task 5 and:

```ts
type Translate = (key: string) => string
type ChartSeries = { label: string, data: Array<{ date: string, value: number }>, color: string }

export function buildPlansAnalyticsSeries(data: PlansAnalyticsResponse, t: Translate) {
  const point = (dates: string[], values: number[]) => dates.map((date, index) => ({ date, value: values[index] ?? 0 }))
  const billing = (rows: DailyBillingPoint[]): ChartSeries[] => [
    { label: t('plans-category-paying'), color: '#2563eb', data: rows.map(row => ({ date: row.date, value: row.paying })) },
    { label: t('plans-category-active-trial'), color: '#10b981', data: rows.map(row => ({ date: row.date, value: row.activeTrial })) },
    { label: t('plans-category-expired-trial'), color: '#f59e0b', data: rows.map(row => ({ date: row.date, value: row.expiredTrial })) },
    { label: t('plans-category-canceled'), color: '#64748b', data: rows.map(row => ({ date: row.date, value: row.canceled })) },
    { label: t('plans-category-payment-problem'), color: '#ef4444', data: rows.map(row => ({ date: row.date, value: row.paymentProblem })) },
    { label: t('plans-category-credits-only'), color: '#8b5cf6', data: rows.map(row => ({ date: row.date, value: row.creditsOnly })) },
    { label: t('plans-category-unknown'), color: '#94a3b8', data: rows.map(row => ({ date: row.date, value: row.unknown })) },
  ]
  return {
    traffic: [
      { label: t('plans-analytics-unique-visitor-orgs'), color: '#2563eb', data: point(data.traffic.dates, data.traffic.uniqueVisitorOrganizations) },
      { label: t('plans-analytics-total-opens'), color: '#8b5cf6', data: point(data.traffic.dates, data.traffic.totalOpens) },
    ],
    visitors: billing(data.visitorBreakdown),
    checkoutIntent: [
      { label: t('plans-analytics-started-checkout'), color: '#10b981', data: data.checkoutIntent.map(row => ({ date: row.date, value: row.startedCheckout })) },
      { label: t('plans-analytics-did-not-start'), color: '#94a3b8', data: data.checkoutIntent.map(row => ({ date: row.date, value: row.didNotStart })) },
    ],
    checkoutVisitors: billing(data.checkoutVisitorBreakdown),
  }
}
```

- [ ] **Step 4: Add the admin tab and English translations**

Import a suitable chart icon such as `~icons/heroicons/chart-bar-square` and add:

```ts
{ label: 'plans-analytics-title', icon: IconChartBar, key: '/plans' },
```

Add English keys for the page title, four graph titles/descriptions, UTC label, seven categories, two checkout-intent series, partial-data warning, missing legacy path, unconfigured/unavailable/timeout/too-large messages, empty state, and checkout-completion card/link. Use translation keys only in Vue code.

Use these exact English values:

```json
{
  "plans-analytics-title": "Plans analytics",
  "plans-analytics-timezone": "Reporting timezone: UTC",
  "plans-analytics-traffic": "Plans page traffic",
  "plans-analytics-traffic-description": "Unique organizations on their first Plans opening in the selected range, alongside total logical openings per UTC day",
  "plans-analytics-unique-visitor-orgs": "Unique visitor orgs",
  "plans-analytics-total-opens": "Total opens",
  "plans-analytics-who-opened": "Who opened Plans?",
  "plans-analytics-who-opened-description": "Daily unique organizations by billing state at their first Plans opening",
  "plans-analytics-checkout-intent": "Checkout intent",
  "plans-analytics-checkout-intent-description": "Daily Plans visitors who started checkout within the attribution window",
  "plans-analytics-started-checkout": "Started checkout",
  "plans-analytics-did-not-start": "Did not start",
  "plans-analytics-who-opened-checkout": "Who opened checkout?",
  "plans-analytics-who-opened-checkout-description": "Daily checkout starters by billing state at the attributed Plans opening",
  "plans-analytics-checkout-completion": "Checkout completion",
  "plans-analytics-checkout-completion-description": "TODO — this graph will be implemented after reliable checkout-completion tracking is available.",
  "plans-analytics-checkout-completion-link": "Read the implementation requirements",
  "plans-category-paying": "Paying",
  "plans-category-active-trial": "Active trial",
  "plans-category-expired-trial": "Expired trial — never subscribed",
  "plans-category-canceled": "Canceled",
  "plans-category-payment-problem": "Payment problem",
  "plans-category-credits-only": "Credits only",
  "plans-category-unknown": "Unknown",
  "plans-analytics-partial-warning": "Some organizations could not be classified from historical billing records and appear as Unknown.",
  "plans-analytics-legacy-unavailable": "Legacy Plans visits are unavailable because no event-time pathname could be verified.",
  "plans-analytics-posthog-unconfigured": "PostHog analytics is not configured.",
  "plans-analytics-posthog-timeout": "This range was too large to process. Select a shorter period and try again.",
  "plans-analytics-range-too-large": "This range returned too much data to process. Select a shorter period and try again.",
  "plans-analytics-unavailable": "Plans analytics is temporarily unavailable.",
  "plans-analytics-empty": "No Plans visits were recorded in this period."
}
```

- [ ] **Step 5: Write the deferred completion document**

Create `docs/admin/plans-checkout-completion.md` with these fixed requirements:

```markdown
# Plans Checkout Completion Analytics

The current Plans analytics page measures checkout intent only. Completion must remain deferred until Capgo emits a reliable server-side `Checkout Completed` event.

The future event must contain `org_id`, a stable `checkout_attempt_id`, Stripe checkout session ID, product ID, recurrence, and completion timestamp. `Checkout Started` must carry the same `checkout_attempt_id` into Stripe metadata so completion is joined directly rather than inferred from a redirect.

The future full-width daily stacked chart uses the attributed Plans-opening UTC day. Each organization that started checkout that day appears once as Completed or Not completed. Recent attempts remain pending until the agreed observation window has elapsed; they must not be labeled abandoned prematurely.

Implementation requires a separate approved design for the observation window, late completions, retries, plan changes, and existing subscribers.
```

The final sentence records genuinely deferred product decisions rather than pretending they are implemented.

- [ ] **Step 6: Run adapter tests and commit the non-page pieces**

The test still fails because `plans.vue` is not yet present; verify the adapter directly:

```bash
bunx vitest run tests/admin-plans-analytics-dashboard.unit.test.ts -t "maps all API datasets"
```

Expected: PASS.

Commit:

```bash
git add src/services/adminPlansAnalytics.ts src/constants/adminTabs.ts messages/en.json docs/admin/plans-checkout-completion.md tests/admin-plans-analytics-dashboard.unit.test.ts
git commit -m "feat(admin): prepare plans analytics presentation"
```

---

### Task 8: Build the Plans Admin Page

**Files:**

- Create: `src/pages/admin/dashboard/plans.vue`
- Modify: `tests/admin-plans-analytics-dashboard.unit.test.ts`

- [ ] **Step 1: Implement the page state and loading flow**

Create `plans.vue` with `meta.layout = admin`, admin redirect protection, `AdminFilterBar`, and these state fields:

```ts
const data = ref<PlansAnalyticsResponse | null>(null)
const isInitialLoading = ref(true)
const isLoadingStats = ref(false)
const requestError = ref<string | null>(null)

async function loadPlansAnalytics() {
  isLoadingStats.value = true
  requestError.value = null
  try {
    const response: unknown = await adminStore.fetchStats('plans_analytics')
    data.value = parsePlansAnalyticsResponse(response)
  }
  catch (error) {
    console.error('[Admin Dashboard Plans] Error loading Plans analytics:', error)
    data.value = null
    requestError.value = t('plans-analytics-unavailable')
  }
  finally {
    isLoadingStats.value = false
  }
}
```

Watch `adminStore.activeDateRange` and `adminStore.refreshTrigger`, matching existing admin pages. Do not add intervals, automatic retries, or a second cache.

- [ ] **Step 2: Implement explicit availability messages**

Map `dataQuality.posthogFailureReason` through the behavior-tested presentation helper:

```ts
const presentation = computed(() => buildPlansAnalyticsPresentationState(data.value, requestError.value, t))
const unavailableMessage = computed(() => presentation.value.unavailableMessage)
```

The helper maps `unconfigured`, `timeout`, `too_large`, and `unavailable` to their translation keys, gives a request failure precedence, and derives chart availability. Show a non-blocking warning when its partial-billing or unavailable-legacy flag is true. A connected response with zero values is a valid empty result, not an error.

- [ ] **Step 3: Render all five full-width cards**

Render in this order inside `space-y-6`:

```vue
<ChartCard :title="t('plans-analytics-traffic')" :is-loading="isLoadingStats" :has-data="hasTraffic">
  <AdminMultiLineChart :series="series.traffic" :is-loading="isLoadingStats" />
</ChartCard>

<ChartCard :title="t('plans-analytics-who-opened')" :is-loading="isLoadingStats" :has-data="hasVisitors">
  <AdminStackedBarChart :series="series.visitors" :is-loading="isLoadingStats" />
</ChartCard>

<ChartCard :title="t('plans-analytics-checkout-intent')" :is-loading="isLoadingStats" :has-data="hasVisitors">
  <AdminStackedBarChart :series="series.checkoutIntent" :is-loading="isLoadingStats" />
</ChartCard>

<ChartCard :title="t('plans-analytics-who-opened-checkout')" :is-loading="isLoadingStats" :has-data="hasCheckoutVisitors">
  <AdminStackedBarChart :series="series.checkoutVisitors" :is-loading="isLoadingStats" />
</ChartCard>
```

The fifth card is not a chart. Render a full-width card using the `plans-analytics-checkout-completion`, `plans-analytics-checkout-completion-description`, and `plans-analytics-checkout-completion-link` translation keys. Keep only the external URL literal:

```text
https://github.com/Cap-go/capgo.app/blob/main/docs/admin/plans-checkout-completion.md
```

Open the link in a new tab with `rel="noopener noreferrer"`.

- [ ] **Step 4: Label UTC and preserve full-width layout**

Place a small `UTC` reporting label next to the page heading/filter context. Do not place Graph 3 and Graph 4 side-by-side; each `ChartCard` remains `col-span-full` and occupies the available width.

- [ ] **Step 5: Run frontend tests and type checking**

```bash
bunx vitest run tests/admin-plans-analytics-dashboard.unit.test.ts tests/admin-stacked-bar-chart.unit.test.ts
bun run typecheck:frontend
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/admin/dashboard/plans.vue tests/admin-plans-analytics-dashboard.unit.test.ts
git commit -m "feat(admin): add plans analytics dashboard"
```

---

### Task 9: Verify End-to-End Behavior and Documentation Consistency

**Files:**

- Verify: all files changed above
- Modify only if a check finds an issue: affected source, test, translation, or documentation file

- [ ] **Step 1: Run formatting and lint first**

```bash
bun lint:fix
bun lint:backend
```

Expected: PASS with only intentional formatting changes.

- [ ] **Step 2: Run all focused unit tests**

```bash
bunx vitest run \
  tests/posthog-read.unit.test.ts \
  tests/plans-analytics-model.unit.test.ts \
  tests/plans-billing-history.unit.test.ts \
  tests/plans-analytics-orchestration.unit.test.ts \
  tests/admin-stats.unit.test.ts \
  tests/admin-plans-analytics-dashboard.unit.test.ts \
  tests/admin-stacked-bar-chart.unit.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run complete type checking and production build**

```bash
bun run typecheck
bun run build
```

Expected: PASS.

- [ ] **Step 4: Perform local visual verification**

Start the frontend:

```bash
bun serve:dev
```

Expected: Vite prints its local URL. Sign in with the documented local admin account and inspect `/admin/dashboard/plans`. Verify:

```text
- the filter remains at the top and says UTC
- all five cards are full width and in the approved order
- Graph 1 is a two-series line chart
- Graphs 2-4 are stacked vertical bars
- Graph 2 and Graph 3 daily totals match
- Graph 3 Started checkout and Graph 4 daily totals match
- Unknown is visible rather than absorbed into another category
- unconfigured, timeout, too-large, empty, and partial states are distinguishable
- the completion link opens the committed GitHub document
- no customer-facing Plans banner or subscription behavior changed
```

- [ ] **Step 5: Run the full unit suite**

```bash
bun run test:unit
```

Expected: PASS.

- [ ] **Step 6: Review the final diff and commit verification fixes**

```bash
git diff origin/main...HEAD --check
git status --short
```

Expected: no whitespace errors and no generated or unrelated files staged.

If verification required changes, stage the feature files that the checks changed:

```bash
git add supabase/functions/_backend/utils/posthog_read.ts \
  supabase/functions/_backend/utils/plans_analytics_model.ts \
  supabase/functions/_backend/utils/plans_billing_history.ts \
  supabase/functions/_backend/utils/plans_analytics.ts \
  supabase/functions/_backend/private/admin_stats.ts \
  src/services/adminPlansAnalytics.ts \
  src/pages/admin/dashboard/plans.vue \
  src/stores/adminDashboard.ts \
  src/constants/adminTabs.ts \
  messages/en.json \
  docs/admin/plans-checkout-completion.md \
  tests/posthog-read.unit.test.ts \
  tests/plans-analytics-model.unit.test.ts \
  tests/plans-billing-history.unit.test.ts \
  tests/plans-analytics-orchestration.unit.test.ts \
  tests/admin-stats.unit.test.ts \
  tests/admin-plans-analytics-dashboard.unit.test.ts
git commit -m "fix(admin): harden plans analytics dashboard"
```

If no changes were required, do not create an empty commit.

---

## Pull Request Gate

Before creating or updating the pull request, invoke the repository-required `pr-ready` skill. The PR must remain blocked until:

- the exact Plans tracking prerequisite is merged or otherwise present on `main`;
- the historical pathname probe has a recorded, trustworthy outcome;
- all focused tests, lint, type checking, build, and the full unit suite pass;
- no partial PostHog result can render as a complete zero-valued chart;
- the PR diff contains no changes to ended-subscription behavior or customer-facing Plans banners.
