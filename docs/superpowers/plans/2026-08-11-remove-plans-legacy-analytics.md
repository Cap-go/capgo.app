# Remove Plans Legacy Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the disabled legacy Plans-visit reconstruction path and warning so exact `page = 'plans'` events are the only source of Plans openings.

**Architecture:** Simplify the pure behavior model first, then shrink the backend response/query and frontend parser/presentation contract together. Preserve checkout attribution, billing classification, chart construction, PostHog failures, and all five dashboard cards. Remove legacy-only copy and mark historical design instructions as superseded.

**Tech Stack:** TypeScript, Vue 3, Hono/Deno backend utilities, PostHog HogQL, Vitest, vue-i18n.

---

### Task 1: Make the behavior model exact-only

**Files:**
- Modify: `tests/plans-analytics-model.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/plans_analytics_model.ts`

- [ ] **Step 1: Replace legacy-collapse coverage with an exact-only regression**

Remove imports and assertions for `LEGACY_BURST_SECONDS`, legacy path normalization, burst identity, and `source`. Add this test:

```ts
it.concurrent('keeps every exact Plans opening in range and ignores all other visits', () => {
  const events = [
    event({ timestampMs: ms('2026-07-31T23:59:59.999Z'), page: 'plans' }),
    event({ timestampMs: ms('2026-08-01T10:00:00Z'), page: 'plans' }),
    event({ timestampMs: ms('2026-08-01T10:00:01Z'), page: 'plans' }),
    event({ timestampMs: ms('2026-08-01T10:00:02Z'), page: '' }),
    event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T10:00:03Z') }),
    event({ timestampMs: ms('2026-08-02T00:00:00Z'), page: 'plans' }),
  ]

  expect(buildLogicalPlansOpenings(
    events,
    ms('2026-08-01T00:00:00Z'),
    ms('2026-08-02T00:00:00Z'),
  ).map(opening => opening.timestampMs)).toEqual([
    ms('2026-08-01T10:00:00Z'),
    ms('2026-08-01T10:00:01Z'),
  ])
  expect(buildLogicalPlansOpenings(events, ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))[0])
    .not.toHaveProperty('source')
})
```

Keep malformed-timestamp, attribution, UTC bucketing, graph-invariant, and earliest-checkout tests. Remove `actorId`, `sessionId`, `path`, and `source` from fixtures.

- [ ] **Step 2: Run RED**

Run: `bunx vitest run tests/plans-analytics-model.unit.test.ts`

Expected: FAIL because the model still accepts the legacy shape.

- [ ] **Step 3: Implement the exact-only model**

Remove `LEGACY_BURST_SECONDS`, `LEGACY_PLANS_PATH`, `normalizePath`, and burst/session state. Use:

```ts
export const CHECKOUT_ATTRIBUTION_MS = 24 * 60 * 60 * 1000

export interface PlansBehaviorEvent {
  event: 'User visit' | 'Checkout Started'
  timestampMs: number
  orgId: string
  page: string
}

export type LogicalPlansOpening = PlansBehaviorEvent

export function buildLogicalPlansOpenings(
  events: PlansBehaviorEvent[],
  startMs: number,
  endMs: number,
): LogicalPlansOpening[] {
  return sortedWithInputOrder(events).filter(behaviorEvent => (
    behaviorEvent.event === 'User visit'
    && behaviorEvent.page === 'plans'
    && behaviorEvent.timestampMs >= startMs
    && behaviorEvent.timestampMs < endMs
  ))
}
```

Do not alter attribution or chart semantics beyond type fallout.

- [ ] **Step 4: Run GREEN**

Run: `bunx vitest run tests/plans-analytics-model.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_backend/utils/plans_analytics_model.ts tests/plans-analytics-model.unit.test.ts
git commit -m "refactor(admin): remove legacy plans opening model"
```

### Task 2: Remove legacy backend orchestration

**Files:**
- Modify: `tests/plans-analytics-orchestration.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/plans_analytics.ts`

- [ ] **Step 1: Rewrite orchestration tests**

Delete `LEGACY_PATH_SOURCE` imports and legacy metadata assertions. Add:

```ts
it('uses only exact page-tagged visits and starts at the requested boundary', async () => {
  const query = buildPlansBehaviorQuery(start, end)
  expect(query).toContain("properties.page = 'plans'")
  expect(query).toContain(`timestamp >= parseDateTimeBestEffort('${start}')`)
  expect(query).not.toContain('2026-07-31T23:59:30.000Z')
  expect(query).not.toContain('$pathname')
  expect(query).not.toContain('$current_url')

  vi.mocked(queryPosthogHogql)
    .mockResolvedValueOnce(connected([behavior(), { ...behavior({ page: '' }), pathname: '/settings/organization/plans' }]))
    .mockResolvedValueOnce(connected())
    .mockResolvedValueOnce(connected())

  const result = await getAdminPlansAnalytics(context, start, end)
  expect(result.dataQuality.exactLogicalOpens).toBe(1)
  expect(result.traffic.totalOpens).toEqual([1])
})
```

All response fixtures retain exactly:

```ts
dataQuality: {
  exactTrackingStartedAt: null,
  exactLogicalOpens: 0,
  excludedMissingOrganization: 0,
  unmatchedCheckoutStarts: 0,
  unknownBillingOrganizations: 0,
  posthogConfigured: false,
  posthogConnected: false,
  posthogFailureReason: null,
}
```

- [ ] **Step 2: Run RED**

Run: `bunx vitest run tests/plans-analytics-orchestration.unit.test.ts`

Expected: FAIL on the old pre-range query and legacy fields.

- [ ] **Step 3: Shrink the backend contract and query**

In `plans_analytics.ts`:

- remove `LEGACY_BURST_SECONDS`, `LEGACY_PATH_SOURCE`, and `legacyDeduplicationSeconds()`;
- remove the four legacy-only data-quality fields;
- validate only the selected range and checkout-attribution end;
- use `range.startIso` as the visit lower bound;
- stop selecting session and distinct-person fields;
- reduce `mapBehaviorRow()` to `event`, `timestampMs`, `orgId`, and `page`;
- pass mapped events directly to `buildLogicalPlansOpenings()`.

Use this mapper:

```ts
function mapBehaviorRow(row: Record<string, unknown>): PlansBehaviorEvent | null {
  if (!Number.isFinite(row.timestamp_ms) || (row.event !== 'User visit' && row.event !== 'Checkout Started'))
    return null
  if (!isOptionalString(row.page))
    return null
  const orgId = organizationId(row)
  if (!orgId)
    return null
  return { event: row.event, timestampMs: row.timestamp_ms as number, orgId, page: row.page ?? '' }
}
```

Keep `exactTrackingStartedAt` and `exactLogicalOpens`.

- [ ] **Step 4: Run GREEN and backend lint**

```bash
bunx vitest run tests/plans-analytics-model.unit.test.ts tests/plans-analytics-orchestration.unit.test.ts tests/plans-billing-history.unit.test.ts tests/posthog-read.unit.test.ts
bun lint:backend
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_backend/utils/plans_analytics.ts tests/plans-analytics-orchestration.unit.test.ts
git commit -m "refactor(admin): remove legacy plans analytics contract"
```

### Task 3: Remove the frontend contract and warning

**Files:**
- Modify: `tests/admin-plans-analytics-dashboard.unit.test.ts`
- Modify: `src/services/adminPlansAnalytics.ts`
- Modify: `src/pages/admin/dashboard/plans.vue`

- [ ] **Step 1: Rewrite frontend tests**

Remove legacy fields from `validResponse`, threshold-validation cases, and the legacy required message. Expect partial billing without a legacy flag:

```ts
expect(state).toMatchObject({
  unavailableMessage: null,
  hasTraffic: false,
  hasVisitors: false,
  hasCheckoutIntent: false,
  hasCheckoutVisitors: false,
  showPartialBillingWarning: true,
})
expect(state).not.toHaveProperty('showLegacyUnavailableWarning')
```

Add rolling-deployment compatibility:

```ts
it('ignores obsolete legacy quality fields from an older backend response', () => {
  const parsed = parsePlansAnalyticsResponse({
    ...validResponse,
    dataQuality: {
      ...validResponse.dataQuality,
      legacyLogicalOpens: 3,
      legacyReconstructionAvailable: false,
      legacyUnavailableReason: 'missing_event_time_path',
      legacyDeduplicationSeconds: null,
    },
  })
  expect(parsed.dataQuality).toEqual(validResponse.dataQuality)
})
```

Assert the page contains neither the legacy translation key nor `showLegacyUnavailableWarning`.

- [ ] **Step 2: Run RED**

Run: `bunx vitest run tests/admin-plans-analytics-dashboard.unit.test.ts`

Expected: FAIL because the parser and page still expose legacy state.

- [ ] **Step 3: Shrink the DTO, parser, and presentation state**

Use:

```ts
export interface PlansAnalyticsDataQuality {
  exactTrackingStartedAt: string | null
  exactLogicalOpens: number
  excludedMissingOrganization: number
  unmatchedCheckoutStarts: number
  unknownBillingOrganizations: number
  posthogConfigured: boolean
  posthogConnected: boolean
  posthogFailureReason: PlansAnalyticsFailureReason | null
}
```

Remove `showLegacyUnavailableWarning`, `nullableLegacyReason()`, and `nullableCount()`. Parse only retained fields. Preserve frontend/backend type equality.

- [ ] **Step 4: Remove the Vue warning**

Delete only the `presentation.showLegacyUnavailableWarning` status block. Preserve the partial warning, errors, cards, accessibility, watches, and request coordination.

- [ ] **Step 5: Verify frontend**

```bash
bunx vitest run tests/admin-plans-analytics-dashboard.unit.test.ts tests/admin-stacked-bar-chart.unit.test.ts
bun lint
bun run typecheck:frontend
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/adminPlansAnalytics.ts src/pages/admin/dashboard/plans.vue tests/admin-plans-analytics-dashboard.unit.test.ts
git commit -m "refactor(admin): remove legacy plans warning"
```

### Task 4: Remove copy and supersede historical instructions

**Files:**
- Modify: `messages/en.json`
- Modify: `messages/en.context.json`
- Modify: `docs/superpowers/specs/2026-08-10-plans-analytics-dashboard-design.md`
- Modify: `docs/superpowers/plans/2026-08-10-plans-analytics-dashboard.md`
- Modify: `tests/admin-plans-analytics-dashboard.unit.test.ts`

- [ ] **Step 1: Add documentation/copy assertions**

Extend the dashboard test to read the context file and both historical documents, then assert:

```ts
expect(messages).not.toHaveProperty('plans-analytics-legacy-unavailable')
expect(messageContexts).not.toHaveProperty('plans-analytics-legacy-unavailable')
expect(designDocument).toContain('Exact event tracking is the sole source of Plans openings.')
expect(implementationPlan).toContain('Superseded: legacy pathname reconstruction is not part of the shipped analytics model.')
```

- [ ] **Step 2: Run RED**

Run: `bunx vitest run tests/admin-plans-analytics-dashboard.unit.test.ts tests/translation-queue.unit.test.ts`

Expected: FAIL on the existing copy and documents.

- [ ] **Step 3: Remove the translation and update docs**

Delete `plans-analytics-legacy-unavailable` from both message files. Add this design note:

```md
> Exact event tracking is the sole source of Plans openings. Legacy pathname reconstruction was removed by the 2026-08-11 cleanup design and is not part of the response contract or UI.
```

Add this implementation-plan note:

```md
> Superseded: legacy pathname reconstruction is not part of the shipped analytics model. Exact `User visit` events tagged with `page = 'plans'` are the only Plans-opening source.
```

Remove obsolete legacy response fields, warning-copy instructions, and claims that the 30-second path can be enabled. Historical snippets may remain only under the explicit supersession notice.

- [ ] **Step 4: Run GREEN**

```bash
bunx vitest run tests/admin-plans-analytics-dashboard.unit.test.ts tests/translation-queue.unit.test.ts
git diff --check
```

Expected: PASS and no diff-check output.

- [ ] **Step 5: Commit**

```bash
git add messages/en.json messages/en.context.json docs/superpowers/specs/2026-08-10-plans-analytics-dashboard-design.md docs/superpowers/plans/2026-08-10-plans-analytics-dashboard.md tests/admin-plans-analytics-dashboard.unit.test.ts
git commit -m "docs(admin): retire legacy plans analytics"
```

### Task 5: Verify and publish

**Files:**
- Verify all files changed since `origin/main`
- Do not modify customer-facing Plans or subscription files

- [ ] **Step 1: Prove active legacy code is gone**

```bash
rg -n "LEGACY_BURST_SECONDS|LEGACY_PATH_SOURCE|legacyLogicalOpens|legacyReconstructionAvailable|legacyUnavailableReason|legacyDeduplicationSeconds|showLegacyUnavailableWarning|plans-analytics-legacy-unavailable" supabase/functions/_backend/utils src/services src/pages/admin messages
```

Expected: no output.

- [ ] **Step 2: Run focused regression tests**

```bash
bunx vitest run tests/plans-analytics-model.unit.test.ts tests/plans-analytics-orchestration.unit.test.ts tests/plans-billing-history.unit.test.ts tests/posthog-read.unit.test.ts tests/admin-plans-analytics-dashboard.unit.test.ts tests/admin-stacked-bar-chart.unit.test.ts tests/admin-stats.unit.test.ts tests/translation-queue.unit.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository gates**

```bash
bun lint:fix
bun lint:backend
bun typecheck
bun run build
bun run test:unit
git diff origin/main...HEAD --check
git status --short
```

Expected: PASS and clean status. If a repository-wide failure is unrelated, record the exact path and prove it has no diff from `origin/main`.

- [ ] **Step 4: Audit scope**

```bash
git diff --name-status origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: only Plans analytics code, focused tests, translations, and documents. `src/pages/settings/organization/Plans.vue` and ended-subscription behavior are absent.

- [ ] **Step 5: Publish**

Invoke `pr-ready`, push `wolny/remove-plans-legacy`, open a non-draft PR, include verification evidence, and monitor required checks until the workflow reports stable-green.

Suggested title: `refactor(admin): remove legacy Plans analytics`

Suggested summary:

```md
## Summary
- make exact `page = 'plans'` visits the sole Plans-opening source
- remove disabled legacy reconstruction metadata and warning UI
- preserve checkout attribution, billing breakdowns, and chart behavior
```
