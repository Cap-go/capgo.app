# Frontend Onboarding Resume Telemetry Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve `onboarding_attempt_id` across accepted frontend onboarding resumes, distinguish each wizard mount with `onboarding_run_id`, and capture the resume dialog outcome without duplicating step-view events.

**Architecture:** Extend the existing frontend onboarding analytics helper with one small identity context, rather than adding another service or backend path. Persist the active attempt and latest run inside the existing `users.onboarding` JSON payload, inject those IDs into the existing progress tracker, and let the current initialization/navigation helpers remain the only owners of `onboarding_step_viewed`.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, PostHog through the existing `pushEvent` service, Supabase JSONB through the existing authenticated client.

---

## Source Design And Scope Guard

Implement against
[`docs/superpowers/specs/2026-08-15-frontend-onboarding-resume-telemetry-identities-design.md`](../specs/2026-08-15-frontend-onboarding-resume-telemetry-identities-design.md).

This is deliberately a small PR:

- Start the implementation branch from `origin/main`, not from the planning
  branch, so planning documents do not count toward the implementation PR.
- Target at most 300 changed production lines; stop and simplify before the
  production diff reaches 500 changed lines. Keep the required tests focused,
  but do not trade behavioral coverage for a smaller test diff.
- Do not change PostHog queries, the admin dashboard, the resume dialog UI,
  translations, Playwright scenarios, or backend endpoints.
- Do not add a migration, database constraint, index, Postgres test, generic
  telemetry framework, run-started event, or run-ended event.
- Cover the normal fresh, Continue, Restart, and pre-fix legacy paths. Preserve
  existing compare-and-swap behavior rather than adding new multi-tab recovery.

## File Map And Line Budget

- Modify `src/utils/onboardingProgressAnalytics.ts` — add the compact identity
  context and inject supplied attempt/run IDs into the existing tracker.
  Budget: about 90 changed lines.
- Modify `src/utils/userOnboardingProgress.ts` — parse and build the two optional
  persisted telemetry fields. Budget: about 25 changed lines.
- Create `src/utils/onboardingProgressPersistence.ts` — isolate the serialized
  persistence lifecycle and its abort/conflict barriers. Budget: about 70
  changed lines.
- Modify `src/components/dashboard/AppOnboardingFlow.vue` — wire the identity
  context into persistence, dialog decisions, tracker initialization, and the
  lifecycle controller. Budget: about 90 changed lines.
- Modify `tests/onboarding-progress-analytics.unit.test.ts` — deterministic
  identity/event coverage and existing tracker assertions. Budget: about 100
  changed lines.
- Modify `tests/user-onboarding-progress.unit.test.ts` — persisted metadata
  parsing/building coverage. Budget: about 20 changed lines.
- Modify `tests/app-onboarding-progress-integration.unit.test.ts` — ordering and
  ownership contract plus component/controller integration coverage.
- Create `tests/onboarding-progress-persistence.unit.test.ts` — executable
  abort, conflict, queue, failure, and initialization behavior coverage.

The implementation creates only the persistence controller and its focused unit
test. The expected production total is about 275 changed lines, below the
500-line production ceiling.

### Task 1: Persist the existing attempt ID and latest run ID

**Files:**
- Modify: `tests/user-onboarding-progress.unit.test.ts`
- Modify: `src/utils/userOnboardingProgress.ts:14-47,108-218`

- [ ] **Step 1: Extend the existing parse/build test with telemetry metadata**

In the first parsing test, add these fields to the valid raw payload and expected
result:

```ts
onboarding_attempt_id: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
last_run_id: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
```

In the compact-payload test, pass and expect the camelCase builder inputs mapped
to their persisted snake_case names:

```ts
const progress = buildUserOnboardingProgress({
  status: 'in_progress',
  step: 'details',
  flow: 'pre_org',
  onboardingAttemptId: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
  lastRunId: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
  intent: 'builder',
  appName: '  Hello  ',
  appId: '',
  existingApp: true,
  existingAppSetup: 'import',
  storeUrl: 'https://apps.apple.com/app/id123',
  orgName: '  ',
  updatedAt: '2026-08-15T00:00:00.000Z',
})

expect(progress).toMatchObject({
  onboarding_attempt_id: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
  last_run_id: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
})
```

Add one narrow malformed-metadata assertion proving operational progress still
parses:

```ts
expect(parseUserOnboardingProgress({
  status: 'in_progress',
  step: 'details',
  flow: 'pre_org',
  onboarding_attempt_id: 'invalid',
  last_run_id: 'invalid',
  updated_at: '2026-08-15T00:00:00.000Z',
})).toMatchObject({
  status: 'in_progress',
  step: 'details',
  flow: 'pre_org',
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bunx vitest run tests/user-onboarding-progress.unit.test.ts
```

Expected: FAIL because `UserOnboardingProgressInput` does not accept
`onboardingAttemptId` or `lastRunId`, and parsed output omits both fields.

- [ ] **Step 3: Add the minimal persisted metadata model**

Add these two fields to `UserOnboardingProgress` after `completed_at`, and add
the camelCase pair to `UserOnboardingProgressInput` after `completedAt`:

```ts
onboarding_attempt_id?: string
last_run_id?: string

onboardingAttemptId?: string
lastRunId?: string
```

Add format validation beside the existing constants:

```ts
const onboardingAttemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const onboardingRunIdPattern = /^ir_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
```

Append this exact parsing logic to `applyOptionalUserOnboardingFields()` before
returning `progress`:

```ts
const onboardingAttemptId = optionalTrimmedString(raw.onboarding_attempt_id, 64)
if (onboardingAttemptId && onboardingAttemptIdPattern.test(onboardingAttemptId))
  progress.onboarding_attempt_id = onboardingAttemptId

const lastRunId = optionalTrimmedString(raw.last_run_id, 67)
if (lastRunId && onboardingRunIdPattern.test(lastRunId))
  progress.last_run_id = lastRunId
```

Append this builder logic before the completion timestamp handling:

```ts
if (input.onboardingAttemptId && onboardingAttemptIdPattern.test(input.onboardingAttemptId))
  progress.onboarding_attempt_id = input.onboardingAttemptId

if (input.lastRunId && onboardingRunIdPattern.test(input.lastRunId))
  progress.last_run_id = input.lastRunId
```

Do not add the fixed-size IDs to `OPTIONAL_STRING_KEYS`; free-text fields should
be reduced first if the payload approaches the existing byte cap.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
bunx vitest run tests/user-onboarding-progress.unit.test.ts
```

Expected: PASS with all existing size and Unicode tests unchanged.

- [ ] **Step 5: Commit the persistence model**

```bash
git add src/utils/userOnboardingProgress.ts tests/user-onboarding-progress.unit.test.ts
git commit -m "feat(onboarding): persist telemetry identity metadata"
```

### Task 2: Add a compact resume identity context and inject it into the tracker

**Files:**
- Modify: `tests/onboarding-progress-analytics.unit.test.ts`
- Modify: `src/utils/onboardingProgressAnalytics.ts:26-229`

- [ ] **Step 1: Write deterministic identity lifecycle tests**

Import the new helper and define stable IDs:

```ts
import {
  createOnboardingProgressTracker,
  createOnboardingTelemetryIdentity,
  ONBOARDING_ANALYTICS_VERSION,
} from '../src/utils/onboardingProgressAnalytics'

const ATTEMPT_A1 = '7e64f484-4171-47b6-86f7-0ef5d49e0ef8'
const ATTEMPT_A2 = '89c8aa2f-78df-4ee5-a78d-ef540f33aa43'
const RUN_R1 = 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276'
const RUN_R2_UUID = '9f6a0407-64f9-4696-b447-8dd976674b5c'
const RUN_R2 = `ir_${RUN_R2_UUID}`
```

Add one Continue test covering dialog ordering, identity switching, duplicate
guards, and persisted output:

```ts
it.concurrent('keeps the fresh attempt for the dialog then restores the saved attempt on Continue', () => {
  const capture = vi.fn()
  const ids = [ATTEMPT_A2, RUN_R2_UUID]
  const identity = createOnboardingTelemetryIdentity({
    capture,
    flow: 'pre_org',
    idFactory: () => ids.shift()!,
    supaHost: 'https://supabase.capgo.test',
  })

  identity.prepareResumeCandidate({
    onboardingAttemptId: ATTEMPT_A1,
    lastRunId: RUN_R1,
    savedStep: 'organization',
    steps,
  })
  identity.recordResumeDialogViewed()
  identity.recordResumeDialogViewed()
  identity.recordResumeContinued()
  identity.recordResumeContinued()

  expect(capture.mock.calls.map(call => call[0])).toEqual([
    'onboarding_resume_dialog_viewed',
    'onboarding_resume_continued',
  ])
  expect(capture.mock.calls[0]?.[2]).toMatchObject({
    onboarding_attempt_id: ATTEMPT_A2,
    onboarding_run_id: RUN_R2,
    resume_onboarding_attempt_id: ATTEMPT_A1,
    resumed_from_run_id: RUN_R1,
    saved_step: 'organization',
  })
  expect(capture.mock.calls[1]?.[2]).toMatchObject({
    initial_onboarding_attempt_id: ATTEMPT_A2,
    onboarding_attempt_id: ATTEMPT_A1,
    onboarding_run_id: RUN_R2,
  })
  expect(identity.getProgressMetadata()).toEqual({
    onboardingAttemptId: ATTEMPT_A1,
    lastRunId: RUN_R2,
  })
})
```

Add one Restart test:

```ts
it.concurrent('keeps the fresh attempt when Restart is selected', () => {
  const capture = vi.fn()
  const ids = [ATTEMPT_A2, RUN_R2_UUID]
  const identity = createOnboardingTelemetryIdentity({
    capture,
    flow: 'pre_org',
    idFactory: () => ids.shift()!,
    supaHost: 'https://supabase.capgo.test',
  })
  identity.prepareResumeCandidate({
    onboardingAttemptId: ATTEMPT_A1,
    lastRunId: RUN_R1,
    savedStep: 'organization',
    steps,
  })

  identity.recordResumeDialogViewed()
  identity.recordResumeRestarted()

  expect(capture.mock.calls.at(-1)?.[0]).toBe('onboarding_resume_restarted')
  expect(capture.mock.calls.at(-1)?.[2]).toMatchObject({
    onboarding_attempt_id: ATTEMPT_A2,
    onboarding_run_id: RUN_R2,
  })
  expect(identity.getProgressMetadata()).toEqual({
    onboardingAttemptId: ATTEMPT_A2,
    lastRunId: RUN_R2,
  })
})
```

Change existing tracker tests to supply stable IDs:

```ts
const trackerIdentity = {
  onboardingAttemptId: ATTEMPT_A1,
  onboardingRunId: RUN_R1,
}

const tracker = createOnboardingProgressTracker({
  ...trackerIdentity,
  capture,
  flow: 'pre_org',
  resumed: false,
  steps,
  supaHost: 'https://supabase.capgo.test',
})
```

Use `...trackerIdentity` in every existing tracker construction. Replace
`expect.any(String)` attempt assertions with `ATTEMPT_A1`, add
`onboarding_run_id: RUN_R1` to exact property objects, and add
`onboarding_run_id` to the allowed-key set.

Replace the existing “uses one unique attempt id for every event from a tracker
instance” test with this supplied-identity contract:

```ts
it.concurrent('uses the supplied attempt and run ids for every tracker event', () => {
  const capture = vi.fn()
  const tracker = createOnboardingProgressTracker({
    ...trackerIdentity,
    capture,
    flow: 'pre_org',
    resumed: false,
    steps,
    supaHost: 'https://supabase.capgo.test',
  })

  tracker.viewStep('intent')
  tracker.completeStep('intent', { nextStep: 'details' })

  expect(capture.mock.calls.every(call => (
    call[2]?.onboarding_attempt_id === ATTEMPT_A1
    && call[2]?.onboarding_run_id === RUN_R1
  ))).toBe(true)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bunx vitest run tests/onboarding-progress-analytics.unit.test.ts
```

Expected: FAIL because `createOnboardingTelemetryIdentity` and the two tracker
identity options do not exist.

- [ ] **Step 3: Implement the identity context**

Add these types beside `CaptureEvent`:

```ts
interface OnboardingResumeCandidate {
  lastRunId?: string
  onboardingAttemptId?: string
  savedStep: OnboardingAnalyticsStep
  steps: readonly OnboardingAnalyticsStep[]
}

interface CreateOnboardingTelemetryIdentityOptions {
  capture?: CaptureEvent
  flow: OnboardingAnalyticsFlow
  idFactory?: () => string
  supaHost: string
}
```

Add this helper before `CreateOnboardingProgressTrackerOptions`:

```ts
export function createOnboardingTelemetryIdentity(options: CreateOnboardingTelemetryIdentityOptions) {
  const capture = options.capture ?? pushEvent
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const initialAttemptId = idFactory()
  const runId = `ir_${idFactory()}`
  let activeAttemptId = initialAttemptId
  let candidate: OnboardingResumeCandidate | undefined
  let dialogViewed = false
  let decision: 'continue' | 'restart' | undefined

  function safelyCapture(name: string, properties: AnalyticsProperties) {
    try {
      capture(name, options.supaHost, properties)
    }
    catch {
      // Analytics must never interrupt onboarding.
    }
  }

  function candidateProperties(): AnalyticsProperties {
    if (!candidate)
      return {}
    const stepIndex = candidate.steps.indexOf(candidate.savedStep)
    return {
      flow: options.flow,
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      saved_step: candidate.savedStep,
      step_index: stepIndex,
      total_steps: candidate.steps.length,
      ...(candidate.onboardingAttemptId
        ? { resume_onboarding_attempt_id: candidate.onboardingAttemptId }
        : {}),
      ...(candidate.lastRunId ? { resumed_from_run_id: candidate.lastRunId } : {}),
    }
  }

  function currentProperties(): AnalyticsProperties {
    return {
      onboarding_attempt_id: activeAttemptId,
      onboarding_run_id: runId,
    }
  }

  return {
    get attemptId() { return activeAttemptId },
    get runId() { return runId },
    getProgressMetadata: () => ({
      onboardingAttemptId: activeAttemptId,
      lastRunId: runId,
    }),
    prepareResumeCandidate: (next: OnboardingResumeCandidate) => {
      candidate = next
    },
    recordResumeDialogViewed: () => {
      if (!candidate || dialogViewed)
        return
      dialogViewed = true
      safelyCapture('onboarding_resume_dialog_viewed', {
        ...candidateProperties(),
        ...currentProperties(),
      })
    },
    recordResumeContinued: () => {
      if (!candidate || decision)
        return
      decision = 'continue'
      const initial = activeAttemptId
      if (candidate.onboardingAttemptId)
        activeAttemptId = candidate.onboardingAttemptId
      safelyCapture('onboarding_resume_continued', {
        ...candidateProperties(),
        ...currentProperties(),
        ...(activeAttemptId !== initial
          ? { initial_onboarding_attempt_id: initial }
          : {}),
      })
    },
    recordResumeRestarted: () => {
      if (!candidate || decision)
        return
      decision = 'restart'
      safelyCapture('onboarding_resume_restarted', {
        ...candidateProperties(),
        ...currentProperties(),
      })
    },
  }
}
```

- [ ] **Step 4: Inject supplied identity into existing tracker properties**

Extend `CreateOnboardingProgressTrackerOptions`:

```ts
interface CreateOnboardingProgressTrackerOptions {
  capture?: CaptureEvent
  flow: OnboardingAnalyticsFlow
  now?: () => number
  onboardingAttemptId: string
  onboardingRunId: string
  resumed: boolean
  steps: readonly OnboardingAnalyticsStep[]
  supaHost: string
}
```

Delete `const onboardingAttemptId = crypto.randomUUID()` from
`createOnboardingProgressTracker()` and change its shared properties to:

```ts
return {
  flow: options.flow,
  onboarding_attempt_id: options.onboardingAttemptId,
  onboarding_run_id: options.onboardingRunId,
  onboarding_version: ONBOARDING_ANALYTICS_VERSION,
  resumed: options.resumed,
  step,
  step_index: stepIndex,
  total_steps: options.steps.length,
}
```

Do not change event names, completion timing, copy-event payloads, or details
debouncing.

- [ ] **Step 5: Run the focused analytics test**

Run:

```bash
bunx vitest run tests/onboarding-progress-analytics.unit.test.ts
```

Expected: PASS. Continue uses A1/R2 with A2 in
`initial_onboarding_attempt_id`; Restart remains A2/R2; all existing tracker
events carry the supplied attempt/run pair.

- [ ] **Step 6: Commit the analytics identity context**

```bash
git add src/utils/onboardingProgressAnalytics.ts tests/onboarding-progress-analytics.unit.test.ts
git commit -m "feat(onboarding): add resume telemetry identity context"
```

### Task 3: Wire resume decisions without emitting step views manually

**Files:**
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue:46-57,303-526,1382-1414`

- [ ] **Step 1: Add source-contract assertions for ownership and ordering**

Extend the initialization test with:

```ts
expect(onboardingSource).toContain('createOnboardingTelemetryIdentity')
expect(initializer).toContain('onboardingAttemptId: onboardingTelemetry.attemptId')
expect(initializer).toContain('onboardingRunId: onboardingTelemetry.runId')

const resumeDialog = sourceBetween(
  'async function maybeResumeSavedOnboarding()',
  'function whiteCardToggleButtonClass(',
)
expect(resumeDialog).toContain('onboardingTelemetry.prepareResumeCandidate({')
expect(resumeDialog).toContain('onboardingTelemetry.recordResumeDialogViewed()')
expect(resumeDialog).toContain('onboardingTelemetry.recordResumeContinued()')
expect(resumeDialog).toContain('onboardingTelemetry.recordResumeRestarted()')
expect(resumeDialog).not.toContain('.viewStep(')
```

Extend the persistence assertions with:

```ts
const snapshot = sourceBetween(
  'function snapshotOnboardingProgress(',
  'async function persistOnboardingProgress(',
)
expect(snapshot).toContain('const telemetry = onboardingTelemetry.getProgressMetadata()')
expect(snapshot).toContain('onboardingAttemptId: telemetry.onboardingAttemptId')
expect(snapshot).toContain('lastRunId: telemetry.lastRunId')
```

- [ ] **Step 2: Run the focused integration test and verify it fails**

Run:

```bash
bunx vitest run tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: FAIL because the component has not created or wired the identity
context.

- [ ] **Step 3: Create one identity context per component mount**

Add `createOnboardingTelemetryIdentity` to the existing analytics import and
create the context after local config is available:

```ts
import {
  createOnboardingDetailsFieldDebouncer,
  createOnboardingProgressTracker,
  createOnboardingTelemetryIdentity,
} from '~/utils/onboardingProgressAnalytics'

const onboardingTelemetry = createOnboardingTelemetryIdentity({
  flow: props.preOrg ? 'pre_org' : 'existing_org',
  supaHost: config.supaHost,
})
```

Supply the active identity when initializing the existing progress tracker:

```ts
progressTracker = createOnboardingProgressTracker({
  flow: props.preOrg ? 'pre_org' : 'existing_org',
  onboardingAttemptId: onboardingTelemetry.attemptId,
  onboardingRunId: onboardingTelemetry.runId,
  resumed,
  steps: trackedSteps,
  supaHost: config.supaHost,
})
```

Keep the existing `progressTracker.viewStep(flowStep.value)` call exactly where
it is.

- [ ] **Step 4: Persist the active pair in every existing progress snapshot**

At the start of `snapshotOnboardingProgress()`, read the identity metadata and
pass it to the existing builder:

```ts
function snapshotOnboardingProgress(status: UserOnboardingStatus = 'in_progress') {
  const flow = props.preOrg ? 'pre_org' : 'existing_org'
  const telemetry = onboardingTelemetry.getProgressMetadata()
  return buildUserOnboardingProgress({
    status,
    step: clampResumableOnboardingStep(flowStep.value, flow),
    flow,
    onboardingAttemptId: telemetry.onboardingAttemptId,
    lastRunId: telemetry.lastRunId,
    intent: selectedIntent.value,
    appName: appName.value,
    appId: generatedAppId.value,
    existingApp: existingApp.value,
    existingAppSetup: existingAppSetup.value,
    storeUrl: storeUrl.value,
    importedStoreAppId: importedStoreAppId.value,
    orgName: orgNameInput.value,
    estimatedUsersIndex: estimatedUsersIndex.value,
  })
}
```

Do not add another persistence call. The existing mount, transition, debounce,
logout, completion, and unmount writes will carry the pair automatically.

- [ ] **Step 5: Gate resume lifecycle events around the existing dialog**

After the existing prompt guard succeeds, prepare the candidate using the
clamped step that will actually be shown:

```ts
const resumableStep = clampResumableOnboardingStep(saved.step, flow)
onboardingTelemetry.prepareResumeCandidate({
  onboardingAttemptId: saved.onboarding_attempt_id,
  lastRunId: saved.last_run_id,
  savedStep: resumableStep,
  steps: appOnboardingSteps.value.map(step => step.id),
})
```

Insert the lifecycle call immediately after the existing
`dialogStore.openDialog(...)` call and before its existing dismissal wait:

```ts
onboardingTelemetry.recordResumeDialogViewed()
await dialogStore.onDialogDismiss()
```

Record one decision in each existing branch without calling `viewStep()`:

```ts
if (dialogStore.lastButtonRole === 'onboarding-resume-restart') {
  onboardingTelemetry.recordResumeRestarted()
  resetOnboardingForm()
  existingApp.value = true
  existingAppSetup.value = 'manual'
  return false
}

onboardingTelemetry.recordResumeContinued()
applyOnboardingProgress(saved)
return true
```

The existing `onMounted()` `finally` block remains responsible for calling
`initializeProgressTracking(resumedFlow)` once. Continue therefore emits one
restored-step view with A1/R2 and `resumed: true`; Restart emits one `intent`
view with A2/R2 and `resumed: false`.

- [ ] **Step 6: Run all three focused unit files**

Run:

```bash
bunx vitest run tests/onboarding-progress-analytics.unit.test.ts tests/user-onboarding-progress.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: PASS with no direct `viewStep()` call in either resume decision
branch.

- [ ] **Step 7: Commit component wiring**

```bash
git add src/components/dashboard/AppOnboardingFlow.vue tests/app-onboarding-progress-integration.unit.test.ts
git commit -m "feat(onboarding): connect resume telemetry identities"
```

### Task 4: Verify the small-PR contract

**Files:**
- Verify only; no planned modifications.

- [ ] **Step 1: Run repository lint before final validation**

Run:

```bash
bun lint
```

Expected: PASS with no ESLint or OXC errors.

- [ ] **Step 2: Run focused telemetry and persistence tests**

Run:

```bash
bunx vitest run tests/onboarding-progress-analytics.unit.test.ts tests/user-onboarding-progress.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run frontend type checking**

Run:

```bash
bun run typecheck:frontend
```

Expected: PASS with no Vue or TypeScript errors.

- [ ] **Step 4: Run the complete unit suite**

Run:

```bash
bun test:unit
```

Expected: PASS.

- [ ] **Step 5: Enforce the PR line budget**

Run:

```bash
git diff --numstat origin/main...HEAD | awk '{ added += $1; deleted += $2 } END { print added + deleted }'
```

Expected: a number below `500`. If it is `500` or higher, reduce duplicated test
setup or inline identity wiring; do not expand scope or remove required
behavioral assertions.

- [ ] **Step 6: Confirm the final diff contains only scoped files**

Run:

```bash
git diff --stat origin/main...HEAD
```

Expected: only the eight implementation/test files in the File Map, with no
admin-dashboard, PostHog query, generated type, migration, translation, or
Playwright changes.

Run:

```bash
git status --short
```

Expected: clean working tree.

### Task 5: Keep navigation telemetry complete after a transient persistence outage

**Files:**
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue:305-410`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue:1449-1475`

- [ ] **Step 1: Write the failing mount-gate regression test**

Replace the late-recovery assertions with a source-contract assertion that the
mount initializes only for a confirmed write or exhausted retryable failures:

```ts
expect(onboardingSource).not.toContain('pendingProgressTrackingResumed')
expectSourceOrder(mountedFlow, [
  `if (onboardingPersistResult === 'retryable_failure' && !onboardingFlowDisposed)`,
  'onboardingPersistResult = await persistOnboardingProgress()',
  `onboardingPersistResult === 'persisted'`,
  `onboardingPersistResult === 'retryable_failure'`,
  'initializeProgressTracking(resumedFlow)',
])
expect(mountedFlow).not.toContain(`onboardingPersistResult === 'skipped'`)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bunx vitest run tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: FAIL because the component still uses
`pendingProgressTrackingResumed` and late initialization.

- [ ] **Step 3: Replace late recovery with immediate retryable-failure tracking**

Remove `pendingProgressTrackingResumed` and the initialization side effect from
`persistOnboardingProgress()`, returning its serialized result directly:

```ts
persistChain = persistChain
  .then(() => {
    if (onboardingPersistenceBlocked && status !== 'completed')
      return 'skipped'
    return writeOnboardingProgress(status)
  })
  .catch((error) => {
    console.error('Failed to persist onboarding progress', error)
    return 'retryable_failure' as const
  })
return persistChain
```

After the two mount attempts, initialize for `persisted` or
`retryable_failure`, while continuing to exclude `skipped`, `conflict`, abort,
and disposal:

```ts
const shouldInitializeProgressTracking
  = onboardingPersistResult === 'persisted'
    || onboardingPersistResult === 'retryable_failure'

if (!onboardingMountAborted && shouldInitializeProgressTracking)
  initializeProgressTracking(resumedFlow)
```

- [ ] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
bunx vitest run tests/onboarding-progress-analytics.unit.test.ts tests/user-onboarding-progress.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: PASS with exactly one mount-owned first step view and no delayed
tracker initialization in `persistOnboardingProgress()`.

- [ ] **Step 5: Run lint and frontend type checking**

Run:

```bash
bun lint
bun run typecheck:frontend
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the correction**

```bash
git add src/components/dashboard/AppOnboardingFlow.vue tests/app-onboarding-progress-integration.unit.test.ts docs/superpowers/specs/2026-08-15-frontend-onboarding-resume-telemetry-identities-design.md docs/superpowers/plans/2026-08-15-frontend-onboarding-resume-telemetry-identities.md
git commit -m "fix(onboarding): preserve tracking during persistence outages"
```

### Task 6: Behavior-test the persistence lifecycle

**Files:**
- Create: `src/utils/onboardingProgressPersistence.ts`
- Create: `tests/onboarding-progress-persistence.unit.test.ts`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`
- Modify: `tests/onboarding-progress-analytics.unit.test.ts`

- [ ] **Step 1: Write failing behavioral persistence tests**

Define the wished-for controller API and use deferred promises to cover:

```ts
const controller = createOnboardingProgressPersistence({ write })

const first = controller.persist()
const queued = controller.persist()
controller.abort()
resolveFirst('persisted')

expect(await first).toBe('persisted')
expect(await queued).toBe('skipped')
expect(write).toHaveBeenCalledTimes(1)
```

Add separate tests proving a conflict blocks queued and later non-terminal
writes, an explicit `completed` write bypasses only the conflict barrier, a
write exception returns `retryable_failure` without poisoning the queue, and
`shouldInitializeOnboardingProgressTracking()` accepts only `persisted` or
`retryable_failure` on a live non-aborted mount.

- [ ] **Step 2: Verify the new unit test is RED**

Run:

```bash
bunx vitest run tests/onboarding-progress-persistence.unit.test.ts
```

Expected: FAIL because `onboardingProgressPersistence.ts` does not exist.

- [ ] **Step 3: Implement the minimal persistence controller**

Create a typed controller that owns one promise chain plus abort and conflict
state. It accepts the existing component writer and optional error callback,
checks barriers both before enqueue and inside the serialized callback, marks
conflicts from the writer result, and exposes `persist`, `abort`, `isAborted`,
and `isBlocked`. Keep the initialization decision as a pure exported helper.

Do not move Supabase access, snapshots, retries, UI state, or tracker creation
into the controller.

- [ ] **Step 4: Wire the component to the tested controller**

Replace the component-local promise chain and abort/conflict booleans with the
controller. Keep the existing `persistOnboardingProgress()` wrapper and writer,
but let the controller own conflict activation and all barrier checks. Use the
pure initialization helper in the mount finalizer.

Keep source-contract tests only for integration ownership: one mount
initializer, no resume-branch view calls, controller guards used by scheduling
and unmount, and no manual watcher. Move race semantics to the executable unit
test.

- [ ] **Step 5: Add identity capture-failure coverage**

In `tests/onboarding-progress-analytics.unit.test.ts`, add a local identity
helper fixture whose `capture` dependency throws. Call dialog, Continue, and
Restart recording methods and assert none throws; then assert the active
attempt/run metadata remains valid and usable. No additional helper file is
created.

- [ ] **Step 6: Run focused and repository verification**

Run:

```bash
bunx vitest run tests/onboarding-progress-persistence.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts tests/user-onboarding-progress.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
bun lint
bun typecheck
bun test:unit
git diff --check origin/main...HEAD
```

Expected: all commands PASS and the production changed-line count remains below
`500` with `codedb.snapshot` excluded.

- [ ] **Step 7: Commit the behavioral coverage**

```bash
git add src/utils/onboardingProgressPersistence.ts src/components/dashboard/AppOnboardingFlow.vue tests/onboarding-progress-persistence.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts docs/superpowers/specs/2026-08-15-frontend-onboarding-resume-telemetry-identities-design.md docs/superpowers/plans/2026-08-15-frontend-onboarding-resume-telemetry-identities.md
git commit -m "test(onboarding): exercise persistence lifecycle"
```
