# Onboarding Exploration Dialogue Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the Dashboard sidebar item from reopening the exploration confirmation dialogue after the current user has already received the in-memory onboarding exploration grant.

**Architecture:** Keep onboarding redirect and banner state unchanged. Put the confirmation decision beside the existing exploration-state helpers in `onboardingRedirect.ts`, cover it with a focused unit test, and have `Sidebar.vue` use that decision instead of treating every resume app ID as requiring confirmation.

**Tech Stack:** Vue 3, TypeScript, Vitest, Bun, ESLint

---

### Task 1: Add the failing exploration-confirmation regression

**Files:**
- Modify: `tests/onboarding-redirect.unit.test.ts`
- Modify: `src/utils/onboardingRedirect.ts`

- [x] **Step 1: Write the failing test**

Extend the import-based utility test with this case:

```ts
it('asks for dashboard confirmation only before exploration is granted', async () => {
  const module = await import('../src/utils/onboardingRedirect.ts')

  expect(module.shouldConfirmOnboardingDashboardExploration({
    destination: '/dashboard',
    resumeAppId: 'com.example.app',
    userId: 'user-1',
  })).toBe(true)

  module.allowOnboardingDashboardExploration('user-1', 'com.example.app')

  expect(module.shouldConfirmOnboardingDashboardExploration({
    destination: '/dashboard',
    resumeAppId: 'com.example.app',
    userId: 'user-1',
  })).toBe(false)
})
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `bunx vitest run tests/onboarding-redirect.unit.test.ts`

Expected: FAIL because `shouldConfirmOnboardingDashboardExploration` does not exist.

- [x] **Step 3: Add the minimal decision helper**

Add this exported helper to `src/utils/onboardingRedirect.ts` after `canExploreOnboardingDashboard`:

```ts
export function shouldConfirmOnboardingDashboardExploration(options: {
  destination: string
  resumeAppId: string | null | undefined
  userId: string | null | undefined
}) {
  return options.destination === '/dashboard'
    && !!options.resumeAppId
    && !canExploreOnboardingDashboard(options.userId)
}
```

- [x] **Step 4: Run the focused test to verify it passes**

Run: `bunx vitest run tests/onboarding-redirect.unit.test.ts`

Expected: PASS with all onboarding redirect tests green.

### Task 2: Use the tested decision in the Sidebar

**Files:**
- Modify: `src/components/Sidebar.vue:18`
- Modify: `src/components/Sidebar.vue:66`

- [x] **Step 1: Replace the inline confirmation condition**

Import the tested helper:

```ts
import {
  allowOnboardingDashboardExploration,
  getOnboardingResumeAppId,
  shouldConfirmOnboardingDashboardExploration,
} from '~/utils/onboardingRedirect'
```

Replace the current two-condition expression with:

```ts
const requiresOnboardingExplorationConfirmation = shouldConfirmOnboardingDashboardExploration({
  destination: tab.key,
  resumeAppId: onboardingResumeAppId,
  userId: onboardingUserId,
})
```

- [x] **Step 2: Run focused behavior tests**

Run: `bunx vitest run tests/onboarding-redirect.unit.test.ts tests/auth-sso-provisioning.unit.test.ts`

Expected: PASS with no failed tests.

- [x] **Step 3: Run frontend lint**

Run: `bun lint`

Expected: exit code 0 with no lint errors.

- [x] **Step 4: Run frontend typecheck**

Run: `bun typecheck`

Expected: exit code 0 with no TypeScript errors.

- [x] **Step 5: Inspect the final diff and commit**

Run: `git diff --check && git diff -- src/components/Sidebar.vue src/utils/onboardingRedirect.ts tests/onboarding-redirect.unit.test.ts`

Expected: no whitespace errors; the diff contains only the tested confirmation decision and its Sidebar wiring.

Commit:

```bash
git add src/components/Sidebar.vue src/utils/onboardingRedirect.ts tests/onboarding-redirect.unit.test.ts docs/superpowers/plans/2026-08-07-onboarding-exploration-dialog.md
git commit -m "fix(onboarding): avoid repeated exploration prompt"
```
