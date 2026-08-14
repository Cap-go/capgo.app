# Onboarding Copy Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always include the API key in copied AI onboarding instructions and record successful AI/CLI copy actions in the correct PostHog and Bento destinations without leaking sensitive content or losing onboarding-session correlation.

**Architecture:** The existing onboarding progress tracker will own browser PostHog capture and return its safe `onboarding_attempt_id` context. `AppOnboardingFlow.vue` will emit events only after clipboard success, sending the AI-copy event through `/private/events` for Bento in addition to direct browser PostHog. The backend will recognize that exact event, construct a server-owned Bento payload, and use an internal provider option to skip duplicate server-side PostHog capture.

**Tech Stack:** Vue 3 Composition API, TypeScript, PostHog browser SDK, Hono, Supabase tracking utilities, Bento, Vitest, Bun.

---

## Task 1: Add safe onboarding copy-event context

**Files:**
- Modify: `src/utils/onboardingProgressAnalytics.ts`
- Modify: `tests/onboarding-progress-analytics.unit.test.ts`

- [ ] **Step 1: Write the failing tracker test**

Add a test that initializes the tracker, views `setup`, calls the new copy-event
method, and verifies browser capture plus returned properties share the same
attempt ID:

```ts
it('captures copy events with the active onboarding attempt context', () => {
  const capture = vi.fn()
  const tracker = createOnboardingProgressTracker({
    capture,
    flow: 'pre_org',
    resumed: true,
    steps: ['intent', 'details', 'organization', 'setup'],
    supaHost: 'https://api.capgo.app',
  })
  tracker.viewStep('setup')
  capture.mockClear()

  const properties = tracker.trackCopyEvent('onboarding_ai_instructions_copied', {
    app_id: 'com.example.app',
    existing_app: true,
    intent: 'ota',
    org_id: 'org-id',
    setup_command: 'ota',
  })

  expect(capture).toHaveBeenCalledWith(
    'onboarding_ai_instructions_copied',
    'https://api.capgo.app',
    expect.objectContaining({
      app_id: 'com.example.app',
      existing_app: true,
      flow: 'pre_org',
      intent: 'ota',
      onboarding_attempt_id: expect.any(String),
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      org_id: 'org-id',
      resumed: true,
      setup_command: 'ota',
      step: 'setup',
    }),
  )
  expect(properties).toEqual(capture.mock.calls[0]?.[2])
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun test tests/onboarding-progress-analytics.unit.test.ts
```

Expected: FAIL because `trackCopyEvent` does not exist.

- [ ] **Step 3: Implement the typed copy-event method**

In `src/utils/onboardingProgressAnalytics.ts`, add narrow event/context types and
return the captured safe properties:

```ts
export type OnboardingCopyEvent
  = 'onboarding_ai_instructions_copied'
    | 'onboarding_cli_command_copied'

export interface OnboardingCopyEventProperties {
  app_id?: string
  existing_app?: boolean
  intent?: OnboardingIntent
  org_id?: string
  setup_command: 'builder' | 'ota'
}

function trackCopyEvent(name: OnboardingCopyEvent, details: OnboardingCopyEventProperties) {
  if (!activeStep)
    return null

  const properties = sharedProperties(activeStep)
  if (!properties)
    return null

  const eventProperties: AnalyticsProperties = {
    ...properties,
    setup_command: details.setup_command,
  }
  if (details.app_id)
    eventProperties.app_id = details.app_id
  if (details.existing_app !== undefined)
    eventProperties.existing_app = details.existing_app
  if (details.intent)
    eventProperties.intent = details.intent
  if (details.org_id)
    eventProperties.org_id = details.org_id
  safelyCapture(name, eventProperties)
  return eventProperties
}
```

Remove `null` from the private `AnalyticsPrimitive` union because these event
builders omit unavailable properties rather than serializing null. This keeps
the returned event context assignable to the frontend tracking helper's `Tags`
type without a cast.

Expose `trackCopyEvent` in the tracker's returned object. Do not accept commands,
prompts, keys, names, emails, URLs, or arbitrary property records.

- [ ] **Step 4: Run the focused tracker tests**

Run:

```bash
bun test tests/onboarding-progress-analytics.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the tracker change**

```bash
git add src/utils/onboardingProgressAnalytics.ts tests/onboarding-progress-analytics.unit.test.ts
git commit -m "feat(analytics): add onboarding copy event context"
```

## Task 2: Remove the dialog and track successful frontend copies

**Files:**
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Modify: `src/services/tracking.ts`
- Modify: `messages/en.json`
- Modify: `messages/en.context.json`
- Modify: `tests/app-onboarding-apikey-loading.unit.test.ts`

- [ ] **Step 1: Replace the dialog test with failing direct-copy assertions**

Update the final test in `tests/app-onboarding-apikey-loading.unit.test.ts` to
assert the direct behavior:

```ts
it.concurrent('always includes the API key and tracks successful copy actions', () => {
  const copyHandlerStart = onboardingSource.indexOf('async function copyAiInstructions()')
  const copyHandlerEnd = onboardingSource.indexOf('function goToInstallStep()', copyHandlerStart)
  const copyHandler = onboardingSource.slice(copyHandlerStart, copyHandlerEnd)

  expect(copyHandler).toContain('await loadApiKey()')
  expect(copyHandler).toContain('if (!apiKey.value)')
  expect(copyHandler).toContain('await copyText(createAiHelpPrompt())')
  expect(copyHandler).toContain("trackSuccessfulCopy('onboarding_ai_instructions_copied')")
  expect(copyHandler).not.toContain('dialogStore.openDialog({')
  expect(copyHandler).not.toContain('redactedCliCommand')
  expect(onboardingSource).toContain("trackSuccessfulCopy('onboarding_cli_command_copied')")
})
```

Update the English-copy assertions so they require unconditional with-key
guidance and verify the four dialog keys plus the without-key guidance are gone.

- [ ] **Step 2: Run the focused onboarding test and verify it fails**

Run:

```bash
bun test tests/app-onboarding-apikey-loading.unit.test.ts
```

Expected: FAIL because the dialog and redacted branch still exist.

- [ ] **Step 3: Allow safe backend event-only properties in the frontend helper**

Extend `TrackOptions` in `src/services/tracking.ts` with the already-supported
backend field:

```ts
  nonPersonTags?: Tags
```

This keeps volatile onboarding context out of PostHog person properties if a
future backend provider records it. Do not add provider-selection fields to the
client contract.

- [ ] **Step 4: Implement success-aware clipboard handling and copy tracking**

In `AppOnboardingFlow.vue`:

1. Make `copyText` return `true` after `writeText` succeeds and `false` after the
   fallback dialog is dismissed.
2. Delete `redactedCliCommand`.
3. Change `createAiHelpPrompt` to take no command argument and always use
   `cliCommand.value` with the with-key guidance.
4. Add a `trackSuccessfulCopy` helper that calls
   `progressTracker?.trackCopyEvent(...)` with only safe values:

```ts
function trackSuccessfulCopy(event: OnboardingCopyEvent) {
  const orgId = currentOrg.value?.gid
  const appId = createdApp.value?.app_id || generatedAppId.value || undefined
  const properties = progressTracker?.trackCopyEvent(event, {
    ...(appId ? { app_id: appId } : {}),
    ...(existingApp.value !== null ? { existing_app: existingApp.value } : {}),
    ...(selectedIntent.value ? { intent: selectedIntent.value } : {}),
    ...(orgId ? { org_id: orgId } : {}),
    setup_command: usesBuilderSetupCommand.value ? 'builder' : 'ota',
  })

  if (event !== 'onboarding_ai_instructions_copied' || !properties || !orgId || !appId)
    return

  void sendEvent({
    channel: 'onboarding',
    event,
    icon: '🤖',
    nonPersonTags: properties,
    notify: false,
    org_id: orgId,
    tags: { app_id: appId },
    tracking_version: 2,
  }).catch(() => {})
}
```

Keep `app_id` in `tags` because the backend's existing authorization path reads
it there. Put the full safe event context in `nonPersonTags` so it remains event
metadata, not PostHog person state.

1. Track `onboarding_cli_command_copied` only after `copyText(cliCommand.value)`
   returns `true`.
2. In `copyAiInstructions`, return immediately after key-loading failure or an
   empty key, copy `createAiHelpPrompt()` directly, and track
   `onboarding_ai_instructions_copied` only after success.

- [ ] **Step 5: Remove obsolete translations**

Delete these keys from both `messages/en.json` and `messages/en.context.json`:

```text
app-onboarding-ai-help-copy-description
app-onboarding-ai-help-copy-title
app-onboarding-ai-help-copy-with-key
app-onboarding-ai-help-copy-without-key
```

Delete `app-onboarding-ai-help-without-key`. Keep
`app-onboarding-ai-help-with-key` as the unconditional prompt guidance.

- [ ] **Step 6: Run the focused frontend tests**

Run:

```bash
bun test tests/app-onboarding-apikey-loading.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the frontend behavior**

```bash
git add src/components/dashboard/AppOnboardingFlow.vue src/services/tracking.ts messages/en.json messages/en.context.json tests/app-onboarding-apikey-loading.unit.test.ts
git commit -m "feat(onboarding): copy AI instructions with API key"
```

## Task 3: Support internal PostHog provider suppression

**Files:**
- Modify: `supabase/functions/_backend/utils/tracking.ts`
- Modify: `tests/tracking.unit.test.ts`

- [ ] **Step 1: Write the failing provider-selection test**

Add a test proving `posthog: false` skips only PostHog:

```ts
it('can skip PostHog while preserving LogSnag and Bento delivery', async () => {
  const { sendEventToTracking } = await import('../supabase/functions/_backend/utils/tracking.ts')

  await sendEventToTracking(createContext(), {
    bento: {
      data: { app_id: 'com.example.app' },
      event: 'app:ai_instructions_copied',
      preferenceKey: 'onboarding',
      uniqId: 'app:ai_instructions_copied:com.example.app:attempt-id',
    },
    channel: 'onboarding',
    event: 'onboarding_ai_instructions_copied',
    notify: false,
    sentToBento: true,
    user_id: 'org-id',
  }, { background: false, posthog: false })

  expect(logsnagTrackMock).toHaveBeenCalledOnce()
  expect(posthogMock).not.toHaveBeenCalled()
  expect(notifToOrgMembersMock).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Run the tracking test and verify it fails**

Run:

```bash
bun test tests/tracking.unit.test.ts
```

Expected: FAIL because `SendEventToTrackingOptions` has no `posthog` option and
the provider still runs.

- [ ] **Step 3: Implement the internal option**

Add the option:

```ts
export interface SendEventToTrackingOptions {
  background?: boolean
  ip?: string
  posthog?: boolean
  strict?: boolean
}
```

Build the tracking task list with LogSnag always present and PostHog added only
when `options.posthog !== false`. Do not change Bento execution or defaults.

- [ ] **Step 4: Run the focused tracking test**

Run:

```bash
bun test tests/tracking.unit.test.ts
```

Expected: PASS, including all existing provider tests.

- [ ] **Step 5: Commit provider selection**

```bash
git add supabase/functions/_backend/utils/tracking.ts tests/tracking.unit.test.ts
git commit -m "feat(tracking): support internal PostHog suppression"
```

## Task 4: Allowlist AI-copy forwarding to Bento

**Files:**
- Create: `supabase/functions/_backend/utils/onboarding_copy_tracking.ts`
- Create: `tests/onboarding-copy-tracking.unit.test.ts`
- Modify: `supabase/functions/_backend/private/events.ts`
- Modify: `tests/events.test.ts`

- [ ] **Step 1: Write failing pure Bento-mapping tests**

Create `tests/onboarding-copy-tracking.unit.test.ts` with tests that require the
exact event, verified org/app IDs, and a non-empty onboarding attempt ID:

```ts
import { describe, expect, it } from 'vitest'
import {
  AI_INSTRUCTIONS_COPIED_EVENT,
  buildAiInstructionsCopiedBentoEvent,
  isFrontendPosthogCapturedEvent,
} from '../supabase/functions/_backend/utils/onboarding_copy_tracking.ts'

describe('onboarding copy tracking', () => {
  it('builds a per-attempt Bento event for the allowlisted AI copy', () => {
    const attemptId = '7e64f484-4171-47b6-86f7-0ef5d49e0ef8'
    expect(buildAiInstructionsCopiedBentoEvent({
      appId: 'com.example.app',
      event: AI_INSTRUCTIONS_COPIED_EVENT,
      nonPersonTags: {
        flow: 'pre_org',
        onboarding_attempt_id: attemptId,
        onboarding_version: 2,
        resumed: false,
        setup_command: 'ota',
      },
      orgId: 'org-id',
    })).toEqual(expect.objectContaining({
      event: 'app:ai_instructions_copied',
      once: true,
      preferenceKey: 'onboarding',
      uniqId: `app:ai_instructions_copied:com.example.app:${attemptId}`,
    }))
  })

  it('rejects arbitrary or incomplete events', () => {
    expect(buildAiInstructionsCopiedBentoEvent({
      appId: 'com.example.app',
      event: 'arbitrary_event',
      nonPersonTags: { onboarding_attempt_id: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8' },
      orgId: 'org-id',
    })).toBeUndefined()
    expect(buildAiInstructionsCopiedBentoEvent({
      appId: 'com.example.app',
      event: AI_INSTRUCTIONS_COPIED_EVENT,
      nonPersonTags: {},
      orgId: 'org-id',
    })).toBeUndefined()
    expect(isFrontendPosthogCapturedEvent('arbitrary_event')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
bun test tests/onboarding-copy-tracking.unit.test.ts
```

Expected: FAIL because the utility does not exist.

- [ ] **Step 3: Implement the pure allowlist and Bento builder**

Create the backend utility with the exact constant, safe property selection, and
`once: true` uniqueness:

```ts
import type { BentoTrackingPayload } from './tracking.ts'

export const AI_INSTRUCTIONS_COPIED_EVENT = 'onboarding_ai_instructions_copied'

interface AiInstructionsCopiedInput {
  appId?: string
  event: string
  nonPersonTags?: Record<string, string | number | boolean>
  orgId?: string
}

const onboardingAttemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isFrontendPosthogCapturedEvent(event: string) {
  return event === AI_INSTRUCTIONS_COPIED_EVENT
}

export function buildAiInstructionsCopiedBentoEvent(input: AiInstructionsCopiedInput): BentoTrackingPayload | undefined {
  const attemptId = input.nonPersonTags?.onboarding_attempt_id
  if (!isFrontendPosthogCapturedEvent(input.event)
    || !input.orgId
    || !input.appId
    || typeof attemptId !== 'string'
    || !onboardingAttemptIdPattern.test(attemptId)) {
    return undefined
  }

  const context = input.nonPersonTags ?? {}
  return {
    data: {
      app_id: input.appId,
      onboarding_attempt_id: attemptId,
      org_id: input.orgId,
      ...(typeof context.existing_app === 'boolean' ? { existing_app: context.existing_app } : {}),
      ...(context.flow === 'pre_org' || context.flow === 'existing_org' ? { flow: context.flow } : {}),
      ...(context.intent === 'ota' || context.intent === 'builder' || context.intent === 'both' || context.intent === 'exploring' ? { intent: context.intent } : {}),
      ...(typeof context.onboarding_version === 'number' ? { onboarding_version: context.onboarding_version } : {}),
      ...(typeof context.resumed === 'boolean' ? { resumed: context.resumed } : {}),
      ...(context.setup_command === 'builder' || context.setup_command === 'ota' ? { setup_command: context.setup_command } : {}),
    },
    event: 'app:ai_instructions_copied',
    once: true,
    preferenceKey: 'onboarding',
    uniqId: `app:ai_instructions_copied:${input.appId}:${attemptId}`,
  }
}
```

- [ ] **Step 4: Wire the builder into `/private/events`**

Import the utility, build `aiInstructionsCopiedBentoEvent` from the verified
organization/app IDs plus `trackedBody.nonPersonTags`, append it to the existing
Bento selection, and call the dispatcher with an internal option:

```ts
const aiInstructionsCopiedBentoEvent = buildAiInstructionsCopiedBentoEvent({
  appId,
  event: trackedBody.event,
  nonPersonTags: body.nonPersonTags,
  orgId: onboardingOrgId,
})
const bentoEvent = onboardingBentoEvent
  ?? builderBentoEvent
  ?? bundleIncompatibleBentoEvent
  ?? aiInstructionsCopiedBentoEvent

await sendEventToTracking(c, addAuthenticatedApiKeyIdToTrackingPayload({
  ...trackedBody,
  bento: bentoEvent,
  sentToBento: Boolean(bentoEvent),
  groups: verifiedOrgId ? { organization: verifiedOrgId } : undefined,
}, apikeyId), {
  posthog: !isFrontendPosthogCapturedEvent(trackedBody.event),
})
```

The route—not the request body—owns the provider decision.

- [ ] **Step 5: Add an authenticated endpoint regression case**

In `tests/events.test.ts`, add a tracking-v2 request using the test user's own
app/org, the exact event, `tags.app_id`, and
`nonPersonTags.onboarding_attempt_id`. Assert HTTP 200 and `{ status: 'ok' }`.
This proves the existing permission path accepts the new frontend payload.

- [ ] **Step 6: Run focused backend tests**

Run:

```bash
bun test tests/onboarding-copy-tracking.unit.test.ts tests/tracking.unit.test.ts
```

Expected: PASS.

If local Supabase is running, also run:

```bash
bun test tests/events.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the Bento allowlist**

```bash
git add supabase/functions/_backend/utils/onboarding_copy_tracking.ts supabase/functions/_backend/private/events.ts tests/onboarding-copy-tracking.unit.test.ts tests/events.test.ts
git commit -m "feat(onboarding): forward AI copy event to Bento"
```

## Task 5: Verify the complete change and publish the PR

**Files:**
- Verify: all files changed in Tasks 1-4
- Preserve: `codedb.snapshot`
- Preserve: unrelated generated changes in `src/components.d.ts`

- [ ] **Step 1: Run formatting and lint**

Run:

```bash
bun lint
bun lint:backend
```

Expected: both commands exit 0.

- [ ] **Step 2: Run focused and full unit tests**

Run:

```bash
bun test tests/app-onboarding-apikey-loading.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts tests/onboarding-copy-tracking.unit.test.ts tests/tracking.unit.test.ts
bun test:unit
```

Expected: all tests pass.

- [ ] **Step 3: Run type checking and production build**

Run:

```bash
bun typecheck
bun build
```

Expected: both commands exit 0.

- [ ] **Step 4: Verify the live production frontend**

Using the already-running `bun run serve:prod-no-cors` server at
`http://127.0.0.1:5175/`, confirm:

- **Copy AI instructions** writes immediately without opening the choice dialog;
- copied instructions contain the real API-key command;
- the existing clipboard success toast appears;
- the CLI-command copy still works;
- no regression appears in setup-step layout or navigation.

- [ ] **Step 5: Clean generated-only changes and inspect the diff**

Remove only server/build-generated additions from `src/components.d.ts` with an
explicit patch. Do not modify or stage `codedb.snapshot`. Run:

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
```

Expected: only intentional implementation, tests, and design/plan files remain;
`git diff --check` exits 0.

- [ ] **Step 6: Run the mandatory PR-ready workflow**

Load and follow `.agents/skills/pr-ready/SKILL.md`. Resolve all relevant local
and remote failures, push the branch, update the PR title/body to describe the
behavior and analytics contract, and observe stable green twice at least five
minutes apart before handing off.
