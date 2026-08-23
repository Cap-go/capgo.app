# Preserve User Onboarding Server Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent frontend onboarding progress saves from deleting A/B assignments, Bento state, or future server-owned JSON keys.

**Architecture:** Keep the existing full-value compare-and-swap update as the concurrency boundary. Define the complete frontend-owned progress-key set beside `UserOnboardingProgress`; on every write attempt, remove only those keys from the latest server value and overlay the new validated progress snapshot.

**Tech Stack:** Vue 3, TypeScript, Supabase PostgREST, Vitest

---

### Task 1: Specify generic onboarding progress merging

**Files:**
- Modify: `tests/user-onboarding-write-queue.unit.test.ts`
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`

- [x] **Step 1: Replace the Bento-only unit expectation with unknown-field preservation**

Add a test that imports `mergeUserOnboardingProgress`, supplies current JSON
containing `abtests`, `bento_events`, an arbitrary future key, and stale known
progress fields, then expects all unknown fields to survive while the new
progress fields replace the known values:

```ts
expect(mergeUserOnboardingProgress(next, current)).toEqual({
  abtests: current.abtests,
  bento_events: current.bento_events,
  future_server_state: current.future_server_state,
  ...next,
})
```

- [x] **Step 2: Add deletion and malformed-current unit cases**

Verify an omitted known key such as `app_id` is absent from the result, while a
malformed current value produces only the new progress snapshot:

```ts
expect(mergeUserOnboardingProgress(next, { app_id: 'stale', server_key: true })).toEqual({
  server_key: true,
  ...next,
})
expect(mergeUserOnboardingProgress(next, ['invalid'])).toEqual(next)
```

- [x] **Step 3: Extend the CAS integration test**

Change the refreshed CAS snapshot to introduce a new `abtests` assignment and
an arbitrary server field. Assert the second conditional write uses the
refreshed object as its expected value and carries both fields into its proposed
replacement value.

- [x] **Step 4: Run the focused tests and verify RED**

Run:

```bash
bun test:unit tests/user-onboarding-write-queue.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: FAIL because `mergeUserOnboardingProgress` does not exist and the
current Bento-specific helper does not preserve `abtests` or arbitrary keys.

### Task 2: Implement owned-field replacement

**Files:**
- Modify: `src/utils/userOnboardingProgress.ts`
- Modify: `src/services/userOnboardingWriteQueue.ts`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Test: `tests/user-onboarding-write-queue.unit.test.ts`
- Test: `tests/app-onboarding-progress-integration.unit.test.ts`

- [x] **Step 1: Define the complete owned-field set**

Export a compile-time checked record beside `UserOnboardingProgress`:

```ts
export const USER_ONBOARDING_PROGRESS_FIELDS = {
  status: true,
  step: true,
  flow: true,
  intent: true,
  details_step: true,
  app_name: true,
  app_id: true,
  existing_app: true,
  existing_app_setup: true,
  store_url: true,
  imported_store_app_id: true,
  org_name: true,
  estimated_users_index: true,
  onboarding_attempt_id: true,
  last_run_id: true,
  updated_at: true,
  completed_at: true,
} as const satisfies Record<keyof UserOnboardingProgress, true>
```

The `Record` constraint makes a future interface field a type error until its
ownership is explicitly decided.

- [x] **Step 2: Replace the Bento-specific helper**

In `userOnboardingWriteQueue.ts`, import the owned-field record and implement:

```ts
export function mergeUserOnboardingProgress(nextProgress: Json, currentOnboarding: Json | undefined): Json {
  const merged = isJsonObject(currentOnboarding) ? { ...currentOnboarding } : {}
  for (const key of Object.keys(USER_ONBOARDING_PROGRESS_FIELDS))
    delete merged[key]
  return isJsonObject(nextProgress) ? { ...merged, ...nextProgress } : merged
}
```

Delete `preserveUserBentoEvents`; no server-owned key should require a manual
preservation exception.

- [x] **Step 3: Use the generic merge on every CAS attempt**

Replace the `preserveUserBentoEvents` call in `AppOnboardingFlow.vue` with:

```ts
const onboarding = mergeUserOnboardingProgress(
  onboardingWithPreferences,
  currentOnboarding,
)
```

Because `currentOnboarding` is refreshed after each zero-row conditional
update, every retry merges against the latest complete JSON value.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
bun test:unit tests/user-onboarding-write-queue.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: both files pass with no warnings or unhandled errors.

- [x] **Step 5: Run formatting and static checks**

Run:

```bash
bun lint
bun typecheck
```

Expected: both commands exit successfully.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/utils/userOnboardingProgress.ts src/services/userOnboardingWriteQueue.ts src/components/dashboard/AppOnboardingFlow.vue tests/user-onboarding-write-queue.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts docs/superpowers/plans/2026-08-23-preserve-user-onboarding-server-fields.md
git commit -m "fix(onboarding): preserve server-owned user state"
```

### Task 3: Verify and deliver the pull request

**Files:**
- Verify all files committed by Tasks 1 and 2

- [ ] **Step 1: Run the complete relevant local suite**

```bash
bun test:unit
bun lint
bun typecheck
```

Expected: every command exits successfully.

- [ ] **Step 2: Inspect the final diff**

```bash
git diff --check origin/main...HEAD
git status --short
```

Expected: no whitespace errors and no unintended tracked changes. The generated
local `codedb.snapshot` modification must not be committed.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin wolny/preserve-onboarding-server-fields
gh pr create --base main --title "fix(onboarding): preserve server-owned user state" --body "Preserves every server-owned users.onboarding key while replacing only the explicit frontend progress fields. Keeps the existing compare-and-swap retry so concurrent backend writes cannot be overwritten. Verified with focused regression tests, the unit suite, lint, and typecheck."
```

The PR body must describe the lost-update symptom, the explicit frontend-owned
field boundary, CAS concurrency behavior, and exact local verification.

- [ ] **Step 4: Run the `pr-ready` workflow**

Inspect all checks, reviews, threads, mergeability, and repository requirements.
After the first fully green observation, wait at least five minutes and verify
the unchanged head and base are still fully green before reporting completion.
