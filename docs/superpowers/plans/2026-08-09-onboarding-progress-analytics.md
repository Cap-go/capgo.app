# Onboarding Progress Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Emit reliable, versioned PostHog events for each visible and successfully completed frontend onboarding step without changing onboarding behavior.

**Architecture:** Add a framework-independent tracker that owns the event schema, version constant, visit timing, completion deduplication, and failure isolation. `AppOnboardingFlow.vue` will create one tracker after its real initial/resume step is resolved and route successful forward transitions, back navigation, and terminal exits through small centralized functions.

**Tech Stack:** Vue 3 Composition API, TypeScript, PostHog through the existing `pushEvent` service, Vitest.

---

## Task 1: Typed onboarding progress tracker

**Files:**
- Create: `src/utils/onboardingProgressAnalytics.ts`
- Create: `tests/onboarding-progress-analytics.unit.test.ts`

- [x] **Step 1: Write failing event-schema and initial-view tests**

Create a fake capture function and clock, then assert that `createOnboardingProgressTracker` emits exactly one `onboarding_step_viewed` event with `flow`, `onboarding_version`, `step`, `step_index`, `total_steps`, and `resumed`. Assert that optional `previous_step` is omitted when unknown and that no user-entered fields exist.

- [x] **Step 2: Run the focused test and verify RED**

Run: `bunx vitest run tests/onboarding-progress-analytics.unit.test.ts`

Expected: FAIL because `src/utils/onboardingProgressAnalytics.ts` does not exist.

- [x] **Step 3: Implement the typed tracker and version constant**

Export `ONBOARDING_ANALYTICS_VERSION = 1`, narrow unions for the two flow names and six stable step IDs, typed details/intent extras, and `createOnboardingProgressTracker`. Build properties only from approved fields. Wrap every capture call in `try/catch` so analytics cannot interrupt onboarding.

- [x] **Step 4: Add failing transition, deduplication, back-navigation, duration, and failure-isolation tests**

Verify that `completeStep` emits completed before the following `viewStep`, that one visit completes at most once, that viewing the same step again resets deduplication and duration, and that a throwing capture function never throws from tracker methods.

- [x] **Step 5: Implement visit state and rerun the focused test**

Track the current step, entry step, view timestamp, and completion flag in memory. Ignore completion when it does not match the active visit or has already completed. Clamp `duration_ms` to a non-negative integer.

Run: `bunx vitest run tests/onboarding-progress-analytics.unit.test.ts`

Expected: PASS.

- [x] **Step 6: Commit the tracker**

```bash
git add src/utils/onboardingProgressAnalytics.ts tests/onboarding-progress-analytics.unit.test.ts
git commit -m "feat(onboarding): add progress analytics tracker"
```

## Task 2: Initial and resumed step views

**Files:**
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Create: `tests/app-onboarding-progress-integration.unit.test.ts`

- [x] **Step 1: Write failing source-integration assertions**

Assert that the component imports the tracker, initializes it only after the mounted loading branch resolves, passes `pre_org` or `existing_org`, derives the ordered step IDs from `appOnboardingSteps`, and passes the result of `loadResumeApp()` as `resumed`. Assert that initialization is not performed inside `loadResumeApp()` and the existing `onboarding_intent_selected` call remains.

- [x] **Step 2: Run the integration test and verify RED**

Run: `bunx vitest run tests/app-onboarding-progress-integration.unit.test.ts`

Expected: FAIL because the component does not initialize progress analytics.

- [x] **Step 3: Add tracker initialization after real-step resolution**

Declare a nullable tracker and `initializeProgressTracking(resumed)` helper. In `onMounted`, retain a `resumed` flag outside the loading branches, resolve `intent`, `details`, or the resume step first, set `isLoading` to false, then initialize and emit the single initial view. Do not report the component's temporary default `details` state.

- [x] **Step 4: Run the integration and tracker tests**

Run: `bunx vitest run tests/onboarding-progress-analytics.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts`

Expected: PASS.

- [x] **Step 5: Commit initial-view integration**

```bash
git add src/components/dashboard/AppOnboardingFlow.vue tests/app-onboarding-progress-integration.unit.test.ts
git commit -m "feat(onboarding): track initial progress views"
```

## Task 3: Successful transitions and terminal exits

**Files:**
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`

- [x] **Step 1: Add failing assertions for all success boundaries**

Assert centralized forward transition and back-navigation functions exist. Check calls occur only after intent validation, details validation, successful app creation, successful organization/app creation, real-setup selection, and terminal dashboard exit. Check the final `createdApp.app_id`, selected intent, and boolean store-import state are the only contextual values passed. The demo path must not complete `choice`, because the approved event semantics define that boundary as selecting the real-setup path.

- [x] **Step 2: Run the integration test and verify RED**

Run: `bunx vitest run tests/app-onboarding-progress-integration.unit.test.ts`

Expected: FAIL on the missing transition calls.

- [x] **Step 3: Centralize forward transitions**

Add `completeAndViewStep(nextStep, properties)` which returns when the current and next step match, emits completion for the current visit, changes `flowStep`, then emits the new view with the previous step. Use it in `continueFromIntent`, `continuePreOrgDetails`, successful `createAppRecord`, and `goToInstallStep`. Include `intent`, `store_import_used`, and the final created `app_id` only at their approved boundaries.

- [x] **Step 4: Centralize back navigation without completion**

Add `viewPreviousStep(nextStep)` which changes the step and emits a new view without completing the abandoned step. Replace the template's direct `flowStep = 'choice'` assignment with this handler.

- [x] **Step 5: Track successful terminal actions**

In `openDashboard`, complete only `install` or `setup` immediately before routing. Leave the demo path without a completion event, and ensure failed API actions return without completion.

- [x] **Step 6: Run focused tests and verify GREEN**

Run: `bunx vitest run tests/onboarding-progress-analytics.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/app-onboarding-apikey-loading.unit.test.ts`

Expected: PASS.

- [x] **Step 7: Commit transition integration**

```bash
git add src/components/dashboard/AppOnboardingFlow.vue tests/app-onboarding-progress-integration.unit.test.ts
git commit -m "feat(onboarding): track successful step transitions"
```

## Task 4: Full frontend verification

**Files:**
- Modify only if verification exposes a defect.

- [x] **Step 1: Run repository lint before final validation**

Run: `bun lint`

Expected: PASS.

- [x] **Step 2: Run frontend type checking**

Run: `bun typecheck:frontend`

Expected: PASS.

- [x] **Step 3: Run the complete unit suite**

Run: `bun test:unit`

Expected: PASS.

- [x] **Step 4: Run the registration Playwright flow when available**

Run: `bun test:front -- registration`

Expected: PASS when the required local frontend/backend environment is running. If the environment is unavailable, record the exact blocker and retain the focused unit and typecheck results.

Result: BLOCKED before browser execution because Docker Desktop was not running, so the local Supabase backend could not start. Lint, frontend type checking, and all unit tests passed.

- [x] **Step 5: Review the final diff for scope and privacy**

Confirm no onboarding copy, layout, backend, database, or existing event was changed; `codedb.snapshot` remains untouched; every new event has version `1`; and no app name, URL, email, or free text can reach the new properties.

- [x] **Step 6: Commit any verification-only fixes**

```bash
git add <only files changed to fix verification>
git commit -m "fix(onboarding): harden progress analytics"
```
