# New Channel Onboarding A/B Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the reviewed four-screen channel onboarding behind a 50/50 `new_channel` experiment that is assigned only to self-signup users whose exact persisted intent is `ota` or `both`, while preserving resumable channel progress and distinct analytics versions.

**Architecture:** The existing intent-aware A/B endpoint remains authoritative. The frontend fetches experiments before the intent screen for existing onboarding experiments, persists the selected intent before forcing a second fetch, and treats only branch `A` of `new_channel` as permission to enter the channel sequence. Channel substeps are stored in the existing `users.onboarding` JSONB document as `setup_stage`; invalid or no-longer-eligible saved channel stages are clamped to `cli`.

**Tech Stack:** Vue 3 Composition API, TypeScript, Supabase/PostgreSQL JSONB, Hono/Deno backend utilities, Vitest, ESLint, Bun.

---

### Task 1: Configure and interpret the `new_channel` experiment

**Files:**
- Modify: `supabase/functions/_backend/utils/ab_tests.json`
- Modify: `src/utils/onboardingABTests.ts`
- Modify: `src/utils/onboardingProgressAnalytics.ts`
- Test: `tests/ab-tests.unit.test.ts`
- Test: `tests/onboarding-ab-tests.unit.test.ts`
- Test: `tests/onboarding-progress-analytics.unit.test.ts`

- [ ] **Step 1: Write failing configuration and resolver tests**

Assert that `new_channel` has `audience: "self_signup"`, `intents: ["ota", "both"]`, a 50 percent treatment, and `A`/`B` branches. Add resolver cases proving branch A maps to `5.E`, branch A plus development-environment C maps to `5.F`, branch A plus publish-intent A and exact `ota`/`both` maps to `5.G`, and branch B preserves existing versions.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
bunx vitest run tests/ab-tests.unit.test.ts tests/onboarding-ab-tests.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts
```

Expected: failures for missing `new_channel`, treatment helper, and `5.E`/`5.F`/`5.G` constants.

- [ ] **Step 3: Add the configuration and typed helpers**

Add this entry to `ab_tests.json`:

```json
"new_channel": {
  "comment": "Shows the guided channel education and creation flow.",
  "audience": "self_signup",
  "intents": ["ota", "both"],
  "treatment_percentage": 50,
  "treatment_branch": "A",
  "control_branch": "B",
  "branches": {
    "A": { "bento_tag": "ab:new_channel" },
    "B": { "bento_tag": "ab:no_new_channel" }
  }
}
```

Export `NEW_CHANNEL_AB_TEST`, add `hasNewChannelTreatment()`, and resolve versions with this precedence:

```ts
if (hasNewChannelTreatment(onboarding) && hasWebNativeDevelopmentEnvironmentTreatment(onboarding))
  return NEW_CHANNEL_DEVELOPMENT_ENVIRONMENT_ANALYTICS_VERSION
if (hasNewChannelTreatment(onboarding) && hasWebNativePublishIntentTreatment(onboarding) && (intent === 'ota' || intent === 'both'))
  return NEW_CHANNEL_PUBLISH_INTENT_ANALYTICS_VERSION
if (hasNewChannelTreatment(onboarding))
  return NEW_CHANNEL_ANALYTICS_VERSION
```

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the experiment slice**

```bash
git add supabase/functions/_backend/utils/ab_tests.json src/utils/onboardingABTests.ts src/utils/onboardingProgressAnalytics.ts tests/ab-tests.unit.test.ts tests/onboarding-ab-tests.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts
git commit -m "feat(onboarding): add channel creation experiment"
```

### Task 2: Make the post-intent A/B refresh authoritative

**Files:**
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Test: `tests/app-onboarding-progress-integration.unit.test.ts`

- [ ] **Step 1: Write failing request lifecycle and ordering tests**

Assert that the pre-intent request still runs, `continueFromGoal()` persists the selected intent before a forced A/B refresh, the in-flight promise is cleared in `finally`, and the local `new_channel` assignment is deleted before authoritative assignments are merged.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
bunx vitest run tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: failures because `continueFromGoal()` is synchronous and the resolved request remains cached.

- [ ] **Step 3: Implement forced refresh and fail-closed gating**

Change the request API to:

```ts
function refreshOnboardingABTests(options: { force?: boolean } = {}): Promise<void>
```

Deduplicate only an in-flight request, clear it in `finally`, delete `NEW_CHANNEL_AB_TEST` from both local assignment maps before merging the authoritative response, and make `continueFromGoal()` await:

```ts
await persistOnboardingProgress()
await waitForOnboardingABTests({ force: true })
```

If the refresh errors or times out, absence of confirmed branch A keeps `setupStage` at `cli`.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run the command from Step 2. Expected: all assertions pass.

- [ ] **Step 5: Commit the request lifecycle slice**

```bash
git add src/components/dashboard/AppOnboardingFlow.vue tests/app-onboarding-progress-integration.unit.test.ts
git commit -m "fix(onboarding): refresh experiments after intent"
```

### Task 3: Persist and restore channel setup progress

**Files:**
- Modify: `src/utils/userOnboardingProgress.ts`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Test: `tests/user-onboarding-progress.unit.test.ts`
- Test: `tests/app-onboarding-progress-integration.unit.test.ts`

- [ ] **Step 1: Write failing JSON parsing and resume tests**

Cover every valid stage (`channel-routing`, `channel-self-assign`, `channel-console-assign`, `channel-create`, `cli`), reject unknown stages, round-trip `setup_stage`, persist forward/back transitions, restore a saved stage for treatment A, and clamp a saved channel stage to `cli` for control or a revoked assignment.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
bunx vitest run tests/user-onboarding-progress.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: failures for the missing `setup_stage` type and persistence behavior.

- [ ] **Step 3: Implement setup-stage persistence**

Add:

```ts
export const USER_ONBOARDING_SETUP_STAGES = ['channel-routing', 'channel-self-assign', 'channel-console-assign', 'channel-create', 'cli'] as const
export type UserOnboardingSetupStage = typeof USER_ONBOARDING_SETUP_STAGES[number]
```

Parse and build optional `setup_stage`, include it in `USER_ONBOARDING_PROGRESS_FIELDS`, snapshot it from the component, and route every transition through:

```ts
function setSetupStage(nextStage: SetupStage) {
  setupStage.value = nextStage
  void persistOnboardingProgress()
}
```

The treatment starts or resumes in its valid saved channel stage; all other users start at `cli`.

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the persistence slice**

```bash
git add src/utils/userOnboardingProgress.ts src/components/dashboard/AppOnboardingFlow.vue tests/user-onboarding-progress.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
git commit -m "feat(onboarding): persist channel setup progress"
```

### Task 4: Accept the new analytics versions in backend reporting

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`
- Modify: `supabase/functions/_backend/utils/user_bento_events.ts`
- Test: `tests/frontend-onboarding-analytics.unit.test.ts`
- Test: `tests/user-bento-events.unit.test.ts`

- [ ] **Step 1: Write failing whitelist and parser tests**

Assert that `5.E`, `5.F`, and `5.G` are included wherever `5.A` and `5.C` are accepted, grouped, and forwarded as onboarding version values.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts tests/user-bento-events.unit.test.ts
```

Expected: failures because the backend currently recognizes only `5.A` and `5.C`.

- [ ] **Step 3: Extend the shared label list and parsers**

Use one shared set of labels:

```ts
export const WEBNATIVE_ONBOARDING_VERSION_LABELS = ['5.A', '5.C', '5.E', '5.F', '5.G'] as const
```

Update both the analytics result parser and Bento field validator to accept the same values without converting them to integers.

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the analytics slice**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts supabase/functions/_backend/utils/frontend_onboarding_analytics.ts supabase/functions/_backend/utils/user_bento_events.ts tests/frontend-onboarding-analytics.unit.test.ts tests/user-bento-events.unit.test.ts
git commit -m "feat(analytics): recognize channel onboarding versions"
```

### Task 5: Preserve reviewed UI polish and complete verification

**Files:**
- Modify: `messages/en.json`
- Modify: `src/components/dashboard/ChannelCreateOnboarding.vue`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Modify: `tests/channel-create-onboarding.unit.test.ts`
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`
- Modify: `tests/app-onboarding-v3.unit.test.ts`

- [ ] **Step 1: Apply the reviewed UI details**

Keep the step label as `Channel`, ensure the channel-name leading icon sits above the input background, retain a constant self-assignment card height when toggled off, and preserve the latest `Don't show again` action in the CLI stage.

- [ ] **Step 2: Run formatter/lint fixes before validation**

```bash
bun lint:fix
```

Expected: exit 0 and only intended/generated formatting changes.

- [ ] **Step 3: Run focused and repository completion gates**

```bash
bunx vitest run tests/ab-tests.unit.test.ts tests/onboarding-ab-tests.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts tests/user-onboarding-progress.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/app-onboarding-v3.unit.test.ts tests/channel-animation-themes.unit.test.ts tests/channel-console-assign-mockup.unit.test.ts tests/channel-create-onboarding.unit.test.ts tests/channel-default-routing-mockup.unit.test.ts tests/channel-self-assign-mockup.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/user-bento-events.unit.test.ts
bun lint
bun typecheck
bun build
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit final integration fixes**

```bash
git add messages/en.json src/components/dashboard/ChannelCreateOnboarding.vue src/components/dashboard/AppOnboardingFlow.vue tests
git commit -m "fix(onboarding): finalize channel experiment flow"
```

- [ ] **Step 5: Push, open the PR, and run the repository `pr-ready` workflow**

Push `wolny/new-channel-onboarding-ab`, open a non-draft PR against `main`, inspect every review thread and required check, fix actionable failures, then record two fully green observations at least five minutes apart for unchanged head/base SHAs.
