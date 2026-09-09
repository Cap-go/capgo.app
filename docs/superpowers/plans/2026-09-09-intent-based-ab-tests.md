# Intent-Based Onboarding A/B Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact onboarding-intent eligibility and request-time revocation to the backend A/B assignment system without changing any active experiment or frontend code.

**Architecture:** Extend the checked-in experiment schema with an optional validated `intents` array and centralize audience-plus-intent eligibility in `ab_tests.ts`. The authenticated read/create endpoint will use the replica only for a complete, non-stale assignment set; otherwise a primary-row transaction will remove stale intent-gated assignments and create newly eligible ones atomically, followed by best-effort Bento tag reconciliation.

**Tech Stack:** TypeScript, Hono, Drizzle SQL, PostgreSQL JSONB, Vitest, Bun

---

## File Structure

- Modify `supabase/functions/_backend/utils/ab_tests.ts`: configuration validation, exact intent eligibility, atomic reconciliation, and Bento tag changes.
- Modify `tests/ab-tests.unit.test.ts`: pure validation/eligibility tests plus replica, transaction, revocation, and Bento coverage.
- Keep `supabase/functions/_backend/utils/ab_tests.json` unchanged because no active experiment uses intent targeting yet.
- Keep `supabase/functions/_backend/private/onboarding_ab_tests.ts` unchanged because the authenticated parameterless API contract already fits the design.

### Task 1: Validate and Apply Exact Intent Eligibility

**Files:**
- Modify: `tests/ab-tests.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/ab_tests.ts`

- [ ] **Step 1: Write failing configuration and assignment tests**

Add an optional intent argument to the existing test config helper and cover accepted, rejected, missing, and exact-match cases:

```ts
function testConfig(
  treatmentPercentage = 50,
  audience: ABTestConfig['audience'] = 'self_signup',
  treatmentBranch: ABTestBranch = 'A',
  controlBranch: ABTestBranch = 'B',
  intents?: ABTestConfig['intents'],
): ABTestsConfig {
  return {
    new_emails: {
      audience,
      ...(intents ? { intents } : {}),
      control_branch: controlBranch,
      treatment_branch: treatmentBranch,
      treatment_percentage: treatmentPercentage,
      branches: {
        [treatmentBranch]: { bento_tag: 'ab:new_emails' },
        [controlBranch]: { bento_tag: 'ab:no_new_emails' },
      },
    },
  }
}

it.each([
  ['empty', []],
  ['duplicate', ['ota', 'ota']],
  ['unsupported', ['unsupported']],
])('rejects %s intent targeting', async (_label, intents) => {
  const { validateABTestsConfig } = await loadABTestsModule()
  expect(() => validateABTestsConfig(testConfig(50, 'self_signup', 'A', 'B', intents as never)))
    .toThrow('Invalid A/B test configuration')
})

it('requires an exact persisted intent before assigning an intent-gated test', async () => {
  const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
  const config = validateABTestsConfig(testConfig(50, 'self_signup', 'A', 'B', ['ota']))

  expect(createABTestAssignments({ created_via_invite: false }, config)).toEqual({})
  expect(createABTestAssignments({ created_via_invite: false, intent: 'both' }, config)).toEqual({})
  expect(createABTestAssignments({ created_via_invite: false, intent: 'ota' }, config).new_emails).toBeDefined()
})
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun vitest run tests/ab-tests.unit.test.ts`

Expected: FAIL because `ABTestConfig` has no `intents` property and assignment ignores intent.

- [ ] **Step 3: Add supported intent types and strict config validation**

In `ab_tests.ts`, define the supported values and retain a copied validated array:

```ts
export const AB_TEST_INTENTS = ['ota', 'builder', 'both', 'exploring', 'publish'] as const
export type ABTestIntent = typeof AB_TEST_INTENTS[number]

export interface ABTestConfig {
  audience: ABTestAudience
  intents?: ABTestIntent[]
  branches: Record<string, { bento_tag: string }>
  control_branch: ABTestBranch
  treatment_branch: ABTestBranch
  treatment_percentage: number
}

function isABTestIntent(value: unknown): value is ABTestIntent {
  return typeof value === 'string' && (AB_TEST_INTENTS as readonly string[]).includes(value)
}
```

Inside `validateABTestsConfig`, reject a defined intent list unless it is non-empty, unique, and entirely supported, then add `intents: [...intents]` only when configured.

- [ ] **Step 4: Centralize audience-plus-intent eligibility**

Extend the assignment user input with `intent?: unknown` and use one predicate from both assignment creation and test-name selection:

```ts
type AssignmentAudienceUser = Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite'> & { intent?: unknown }

function isEligibleForTest(user: AssignmentAudienceUser, test: ABTestConfig) {
  if (test.audience === 'self_signup' && user.created_via_invite)
    return false
  return test.intents === undefined
    || (isABTestIntent(user.intent) && test.intents.includes(user.intent))
}
```

Make `createABTestAssignments` and `eligibleTestNames` use this predicate.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `bun vitest run tests/ab-tests.unit.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the eligibility layer**

```bash
git add supabase/functions/_backend/utils/ab_tests.ts tests/ab-tests.unit.test.ts
git commit -m "feat(backend): target experiments by onboarding intent"
```

### Task 2: Reconcile Stale Assignments Atomically

**Files:**
- Modify: `tests/ab-tests.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/ab_tests.ts`

- [ ] **Step 1: Write failing replica and primary reconciliation tests**

Temporarily add a validated intent-gated fixture to the exported config in each test and delete it in cleanup. Cover these cases with mocked rows:

```ts
const intentTestName = 'intent_targeted'

function installIntentTest(module: ABTestsModule, intents: ABTestConfig['intents'] = ['ota']) {
  module.AB_TESTS_CONFIG[intentTestName] = module.validateABTestsConfig({
    [intentTestName]: {
      ...testConfig().new_emails,
      intents,
      branches: {
        A: { bento_tag: 'ab:intent_targeted' },
        B: { bento_tag: 'ab:no_intent_targeted' },
      },
    },
  })[intentTestName]
}
```

Tests must assert:

- A replica row with `intent: 'ota'` and a complete assignment returns without primary access.
- A replica row without intent does not create the intent-gated assignment.
- A stored intent-gated assignment with `intent: 'builder'` forces primary reconciliation.
- The primary update replaces only `onboarding.abtests`, preserving unconfigured stored keys in the computed JSON.
- Revocation and creation can be returned from the same locked transaction.
- Changing or clearing intent removes the stale key but preserves non-intent assignments.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun vitest run tests/ab-tests.unit.test.ts`

Expected: FAIL because database reads omit intent and stale assignments are never removed.

- [ ] **Step 3: Read intent on replica and locked-primary paths**

Update both projections to include the persisted source of truth:

```sql
SELECT created_via_invite,
       onboarding->>'intent' AS intent,
       onboarding->'abtests' AS abtests
FROM public.users
```

The primary projection also keeps `email` and `FOR UPDATE`.

- [ ] **Step 4: Detect ineligible stored intent assignments**

Add a helper that only considers currently configured intent-gated tests:

```ts
function ineligibleAssignedTestNames(value: unknown, user: AssignmentAudienceUser) {
  const stored = isRecord(value) ? value : {}
  return Object.entries(AB_TESTS_CONFIG)
    .filter(([testName, test]) => test.intents !== undefined
      && stored[testName] !== undefined
      && !isEligibleForTest(user, test))
    .map(([testName]) => testName)
}
```

The replica may return only when the eligible set is complete and this list is empty.

- [ ] **Step 5: Replace stale and missing assignments in one row-locked update**

Within the existing Drizzle transaction, copy the locked JSON object, delete stale keys, merge newly generated candidates, and write the complete resulting object once:

```ts
const retained = isRecord(user.abtests) ? { ...user.abtests } : {}
for (const testName of revoked)
  delete retained[testName]
const nextAssignments = { ...retained, ...candidates }

const updateResult = await tx.execute<{ abtests?: unknown }>(sql`
  UPDATE public.users
  SET onboarding = COALESCE(onboarding, '{}'::jsonb)
    || pg_catalog.jsonb_build_object('abtests', ${JSON.stringify(nextAssignments)}::jsonb)
  WHERE id = ${userId}::uuid
  RETURNING onboarding->'abtests' AS abtests
`)
```

Skip the update only when there are no missing or revoked tests. Return the eligible assignments, created assignments, revoked names, and email from the transaction.

- [ ] **Step 6: Run focused tests and verify they pass**

Run: `bun vitest run tests/ab-tests.unit.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit atomic reconciliation**

```bash
git add supabase/functions/_backend/utils/ab_tests.ts tests/ab-tests.unit.test.ts
git commit -m "fix(backend): revoke stale intent experiment assignments"
```

### Task 3: Reconcile Bento Tags and Verify the Backend

**Files:**
- Modify: `tests/ab-tests.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/ab_tests.ts`

- [ ] **Step 1: Write a failing Bento revocation assertion**

For the primary revocation test, assert that the on-demand Bento update removes both tags for the revoked experiment while preserving the existing created-assignment behavior:

```ts
expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
  deleteSegments: expect.arrayContaining([
    'ab:intent_targeted',
    'ab:no_intent_targeted',
  ]),
  email: 'user@example.com',
  segments: [],
})
```

Also assert that an intent-gated fixture is absent from `syncNewUserABTests` candidates when the creation-trigger user has no intent.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `bun vitest run tests/ab-tests.unit.test.ts`

Expected: FAIL because on-demand synchronization only handles created assignments.

- [ ] **Step 3: Extend best-effort on-demand tag synchronization**

Rename the created-only helper to represent reconciliation and add both configured branch tags for each revoked name to `deleteSegments`:

```ts
for (const testName of revoked) {
  const test = AB_TESTS_CONFIG[testName]
  deleteSegments.push(
    test.branches[test.treatment_branch].bento_tag,
    test.branches[test.control_branch].bento_tag,
  )
}
```

Return without calling Bento only when both `created` and `revoked` are empty. Keep failure logging best-effort for the request endpoint and retain the queue-trigger's existing retry-on-false behavior.

- [ ] **Step 4: Run focused backend tests**

Run: `bun vitest run tests/ab-tests.unit.test.ts tests/onboarding-ab-tests-endpoint.unit.test.ts tests/onboarding-ab-tests-worker-route.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Run repository-prescribed validation in order**

Run these commands against the final working tree:

```bash
bun run lint:backend
bun run lint
bun typecheck
bun test:unit
```

Expected: every command exits 0. Fix any in-scope issue and rerun the affected command plus the full sequence.

- [ ] **Step 6: Commit final implementation adjustments**

```bash
git add supabase/functions/_backend/utils/ab_tests.ts tests/ab-tests.unit.test.ts docs/superpowers/plans/2026-09-09-intent-based-ab-tests.md
git commit -m "test(backend): cover intent experiment reconciliation"
```

### Task 4: Open and Stabilize the Pull Request

**Files:**
- No source changes unless validation, CI, or review finds an in-scope defect.

- [ ] **Step 1: Confirm the final diff excludes unrelated workspace changes**

Run: `git status --short` and `git diff origin/main...HEAD --stat`

Expected: only the design, plan, backend utility, and backend unit test are committed; the unrelated `codedb.snapshot` modification remains unstaged.

- [ ] **Step 2: Push and create the pull request**

Push `wolny/intent-based-ab-tests`, then create a non-draft PR against `main` with a conventional title that does not start with `[CODEX]` and a body summarizing behavior and local verification.

- [ ] **Step 3: Apply the `pr-ready` stable-green workflow**

Inspect current head/base SHAs, remote checks, effective reviews, unresolved review threads, requested reviewers, mergeability, and repository requirements. Fix in-scope failures and restart validation after every push.

- [ ] **Step 4: Record stable observations five minutes apart**

Record observation A only when all applicable local and remote gates are green. Wait at least 300 seconds without relevant state changes, fetch fresh GitHub state, and record observation B only when the same head/base remain fully green and mergeable.

- [ ] **Step 5: Report the merge-ready evidence**

Return the PR URL, full head/base SHAs, local command outcomes, remote check outcomes, review/thread/requested-reviewer state, mergeability, and observation timestamps.
