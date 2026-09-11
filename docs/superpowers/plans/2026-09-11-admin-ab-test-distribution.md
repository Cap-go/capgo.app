# Admin A/B Test Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only admin dashboard page that shows counts and percentages for both branches of every configured A/B test.

**Architecture:** Extend the central A/B test configuration with display labels, add one admin-only replica aggregate behind the existing `admin_stats` endpoint, and render the response through a focused Vue page and presentation helper. The backend owns configured-test completeness and percentage math; the frontend owns only responsive presentation and locale formatting.

**Tech Stack:** Vue 3, TypeScript, Pinia, Hono, PostgreSQL JSONB, Vitest, TailwindCSS/DaisyUI.

---

### Task 1: Make A/B test display metadata explicit

**Files:**
- Modify: `supabase/functions/_backend/utils/ab_tests.json`
- Modify: `supabase/functions/_backend/utils/ab_tests.ts`
- Modify: `tests/ab-tests.unit.test.ts`
- Modify: `tests/onboarding-ab-tests.unit.test.ts`

- [ ] **Step 1: Write the failing configuration tests**

Add expectations that every configured test has a non-empty `label` and that each configured branch has a non-empty `label`. Add invalid cases for blank test and branch labels.

```ts
expect(config.new_emails?.label).toBe('Email template')
expect(config.new_emails?.branches.A.label).toBe('New emails')
expect(() => validateABTestsConfig({
  ...config,
  new_emails: { ...config.new_emails, label: ' ' },
})).toThrow('Invalid A/B test configuration')
```

- [ ] **Step 2: Run the tests and confirm the metadata expectations fail**

Run: `bun vitest run tests/ab-tests.unit.test.ts tests/onboarding-ab-tests.unit.test.ts`

Expected: FAIL because labels are not yet part of the configuration contract.

- [ ] **Step 3: Add validated display metadata**

Add `label` to `ABTestConfig` and each branch entry, validate that all labels are non-empty strings, preserve them in `validateABTestsConfig`, and populate labels for all four active experiments in `ab_tests.json`.

```ts
export interface ABTestConfig {
  audience: ABTestAudience
  control_branch: ABTestBranch
  intents?: ABTestIntent[]
  label: string
  branches: Record<string, { bento_tag: string, label: string }>
  treatment_branch: ABTestBranch
  treatment_percentage: number
}
```

Use these exact labels: `Email template` with `New emails` / `Old emails`; `Channel creation` with `Guided channel flow` / `Current channel flow`; `Publish intent` with `WebNativeApp option` / `Current publish options`; and `Development environment` with `Development environment question` / `Current onboarding`.

- [ ] **Step 4: Run the focused tests**

Run: `bun vitest run tests/ab-tests.unit.test.ts tests/onboarding-ab-tests.unit.test.ts`

Expected: PASS.

### Task 2: Add the admin distribution metric

**Files:**
- Create: `supabase/functions/_backend/utils/ab_test_distribution.ts`
- Modify: `supabase/functions/_backend/private/admin_stats.ts`
- Modify: `tests/admin-stats.unit.test.ts`
- Create: `tests/admin-ab-test-distribution.unit.test.ts`

- [ ] **Step 1: Write failing aggregation tests**

Cover configured ordering, number/string database counts, both branch percentages, malformed/unconfigured rows, and configured tests with no rows.

```ts
expect(buildAdminABTestDistribution([
  { test_name: 'new_emails', branch: 'A', assignments: '400' },
  { test_name: 'new_emails', branch: 'B', assignments: '403' },
], config)[0]).toMatchObject({
  test_name: 'new_emails',
  label: 'Email template',
  total: 803,
  branches: [
    { branch: 'A', label: 'New emails', count: 400, percentage: 49.8 },
    { branch: 'B', label: 'Old emails', count: 403, percentage: 50.2 },
  ],
})
```

Also assert that `adminStatsBodySchema` accepts `ab_test_distribution`.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `bun vitest run tests/admin-ab-test-distribution.unit.test.ts tests/admin-stats.unit.test.ts`

Expected: FAIL because the metric and helper do not exist.

- [ ] **Step 3: Implement the replica aggregate and response builder**

Create `getAdminABTestDistribution(c)` using `getPgClient(c, true)` and `closeClient` in `finally`. Query only grouped counts and configured names:

```sql
SELECT assignment.test_name,
       assignment.value ->> 'branch' AS branch,
       count(*)::bigint AS assignments
FROM public.users AS user_account
CROSS JOIN LATERAL jsonb_each(
  CASE
    WHEN jsonb_typeof(user_account.onboarding -> 'abtests') = 'object'
      THEN user_account.onboarding -> 'abtests'
    ELSE '{}'::jsonb
  END
) AS assignment(test_name, value)
WHERE assignment.test_name = ANY($1::text[])
  AND jsonb_typeof(assignment.value) = 'object'
GROUP BY assignment.test_name, assignment.value ->> 'branch'
```

Merge rows into the configured order and return both configured branches for every test. Calculate percentages to one decimal and use zero for both branches when the total is zero.

- [ ] **Step 4: Wire the new metric through `admin_stats`**

Add the category to the Zod enum and switch, import the helper, and return its result through the existing response envelope.

- [ ] **Step 5: Run focused backend tests**

Run: `bun vitest run tests/admin-ab-test-distribution.unit.test.ts tests/admin-stats.unit.test.ts tests/ab-tests.unit.test.ts tests/onboarding-ab-tests.unit.test.ts`

Expected: PASS.

### Task 3: Build the compact matrix page

**Files:**
- Create: `src/services/adminABTestDistribution.ts`
- Create: `src/pages/admin/dashboard/ab-tests.vue`
- Modify: `src/constants/adminTabs.ts`
- Modify: `src/stores/adminDashboard.ts`
- Modify: `messages/en.json`
- Create: `tests/admin-ab-test-dashboard.unit.test.ts`

- [ ] **Step 1: Write failing presentation and wiring tests**

Test defensive response parsing, total assignment calculation, the `ab_test_distribution` store category, the `/ab-tests` tab, translation keys, and the page's count/percentage fields.

```ts
expect(parseAdminABTestDistribution(payload)).toEqual(payload)
expect(totalABTestAssignments(payload)).toBe(803)
expect(adminTabsSource).toContain("key: '/ab-tests'")
expect(pageSource).toContain(`fetchStats('ab_test_distribution')`)
```

- [ ] **Step 2: Run the frontend unit test and confirm it fails**

Run: `bun vitest run tests/admin-ab-test-dashboard.unit.test.ts`

Expected: FAIL because the page, service, tab, and messages do not exist.

- [ ] **Step 3: Add the typed presentation service**

Define the response interfaces, reject malformed payloads rather than displaying misleading zeroes, and export a total helper.

```ts
export interface AdminABTestDistribution {
  test_name: string
  label: string
  total: number
  branches: Array<{ branch: string, label: string, count: number, percentage: number }>
}
```

- [ ] **Step 4: Implement the page and navigation**

Add the A/B Tests tab using the existing Heroicons beaker icon. The page loads the metric, shows the existing page loader, renders an alert plus retry button on failure, and renders the selected compact matrix. Use semantic headings and progress bars with visible counts and percentages, `tabular-nums`, the existing blue/violet palette, and a stacked narrow-screen layout.

- [ ] **Step 5: Add English translations**

Add keys for the tab, page title/description, assignment total, column labels, error, retry, and empty state. Translation calls use keys only.

- [ ] **Step 6: Run focused frontend tests**

Run: `bun vitest run tests/admin-ab-test-dashboard.unit.test.ts`

Expected: PASS.

### Task 4: Verify behavior and visual fidelity

**Files:**
- Create: `design-qa.md`
- Create: `output/playwright/admin-ab-tests-compact-matrix.webp`

- [ ] **Step 1: Run repository formatting and static checks**

Run: `bun lint`

Run: `bun typecheck`

Expected: both PASS.

- [ ] **Step 2: Run focused and full unit coverage**

Run: `bun vitest run tests/admin-ab-test-distribution.unit.test.ts tests/admin-ab-test-dashboard.unit.test.ts tests/admin-stats.unit.test.ts tests/ab-tests.unit.test.ts tests/onboarding-ab-tests.unit.test.ts`

Run: `bun test:unit`

Expected: PASS.

- [ ] **Step 3: Build the application**

Run: `bun build`

Expected: PASS.

- [ ] **Step 4: Render and inspect the selected page**

Run the local app and open `/admin/dashboard/ab-tests` in the in-app browser at 1440 × 1024. Verify the selected navigation state, loading/error/loaded states, compact desktop matrix, responsive stacking, and browser console.

- [ ] **Step 5: Complete Product Design QA**

Compare the selected option-3 image and the browser capture together. Record viewport, dimensions, state, interactions, console status, the five fidelity surfaces, iteration history, and `final result: passed` in `design-qa.md`. Fix all P0/P1/P2 findings and repeat the capture/comparison if needed.

### Task 5: Commit, open the PR, and prove stable-green

**Files:**
- Modify: only the intended feature, test, documentation, and QA artifacts above

- [ ] **Step 1: Review the final diff and commit**

Exclude the unrelated `codedb.snapshot` worktree change. Commit with a Conventional Commit message such as `feat(admin): show A/B test distribution`.

- [ ] **Step 2: Push and open a non-draft pull request**

Push `wolny/admin-ab-test-distribution` and open a PR against `main`. Keep the PR title free of the forbidden `[CODEX]` prefix and describe the generic feature without private data.

- [ ] **Step 3: Run the requested `pr-ready` workflow**

Inspect the authoritative remote checks, reviews, unresolved conversations, requested reviewers, mergeability, branch protection, head SHA, and base SHA. Fix in-scope failures and restart the observation window after every relevant change.

- [ ] **Step 4: Record stable-green observations**

Record observation A only after every local and remote gate passes. Wait at least 300 seconds, fetch fresh state, and record observation B only if the head/base and all relevant PR state remain unchanged and green.
