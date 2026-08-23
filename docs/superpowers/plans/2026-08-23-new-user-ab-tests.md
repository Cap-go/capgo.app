# New-user A/B Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign eligible new users to stable JSON-configured A/B branches and synchronize the selected branch to Bento.

**Architecture:** A checked-in JSON file declares active experiments. A focused backend utility validates the config, selects branches with `Math.random`, atomically merges missing assignments into `users.onboarding.abtests`, and synchronizes the winning Bento tags; the existing user-create handler invokes it during provisioning.

**Tech Stack:** TypeScript, Hono, PostgreSQL JSONB, Bento subscriber tags, Vitest, Bun.

---

### Task 1: Build and test the assignment utility

**Files:**
- Create: `supabase/functions/_backend/utils/ab_tests.json`
- Create: `supabase/functions/_backend/utils/ab_tests.ts`
- Create: `tests/ab-tests.unit.test.ts`

- [ ] **Step 1: Write failing pure assignment tests**

Create deterministic tests for the 50% boundary, 0% and 100% allocation, and `self_signup` versus `all` audiences:

```ts
const config = validateABTestsConfig({
  new_emails: {
    audience: 'self_signup',
    branch_a_percentage: 50,
    branches: {
      A: { bento_tag: 'ab:new_emails' },
      B: { bento_tag: 'ab:no_new_emails' },
    },
  },
})

expect(createABTestAssignments(user, config, () => 0.4999, () => FIXED_DATE))
  .toEqual({ new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'A' } })
expect(createABTestAssignments(user, config, () => 0.5, () => FIXED_DATE))
  .toEqual({ new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'B' } })
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test tests/ab-tests.unit.test.ts`

Expected: FAIL because `utils/ab_tests.ts` does not exist.

- [ ] **Step 3: Add the JSON configuration**

```json
{
  "new_emails": {
    "audience": "self_signup",
    "branch_a_percentage": 50,
    "branches": {
      "A": { "bento_tag": "ab:new_emails" },
      "B": { "bento_tag": "ab:no_new_emails" }
    }
  }
}
```

- [ ] **Step 4: Implement config validation and branch selection**

Expose these focused boundaries from `ab_tests.ts`:

```ts
export type ABTestAudience = 'all' | 'self_signup'
export type ABTestBranch = 'A' | 'B'

export interface ABTestConfig {
  audience: ABTestAudience
  branch_a_percentage: number
  branches: Record<ABTestBranch, { bento_tag: string }>
}

export interface ABTestAssignment {
  assigned_at: string
  branch: ABTestBranch
}

export function validateABTestsConfig(value: unknown): Record<string, ABTestConfig>
export function createABTestAssignments(
  user: Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite'>,
  config?: Record<string, ABTestConfig>,
  random?: () => number,
  now?: () => Date,
): Record<string, ABTestAssignment>
```

Validation rejects malformed entries, unsupported audiences, non-integer percentages outside 0–100, blank tags, and identical A/B tags. Assignment evaluates each eligible experiment, samples once, and records one ISO timestamp.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `bun test tests/ab-tests.unit.test.ts`

Expected: PASS for validation, boundary, percentage, and audience cases.

- [ ] **Step 6: Write failing persistence and Bento tests**

Mock `getPgClient`, `closeClient`, and `syncBentoSubscriberTags`. Make PostgreSQL return an existing B assignment after the candidate random value selects A, then assert the persisted B branch controls Bento:

```ts
pgQueryMock.mockResolvedValueOnce({
  rows: [{ abtests: { new_emails: { assigned_at: FIXED_ISO, branch: 'B' } } }],
})

await syncNewUserABTests(context, 'new.user@example.com', user)

expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
  email: 'new.user@example.com',
  segments: ['ab:no_new_emails'],
  deleteSegments: ['ab:new_emails'],
})
```

Also assert that SQL parameters contain the generated candidate, SQL places candidate assignments before existing assignments so existing values win, the checked-out client is destroyed before Bento starts, a missing user row fails, and a configured Bento `false` result fails for queue retry.

- [ ] **Step 7: Run the focused test and verify RED**

Run: `bun test tests/ab-tests.unit.test.ts`

Expected: FAIL because `syncNewUserABTests` is missing.

- [ ] **Step 8: Implement atomic persistence and Bento synchronization**

Expose:

```ts
export async function syncNewUserABTests(
  c: Context<MiddlewareKeyVariables>,
  email: string,
  user: Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite' | 'id'>,
): Promise<void>
```

Use one read-write pool and checked-out client. Merge candidates atomically with existing assignments taking precedence:

```sql
UPDATE public.users
SET onboarding = COALESCE(onboarding, '{}'::jsonb)
  || pg_catalog.jsonb_build_object(
    'abtests',
    $2::jsonb || CASE
      WHEN pg_catalog.jsonb_typeof(onboarding->'abtests') = 'object'
        THEN onboarding->'abtests'
      ELSE '{}'::jsonb
    END
  )
WHERE id = $1::uuid
RETURNING onboarding->'abtests' AS abtests
```

Release the checked-out client with `release(true)` and close the pool before Bento I/O. Add the persisted branch tag and remove the opposite tag. Treat Bento `undefined` as unconfigured success and `false` as `quickError(500, 'bento_ab_test_delivery_failed', ...)`.

- [ ] **Step 9: Run the focused test and verify GREEN**

Run: `bun test tests/ab-tests.unit.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 10: Commit the utility slice**

```bash
git add -- supabase/functions/_backend/utils/ab_tests.json supabase/functions/_backend/utils/ab_tests.ts tests/ab-tests.unit.test.ts
git commit -m "feat(backend): assign new users to A/B tests"
```

### Task 2: Wire assignment into user creation

**Files:**
- Modify: `supabase/functions/_backend/triggers/on_user_create.ts`
- Modify: `tests/bento-first-org-lifecycle.unit.test.ts`

- [ ] **Step 1: Write the failing route orchestration test**

Mock `syncNewUserABTests` and assert a provisioned request invokes it with the normalized email and record. Assert the existing early return for a deletion race does not invoke it:

```ts
expect(syncNewUserABTestsMock).toHaveBeenCalledWith(
  expect.anything(),
  'new.user@example.com',
  expect.objectContaining({ id: USER_ID }),
)
```

- [ ] **Step 2: Run the route test and verify RED**

Run: `bun test tests/bento-first-org-lifecycle.unit.test.ts`

Expected: FAIL because the handler has not called `syncNewUserABTests`.

- [ ] **Step 3: Add the handler call after API-key creation**

```ts
await createApiKey(c, record.id)
await syncNewUserABTests(c, normalizeBentoEmail(record.email), record)
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/ab-tests.unit.test.ts tests/bento-first-org-lifecycle.unit.test.ts`

Expected: both files PASS.

- [ ] **Step 5: Commit the route slice**

```bash
git add -- supabase/functions/_backend/triggers/on_user_create.ts tests/bento-first-org-lifecycle.unit.test.ts
git commit -m "feat(backend): enroll new users in A/B tests"
```

### Task 3: Validate and publish

**Files:**
- Verify all files changed in Tasks 1 and 2.

- [ ] **Step 1: Run repository formatting/lint first**

Run: `bun lint`

Expected: exit 0.

- [ ] **Step 2: Run type checking and the unit suite**

Run: `bun typecheck`

Run: `bun test:unit`

Expected: both exit 0.

- [ ] **Step 3: Inspect final state**

Run: `git diff --check origin/main...HEAD`

Run: `git status --short`

Expected: no diff errors; only the pre-existing unstaged `codedb.snapshot` change remains outside feature commits.

- [ ] **Step 4: Push and open a non-draft PR**

Push `wolny/ab-test-new-emails`, reuse a matching open PR if one exists, otherwise open one against `main` with the feature summary and local verification evidence. The user explicitly requested a review-ready PR, so publish it as non-draft.

- [ ] **Step 5: Prove `pr-ready` stable-green**

Inspect required checks, reviews, unresolved threads, mergeability, head/base SHAs, and repository requirements. Record observation A only when every applicable gate passes; wait at least 300 seconds without relevant changes; fetch fresh state and record observation B. Address in-scope failures and restart after every push or relevant state change.
