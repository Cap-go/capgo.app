# Admin A/B Test Publish Intent Outcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one deduplicated numeric outcome graph for users who saw the new Publish intent through either qualifying A/B-test treatment.

**Architecture:** Add a new cached admin-stat category backed by a focused read-replica aggregate over `public.users.onboarding`. Parse that response strictly in a small frontend service and render it in a dedicated component below the existing assignment matrix.

**Tech Stack:** PostgreSQL JSONB/GIN, Hono, TypeScript, Vue 3 Composition API, TailwindCSS/DaisyUI, Vitest.

---

### Task 1: Backend outcome aggregate

**Files:**
- Create: `supabase/functions/_backend/utils/ab_test_publish_intent_outcome.ts`
- Test: `tests/admin-ab-test-publish-intent-outcome.unit.test.ts`

- [ ] **Step 1: Write failing builder and query tests**

Cover fixed outcome ordering, numeric-string counts, zero-filled missing buckets, ignored invalid rows, one read-replica query, JSON containment predicates for both configured treatment branches, and pool cleanup.

```ts
expect(buildAdminABTestPublishIntentOutcome([
  { outcome: 'selected_publish', people: '104' },
  { outcome: 'selected_another_intent', people: 197 },
])).toEqual({
  total: 301,
  outcomes: [
    { outcome: 'selected_publish', count: 104 },
    { outcome: 'selected_another_intent', count: 197 },
    { outcome: 'no_selection_yet', count: 0 },
  ],
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun x vitest run tests/admin-ab-test-publish-intent-outcome.unit.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the aggregate**

Create stable outcome types and build all three buckets regardless of returned rows. Query one row per user and classify the persisted intent.

```ts
export const ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES = [
  'selected_publish',
  'selected_another_intent',
  'no_selection_yet',
] as const

export async function getAdminABTestPublishIntentOutcome(c: Context) {
  const publishTest = AB_TESTS_CONFIG.webnativeapp_publish_intent
  const developmentTest = AB_TESTS_CONFIG.webnativeapp_development_environment
  const result = await pgClient.query(
    `SELECT CASE
       WHEN user_account.onboarding ->> 'intent' = 'publish' THEN 'selected_publish'
       WHEN user_account.onboarding ->> 'intent' = ANY($3::text[]) THEN 'selected_another_intent'
       ELSE 'no_selection_yet'
     END AS outcome,
     count(*)::bigint AS people
     FROM public.users AS user_account
     WHERE (user_account.onboarding -> 'abtests') @> $1::jsonb
        OR (user_account.onboarding -> 'abtests') @> $2::jsonb
     GROUP BY 1`,
    [publishTreatment, developmentTreatment, ['ota', 'builder', 'both', 'exploring']],
  )
  return buildAdminABTestPublishIntentOutcome(result.rows)
}
```

- [ ] **Step 4: Run the backend helper tests**

Run: `bun x vitest run tests/admin-ab-test-publish-intent-outcome.unit.test.ts`

Expected: PASS.

### Task 2: Admin API category

**Files:**
- Modify: `supabase/functions/_backend/private/admin_stats.ts`
- Modify: `src/stores/adminDashboard.ts`
- Modify: `tests/admin-stats.unit.test.ts`

- [ ] **Step 1: Add a failing schema test**

```ts
it.concurrent('accepts the A/B publish intent outcome metric', () => {
  expect(safeParseSchema(adminStatsBodySchema, {
    ...baseBody,
    metric_category: 'ab_test_publish_intent_outcome',
  }).success).toBe(true)
})
```

- [ ] **Step 2: Run the schema test and confirm it fails**

Run: `bun x vitest run tests/admin-stats.unit.test.ts`

Expected: FAIL because the category is not in the enum.

- [ ] **Step 3: Wire the category end to end**

Add `'ab_test_publish_intent_outcome'` to the backend `metricCategories` tuple and frontend `MetricCategory` union. Import `getAdminABTestPublishIntentOutcome` and add an explicit switch case:

```ts
case 'ab_test_publish_intent_outcome':
  result = await getAdminABTestPublishIntentOutcome(c)
  break
```

- [ ] **Step 4: Run schema and backend tests**

Run: `bun x vitest run tests/admin-stats.unit.test.ts tests/admin-ab-test-publish-intent-outcome.unit.test.ts`

Expected: PASS.

### Task 3: Strict frontend response model

**Files:**
- Create: `src/services/adminABTestPublishIntentOutcome.ts`
- Test: `tests/admin-ab-test-dashboard.unit.test.ts`

- [ ] **Step 1: Add failing parser tests**

Test a valid response and reject missing outcomes, duplicate outcomes, unknown outcomes, negative/non-integer counts, negative totals, and totals that do not equal the outcome sum.

```ts
const outcomePayload = {
  total: 356,
  outcomes: [
    { outcome: 'selected_publish', count: 104 },
    { outcome: 'selected_another_intent', count: 197 },
    { outcome: 'no_selection_yet', count: 55 },
  ],
}
expect(parseAdminABTestPublishIntentOutcome(outcomePayload)).toEqual(outcomePayload)
```

- [ ] **Step 2: Run the parser test and confirm it fails**

Run: `bun x vitest run tests/admin-ab-test-dashboard.unit.test.ts`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement the strict parser**

Export `AdminABTestPublishIntentOutcome`, `AdminABTestPublishIntentOutcomeRow`, and `parseAdminABTestPublishIntentOutcome`. Require exactly the three known keys once each and require their count sum to equal `total`.

- [ ] **Step 4: Run the parser tests**

Run: `bun x vitest run tests/admin-ab-test-dashboard.unit.test.ts`

Expected: PASS for parser cases while page-wiring expectations remain pending until Task 4.

### Task 4: Unified numeric outcome card

**Files:**
- Create: `src/components/admin/AdminABTestPublishIntentOutcome.vue`
- Modify: `src/pages/admin/dashboard/ab-tests.vue`
- Modify: `messages/en.json`
- Test: `tests/admin-ab-test-dashboard.unit.test.ts`

- [ ] **Step 1: Add failing presentation expectations**

Read the page, component, store, and English messages. Require two concurrent metric fetches, one outcome component, locale-aware counts, three visible outcome rows, deduplication copy, accessible progress bars, and no percentage formatter in the outcome component.

```ts
expect(pageSource).toContain(`fetchStats('ab_test_publish_intent_outcome', forceRefresh)`)
expect(pageSource).toContain('<AdminABTestPublishIntentOutcome')
expect(outcomeSource).toContain('formatNumberValue(outcome.total)')
expect(outcomeSource).toContain('role="progressbar"')
expect(outcomeSource).not.toContain('formatPercentage')
```

- [ ] **Step 2: Run the dashboard test and confirm it fails**

Run: `bun x vitest run tests/admin-ab-test-dashboard.unit.test.ts`

Expected: FAIL because the component and copy are not present.

- [ ] **Step 3: Implement concurrent loading**

Rename the page loader to describe both metrics. Fetch both categories with `Promise.all`, parse both responses before assigning state, and reuse the existing loading/error/retry behavior.

```ts
const [distributionData, outcomeData] = await Promise.all([
  adminStore.fetchStats('ab_test_distribution', forceRefresh),
  adminStore.fetchStats('ab_test_publish_intent_outcome', forceRefresh),
])
```

- [ ] **Step 4: Implement the outcome card**

Render a large exposed total and three labeled horizontal tracks. Compute width as `count / total * 100`, returning zero when total is zero. Use blue, violet, and slate fills, with visible tabular counts and `aria-valuenow`, `aria-valuemin`, and `aria-valuemax`.

- [ ] **Step 5: Add English copy**

Add exact keys for the title, explanation, deduplicated cohort note, exposed-total label, and the three outcome labels. Update the page error text from distribution-only wording to A/B-test-data wording.

- [ ] **Step 6: Run focused frontend tests**

Run: `bun x vitest run tests/admin-ab-test-dashboard.unit.test.ts`

Expected: PASS.

### Task 5: Query plan and full verification

**Files:**
- Modify only if validation exposes a defect.

- [ ] **Step 1: Verify the production query plan read-only**

Run the exact aggregate as `EXPLAIN (ANALYZE, BUFFERS)` through the Supabase MCP. Confirm bitmap index scans on `users_onboarding_abtests_gin_idx`, no sequential scan of `public.users`, bounded matched rows, and no writes.

- [ ] **Step 2: Run repository formatting and lint gates**

Run: `bun lint`

Run: `bun lint:backend`

Expected: both complete with zero errors.

- [ ] **Step 3: Run typecheck and focused tests**

Run: `bun typecheck`

Run: `bun x vitest run tests/admin-ab-test-publish-intent-outcome.unit.test.ts tests/admin-ab-test-distribution.unit.test.ts tests/admin-ab-test-dashboard.unit.test.ts tests/admin-stats.unit.test.ts`

Expected: PASS.

- [ ] **Step 4: Run production build**

Run: `bun build`

Expected: successful production build.

- [ ] **Step 5: Commit and push**

Stage only the feature files and commit with Conventional Commits:

```text
feat(admin): show publish intent experiment outcomes
```

Push `wolny/admin-ab-test-publish-outcomes` and open a PR against `main`.

- [ ] **Step 6: Complete PR readiness**

Apply the `pr-ready` workflow: converge all local and remote gates, address actionable feedback, record observation A, wait at least five minutes without relevant state changes, record observation B, and report stable-green evidence.
