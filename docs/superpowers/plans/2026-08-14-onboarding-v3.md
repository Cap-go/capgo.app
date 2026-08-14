# Frontend Onboarding v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unified frontend onboarding v2 with a small v3 update that adds organization website import, reuses the existing organization invitation panel for Maker/Team/Enterprise, and exposes the existing technical-teammate invitation on CLI setup for every plan.

**Architecture:** Keep `AppOnboardingFlow.vue` as the only orchestrator and add a boolean Step 3 invitation substate rather than another route, persisted state, or version fork. Extract only the two UI blocks that now have two real consumers; reuse `private/website_preview`, `uploadOrgLogoFile`, and `InviteTeammateModal` directly. Organization and app creation remain the existing sequential operations and both finish before invitations appear.

**Tech Stack:** Vue 3 Composition API, TypeScript, Pinia, vue-i18n, Tailwind/DaisyUI, Vitest, Playwright, Supabase client, existing Capgo API client.

---

## Simplicity and diff budget

Target **600–900 changed lines including tests and deleted/moved markup**. Stop and reassess before 1,200 changed lines; do not exceed 2,000 without explicit user approval.

Keep these constraints throughout implementation:

- One onboarding orchestrator; do not create `AppOnboardingFlowV3.vue`.
- No account-date gate or feature-flag framework.
- No schema, migration, metadata, storage bucket, or onboarding-completion marker.
- No refresh recovery or durable draft work.
- No new invitation API or role picker.
- No new logo upload abstraction; call the existing `uploadOrgLogoFile` helper.
- No broad translation-key rename from `v2` to `v3`.
- No unrelated refactor of the 1,800-line onboarding component.
- Use the existing registration Playwright test instead of building a new fixture suite.

## Prerequisite

The implementation branch must contain merged logo-upload fix `cba954dc2` from PR #3052.

- [ ] **Verify the merged prerequisite is present**

Run:

```bash
git merge-base --is-ancestor cba954dc2 HEAD
```

Expected: exit code `0`. If it is not present, update the branch from the latest `origin/main` before editing; do not duplicate that fix in this feature.

## File map

**Create**

- `src/components/dashboard/OrganizationOnboardingInvite.vue` — extracted full organization invitation panel; owns modal and local sent-invite display, emits continuation.
- `src/components/dashboard/TechnicalTeammateInviteCard.vue` — extracted CLI-side technical invitation card; owns modal, emits success.
- `tests/onboarding-invite-components.unit.test.ts` — narrow source-contract coverage for both extractions and analytics props.

**Rename**

- `tests/app-onboarding-v2.unit.test.ts` → `tests/app-onboarding-v3.unit.test.ts` — preserve existing app-detail assertions and add v3 organization assertions.

**Modify**

- `src/components/dashboard/AppOnboardingFlow.vue` — website-import UI/state, plan branch, shared panels, v3 interaction tracking.
- `src/pages/onboarding/organization.vue` — replace inline invitation markup with the shared panel only.
- `src/components/dashboard/StepsApp.vue` — replace repeated technical-invite markup with the shared card only.
- `src/components/dashboard/InviteTeammateModal.vue` — accept analytics channel/version props while keeping v2 defaults.
- `src/utils/onboardingProgressAnalytics.ts` — report v3 and support small step-scoped interaction events.
- `tests/onboarding-progress-analytics.unit.test.ts` — assert v3 and interaction context.
- `tests/app-onboarding-progress-integration.unit.test.ts` — assert Step 3 is completed only when Maker+ invitation continues.
- `playwright/e2e/register.spec.ts` — extend the current first-time onboarding happy path to Maker invitation and universal technical invitation.
- `messages/en.json` — make existing technical-delegation copy accurate whether or not the app already exists.

**Do not modify**

- Supabase schemas or migrations.
- `src/utils/onboardingRedirect.ts`.
- Backend website-preview or organization APIs.
- The merged PR #3052 test except for resolving an import mock if extraction makes that mechanically necessary.

---

### Task 1: Version the unified tracker and invitation telemetry as v3

**Files:**

- Modify: `src/utils/onboardingProgressAnalytics.ts:3-150`
- Modify: `src/components/dashboard/InviteTeammateModal.vue:13-26,170-186`
- Modify: `tests/onboarding-progress-analytics.unit.test.ts:1-130`
- Create: `tests/onboarding-invite-components.unit.test.ts`

- [ ] **Step 1: Write failing tests for v3 progress and caller-provided invitation telemetry**

In `tests/onboarding-progress-analytics.unit.test.ts`, change the version assertion and add one interaction assertion:

```ts
it.concurrent('reports unified onboarding as v3', () => {
  expect(ONBOARDING_ANALYTICS_VERSION).toBe(3)
})

it.concurrent('associates organization interactions with the active attempt', () => {
  const capture = vi.fn()
  const tracker = createOnboardingProgressTracker({
    capture,
    flow: 'pre_org',
    resumed: false,
    steps,
    supaHost: 'https://supabase.capgo.test',
  })

  tracker.trackStepEvent('onboarding_organization_import_opened', 'organization')

  expect(capture).toHaveBeenCalledWith(
    'onboarding_organization_import_opened',
    'https://supabase.capgo.test',
    expect.objectContaining({
      flow: 'pre_org',
      onboarding_attempt_id: expect.any(String),
      onboarding_version: 3,
      step: 'organization',
    }),
  )
})
```

Replace every remaining explicit `onboarding_version: 2` expectation in this test with `onboarding_version: 3` or `ONBOARDING_ANALYTICS_VERSION`; do not leave a mixed v2/v3 expectation in the same tracker suite.

Create `tests/onboarding-invite-components.unit.test.ts` with the initial modal contract:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modalSource = readFileSync(new URL('../src/components/dashboard/InviteTeammateModal.vue', import.meta.url), 'utf8')

describe('onboarding invite analytics context', () => {
  it.concurrent('keeps v2 defaults while allowing v3 callers', () => {
    expect(modalSource).toContain('analyticsChannel?: string')
    expect(modalSource).toContain('trackingVersion?: number')
    expect(modalSource).toContain("analyticsChannel: 'onboarding-v2'")
    expect(modalSource).toContain('trackingVersion: 2')
    expect(modalSource).toContain('channel: props.analyticsChannel')
    expect(modalSource).toContain('tracking_version: props.trackingVersion')
    expect(modalSource).toContain("existingUserInviteRole = 'org_admin'")
    expect(modalSource).toContain("newUserInviteRole = 'org_admin'")
  })
})
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
bunx vitest run tests/onboarding-progress-analytics.unit.test.ts tests/onboarding-invite-components.unit.test.ts
```

Expected: failures because the version remains `2`, `trackStepEvent` does not exist, and the modal props are absent.

- [ ] **Step 3: Add a narrow interaction API and bump the unified version**

In `src/utils/onboardingProgressAnalytics.ts`, make these exact additions:

```ts
export const ONBOARDING_ANALYTICS_VERSION = 3

export type OnboardingInteractionEvent
  = | 'onboarding_organization_import_opened'
    | 'onboarding_organization_import_submitted'
    | 'onboarding_organization_import_succeeded'
    | 'onboarding_organization_import_failed'
    | 'onboarding_organization_invite_viewed'
    | 'onboarding_organization_invite_opened'
    | 'onboarding_organization_invite_succeeded'
    | 'onboarding_organization_invite_continued'
    | 'onboarding_technical_invite_opened'
    | 'onboarding_technical_invite_succeeded'

export interface OnboardingInteractionProperties {
  invitation_count?: number
}
```

Inside `createOnboardingProgressTracker`, add this method using the existing `sharedProperties` and `safelyCapture` helpers:

```ts
function trackStepEvent(
  name: OnboardingInteractionEvent,
  step: OnboardingAnalyticsStep,
  details: OnboardingInteractionProperties = {},
) {
  const properties = sharedProperties(step)
  if (!properties)
    return

  safelyCapture(name, { ...properties, ...details })
}
```

Return it with the existing methods:

```ts
return {
  completeStep,
  trackDetailsEvent,
  trackStepEvent,
  viewStep,
}
```

- [ ] **Step 4: Let shared modal callers select their analytics identity**

Change the `InviteTeammateModal.vue` props without changing existing callers:

```ts
const props = withDefaults(defineProps<{
  analyticsChannel?: string
  inviteKind?: 'generic' | 'technical'
  trackingVersion?: number
}>(), {
  analyticsChannel: 'onboarding-v2',
  inviteKind: 'generic',
  trackingVersion: 2,
})
```

Change only the hard-coded values in `completeInviteSuccess`:

```ts
sendEvent({
  channel: props.analyticsChannel,
  event: 'onboarding-step-invite-teammate',
  icon: '👥',
  org_id: orgId,
  tracking_version: props.trackingVersion,
  notify: false,
}).catch()
```

- [ ] **Step 5: Run the focused tests and commit**

Run:

```bash
bunx vitest run tests/onboarding-progress-analytics.unit.test.ts tests/onboarding-invite-components.unit.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/utils/onboardingProgressAnalytics.ts src/components/dashboard/InviteTeammateModal.vue tests/onboarding-progress-analytics.unit.test.ts tests/onboarding-invite-components.unit.test.ts
git commit -m "feat(onboarding): report unified flow as v3"
```

---

### Task 2: Extract the existing organization invitation panel

**Files:**

- Create: `src/components/dashboard/OrganizationOnboardingInvite.vue`
- Modify: `src/pages/onboarding/organization.vue:21-86,234-256,614-660,1174-1243`
- Modify: `tests/onboarding-invite-components.unit.test.ts`

- [ ] **Step 1: Add a failing extraction contract**

Append to `tests/onboarding-invite-components.unit.test.ts`:

```ts
const organizationPageSource = readFileSync(new URL('../src/pages/onboarding/organization.vue', import.meta.url), 'utf8')
const organizationInviteSource = readFileSync(new URL('../src/components/dashboard/OrganizationOnboardingInvite.vue', import.meta.url), 'utf8')

describe('shared organization onboarding invite panel', () => {
  it.concurrent('owns the existing invite UI while the page owns continuation', () => {
    expect(organizationPageSource).toContain("import OrganizationOnboardingInvite from '~/components/dashboard/OrganizationOnboardingInvite.vue'")
    expect(organizationPageSource).toContain('<OrganizationOnboardingInvite')
    expect(organizationPageSource).toContain('@continue="finishOnboarding"')
    expect(organizationInviteSource).toContain('data-test="onboarding-invite-users"')
    expect(organizationInviteSource).toContain('data-test="onboarding-finish"')
    expect(organizationInviteSource).toContain('<InviteTeammateModal')
    expect(organizationInviteSource).toContain("emit('continue', sentInvites.value.length)")
  })
})
```

- [ ] **Step 2: Run the contract and confirm it fails**

Run:

```bash
bunx vitest run tests/onboarding-invite-components.unit.test.ts
```

Expected: failure because the shared component does not exist.

- [ ] **Step 3: Create the shared panel by moving the existing markup**

Create `src/components/dashboard/OrganizationOnboardingInvite.vue` with this public boundary and the existing panel markup/classes:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconBuilding from '~icons/lucide/building-2'
import IconLoader from '~icons/lucide/loader-2'
import IconUserPlus from '~icons/lucide/user-plus'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'
import { useOrganizationStore } from '~/stores/organization'

interface SentInvite {
  email: string
  firstName: string
  lastName: string
}

const props = withDefaults(defineProps<{
  analyticsChannel?: string
  continueLabel: string
  continuing?: boolean
  organizationId: string
  organizationName: string
  trackingVersion?: number
}>(), {
  analyticsChannel: 'onboarding-v2',
  continuing: false,
  trackingVersion: 2,
})

const emit = defineEmits<{
  continue: [invitationCount: number]
  inviteOpened: []
  inviteSucceeded: [invite: SentInvite]
}>()

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const inviteModalRef = ref<InstanceType<typeof InviteTeammateModal> | null>(null)
const sentInvites = ref<SentInvite[]>([])
const primaryButtonClass = 'border-primary-500 bg-primary-500 text-white hover:border-primary-500 hover:bg-primary-500/90 disabled:border-slate-300 disabled:bg-slate-300 disabled:text-white disabled:opacity-100 dark:border-primary-500/90 dark:bg-primary-500 dark:hover:border-primary-500 dark:hover:bg-primary-500/90 dark:disabled:border-white/15 dark:disabled:bg-slate-800 dark:disabled:text-slate-500'
const secondaryButtonClass = 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100 dark:border-white/20 dark:bg-slate-950/90 dark:text-slate-100 dark:hover:border-white/30 dark:hover:bg-slate-900 dark:disabled:border-white/15 dark:disabled:bg-slate-900 dark:disabled:text-slate-500'

function getInviteDisplayName(invite: SentInvite) {
  return [invite.firstName, invite.lastName].filter(Boolean).join(' ') || invite.email
}

function getInviteInitials(invite: SentInvite) {
  const initials = [invite.firstName, invite.lastName]
    .filter(Boolean)
    .map(value => value.charAt(0).toUpperCase())
    .join('')
  return initials || invite.email.charAt(0).toUpperCase()
}

function openInviteModal() {
  organizationStore.setCurrentOrganization(props.organizationId)
  emit('inviteOpened')
  inviteModalRef.value?.openDialog()
}

function onInviteSuccess(invite: SentInvite) {
  if (!sentInvites.value.some(existing => existing.email === invite.email))
    sentInvites.value.push(invite)
  emit('inviteSucceeded', invite)
}

function continueOnboarding() {
  emit('continue', sentInvites.value.length)
}
</script>

<template>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-white/15 dark:bg-slate-900/95">
    <div class="space-y-4">
      <div>
        <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
          {{ t('organization-onboarding-invite-title') }}
        </h2>
        <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('organization-onboarding-invite-subtitle') }}
        </p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
        <div class="flex items-start gap-4">
          <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-slate-800">
            <IconBuilding class="h-5 w-5" />
          </div>
          <div class="min-w-0">
            <div class="truncate text-base font-semibold text-slate-950 dark:text-white">
              {{ organizationName || t('organization-onboarding-org-placeholder') }}
            </div>
            <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
              {{ sentInvites.length > 0
                ? t('organization-onboarding-invite-success-state')
                : t('organization-onboarding-invite-empty-state') }}
            </p>
          </div>
        </div>

        <ul v-if="sentInvites.length > 0" class="mt-4 space-y-3">
          <li
            v-for="invite in sentInvites"
            :key="invite.email"
            class="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/15 dark:bg-slate-900/95"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-500 text-xs font-semibold text-white">
              {{ getInviteInitials(invite) }}
            </div>
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold text-slate-950 dark:text-white">
                {{ getInviteDisplayName(invite) }}
              </div>
              <div class="truncate text-xs text-slate-500 dark:text-slate-400">
                {{ invite.email }}
              </div>
            </div>
          </li>
        </ul>
      </div>

      <div class="flex flex-wrap gap-2">
        <button type="button" class="d-btn min-h-11" :class="primaryButtonClass" data-test="onboarding-invite-users" @click="openInviteModal">
          <IconUserPlus class="h-4 w-4" />
          {{ t('organization-onboarding-open-invite') }}
        </button>
        <button type="button" class="d-btn min-h-11" :class="secondaryButtonClass" data-test="onboarding-finish" :disabled="continuing" @click="continueOnboarding">
          <IconLoader v-if="continuing" class="h-4 w-4 animate-spin" />
          <template v-else>
            {{ continueLabel }}
            <IconArrowRight class="h-4 w-4" />
          </template>
        </button>
      </div>
    </div>
  </div>

  <InviteTeammateModal
    ref="inviteModalRef"
    :analytics-channel="analyticsChannel"
    :tracking-version="trackingVersion"
    @success="onInviteSuccess"
  />
</template>
```

The two class constants intentionally copy the current helpers once so both consumers keep the existing appearance without adding style props.

- [ ] **Step 4: Replace the page's inline panel with the shared component**

In `organization.vue`:

- Import `OrganizationOnboardingInvite`.
- Remove the local `SentInvite` interface, invitation modal ref, `sentInvites`, display-name/initial helpers, `onInviteSuccess`, and `openInviteModal`.
- Remove icon imports only used by the old inline panel.
- Replace the existing `step === 'invite'` block with:

```vue
<OrganizationOnboardingInvite
  v-else-if="step === 'invite'"
  :organization-id="activeOrgId"
  :organization-name="activeOrgName"
  :continue-label="appDraft ? t('organization-onboarding-finish-setup') : t('organization-onboarding-create-app')"
  :continuing="isSubmitting"
  @continue="finishOnboarding"
/>
```

- [ ] **Step 5: Run focused regression tests and commit**

Run:

```bash
bunx vitest run tests/onboarding-invite-components.unit.test.ts tests/organization-onboarding-logo-upload.unit.test.ts
```

Expected: all tests pass, including PR #3052's upload fallback test.

Commit:

```bash
git add src/components/dashboard/OrganizationOnboardingInvite.vue src/pages/onboarding/organization.vue tests/onboarding-invite-components.unit.test.ts
git commit -m "refactor(onboarding): share organization invite panel"
```

---

### Task 3: Extract the existing technical-teammate card

**Files:**

- Create: `src/components/dashboard/TechnicalTeammateInviteCard.vue`
- Modify: `src/components/dashboard/StepsApp.vue:9,64,127-145,463-535`
- Modify: `tests/onboarding-invite-components.unit.test.ts`

- [ ] **Step 1: Add a failing reuse contract**

Append:

```ts
const stepsAppSource = readFileSync(new URL('../src/components/dashboard/StepsApp.vue', import.meta.url), 'utf8')
const technicalInviteSource = readFileSync(new URL('../src/components/dashboard/TechnicalTeammateInviteCard.vue', import.meta.url), 'utf8')

describe('shared technical teammate invitation', () => {
  it.concurrent('reuses one card and preserves the technical modal', () => {
    expect(stepsAppSource).toContain("import TechnicalTeammateInviteCard from '~/components/dashboard/TechnicalTeammateInviteCard.vue'")
    expect(stepsAppSource).toContain('<TechnicalTeammateInviteCard')
    expect(stepsAppSource).toContain('@opened="onTechnicalInviteOpened"')
    expect(stepsAppSource).not.toContain('<!-- Invite Teammate Option -->')
    expect(technicalInviteSource).toContain('data-test="onboarding-technical-invite"')
    expect(technicalInviteSource).toContain('invite-kind="technical"')
    expect(technicalInviteSource).toContain("emit('success', invite)")
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
bunx vitest run tests/onboarding-invite-components.unit.test.ts
```

Expected: failure because the shared card does not exist.

- [ ] **Step 3: Create the card with the existing copy and modal**

Create `src/components/dashboard/TechnicalTeammateInviteCard.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'

interface InviteSuccessPayload {
  email: string
  firstName: string
  lastName: string
}

const props = withDefaults(defineProps<{
  analyticsChannel?: string
  trackingVersion?: number
}>(), {
  analyticsChannel: 'onboarding-v2',
  trackingVersion: 2,
})

const emit = defineEmits<{
  opened: []
  success: [invite: InviteSuccessPayload]
}>()

const { t } = useI18n()
const inviteModalRef = ref<InstanceType<typeof InviteTeammateModal> | null>(null)

function openInviteDialog() {
  emit('opened')
  inviteModalRef.value?.openDialog()
}

function onInviteSuccess(invite: InviteSuccessPayload) {
  emit('success', invite)
}
</script>

<template>
  <div>
    <h3 class="text-lg font-semibold text-slate-950 dark:text-white">
      {{ t('onboarding-invite-option-title') }}
    </h3>
    <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
      {{ t('onboarding-invite-option-subtitle') }}
    </p>
    <button
      type="button"
      class="inline-flex items-center px-4 py-2 mt-4 text-sm font-semibold transition-colors duration-200 rounded-md cursor-pointer focus:ring-2 focus:ring-offset-2 bg-muted-blue-50 text-muted-blue-800 hover:bg-muted-blue-100 focus:outline-hidden focus:ring-muted-blue-500"
      data-test="onboarding-technical-invite"
      @click="openInviteDialog"
    >
      {{ t('onboarding-invite-option-cta') }}
    </button>
    <p class="mt-4 text-xs text-gray-400">
      {{ t('onboarding-manual-setup-prefix') }}
      <a
        href="https://capgo.app/docs/getting-started/add-an-app/#manual-setup"
        target="_blank"
        rel="noopener noreferrer"
        class="underline hover:text-gray-600"
      >{{ t('onboarding-manual-setup-link') }}</a>
    </p>
  </div>

  <InviteTeammateModal
    ref="inviteModalRef"
    :analytics-channel="analyticsChannel"
    invite-kind="technical"
    :tracking-version="trackingVersion"
    @success="onInviteSuccess"
  />
</template>
```

- [ ] **Step 4: Replace both repeated `StepsApp.vue` blocks**

Remove `InviteTeammateModal`, `inviteModalRef`, and the dialog-opening part of `openInviteDialog` from `StepsApp.vue`. Preserve its current telemetry in a renamed handler:

```ts
function onTechnicalInviteOpened() {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return

  sendEvent({
    channel: 'onboarding-v2',
    event: 'onboarding-alternative-send-invite',
    icon: '👶',
    org_id: orgId,
    tracking_version: 2,
    notify: false,
  }).catch()
  pushEvent('user:onboarding-alternative-send-invite', config.supaHost, { org_id: orgId })
}
```

Import the card and replace each title/subtitle/button/manual-link block with:

```vue
<TechnicalTeammateInviteCard
  @opened="onTechnicalInviteOpened"
  @success="onInviteSuccess"
/>
```

Keep the demo-app option immediately after the card in the `props.onboarding` branch. Keep `onInviteSuccess()` unchanged so legacy `StepsApp` still advances after a successful delegation.

- [ ] **Step 5: Run the test and commit**

Run:

```bash
bunx vitest run tests/onboarding-invite-components.unit.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/components/dashboard/TechnicalTeammateInviteCard.vue src/components/dashboard/StepsApp.vue tests/onboarding-invite-components.unit.test.ts
git commit -m "refactor(onboarding): share technical invite card"
```

---

### Task 4: Add organization website import and plan branching to v3

**Files:**

- Rename: `tests/app-onboarding-v2.unit.test.ts` → `tests/app-onboarding-v3.unit.test.ts`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue:2-110,242-250,766-847,1570-1655`
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`

- [ ] **Step 1: Rename the source contract and add failing v3 assertions**

Run:

```bash
git mv tests/app-onboarding-v2.unit.test.ts tests/app-onboarding-v3.unit.test.ts
```

Rename the suite to `pre-organization onboarding v3`. Preserve all existing assertions, replacing version-specific helper-name assertions only when the implementation renames `trackV2DetailsEvent` to `trackDetailsEvent`.

Add this test:

```ts
it.concurrent('imports organization details and branches to invitations above Solo', () => {
  expect(onboardingSource).toContain('data-test="onboarding-toggle-organization-import"')
  expect(onboardingSource).toContain('data-test="onboarding-organization-website"')
  expect(onboardingSource).toContain("invokeCapgoApi('private/website_preview'")
  expect(onboardingSource).toContain('website: websitePreview.value?.website')
  expect(onboardingSource).toContain("selectedUserCountStop.value?.planName !== 'Solo'")
  expect(onboardingSource).toContain('<OrganizationOnboardingInvite')
  expect(onboardingSource).toContain("completeAndViewStep('setup', { appId: createdApp.value.app_id })")
})

it.concurrent('creates both records before exposing invitations', () => {
  const creation = onboardingSource.slice(
    onboardingSource.indexOf('async function createOrganizationAndApp()'),
    onboardingSource.indexOf('async function createAppRecord('),
  )
  expect(creation.indexOf('await createAppRecord(')).toBeLessThan(creation.indexOf('showOrganizationInvite.value = shouldInvite'))
})
```

In `tests/app-onboarding-progress-integration.unit.test.ts`, add:

```ts
it.concurrent('keeps Maker+ invitations inside the organization progress step', () => {
  expect(onboardingSource).toContain("createAppRecord({ nextStep: shouldInvite ? 'organization' : 'setup' })")
  expect(onboardingSource).toContain("trackOrganizationEvent('onboarding_organization_invite_viewed')")
  expect(onboardingSource).toContain("completeAndViewStep('setup', { appId: createdApp.value.app_id })")
})
```

- [ ] **Step 2: Run the focused contracts and confirm they fail**

Run:

```bash
bunx vitest run tests/app-onboarding-v3.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: failures for absent website import, invite panel, and branching.

- [ ] **Step 3: Add only the organization-import state needed by this screen**

At the top of `AppOnboardingFlow.vue`, import the shared panel and upload helper:

```ts
import { uploadOrgLogoFile } from '~/services/photos'
import OrganizationOnboardingInvite from './OrganizationOnboardingInvite.vue'
```

Add the response shape and state near the existing organization refs:

```ts
interface OrganizationWebsitePreview {
  hostname: string
  icon: string | null
  name: string
  website: string
}

const isOrganizationImportOpen = ref(false)
const isImportingOrganizationWebsite = ref(false)
const organizationWebsiteInput = ref('')
const websitePreview = ref<OrganizationWebsitePreview | null>(null)
const showOrganizationInvite = ref(false)
```

Rename `trackV2DetailsEvent` to the version-neutral `trackDetailsEvent` and update its existing callers. Import the new interaction types from `onboardingProgressAnalytics.ts`, then add this small wrapper:

```ts
import type {
  OnboardingInteractionEvent,
  OnboardingInteractionProperties,
} from '~/utils/onboardingProgressAnalytics'

function trackOrganizationEvent(
  name: OnboardingInteractionEvent,
  details: OnboardingInteractionProperties = {},
) {
  progressTracker?.trackStepEvent(name, 'organization', details)
}
```

- [ ] **Step 4: Implement the existing website-preview call inline**

Add these functions beside the app-store import functions:

```ts
function toggleOrganizationWebsiteImport() {
  isOrganizationImportOpen.value = !isOrganizationImportOpen.value
  if (isOrganizationImportOpen.value)
    trackOrganizationEvent('onboarding_organization_import_opened')
}

async function importOrganizationWebsite() {
  const website = organizationWebsiteInput.value.trim()
  if (!website) {
    toast.error(t('organization-onboarding-website-invalid'))
    return
  }

  isImportingOrganizationWebsite.value = true
  trackOrganizationEvent('onboarding_organization_import_submitted')
  try {
    const { data, error } = await invokeCapgoApi('private/website_preview', {
      body: { website },
    })
    if (error || !data) {
      console.error('Failed to import organization website', error)
      toast.error(t('organization-onboarding-website-fetch-failed'))
      trackOrganizationEvent('onboarding_organization_import_failed')
      return
    }

    websitePreview.value = data as OrganizationWebsitePreview
    if (websitePreview.value.name) {
      orgNameInput.value = websitePreview.value.name
      hasEditedOrgName.value = true
    }
    trackOrganizationEvent('onboarding_organization_import_succeeded')
  }
  finally {
    isImportingOrganizationWebsite.value = false
  }
}

async function uploadImportedOrganizationLogo(orgId: string) {
  const icon = websitePreview.value?.icon
  if (!icon)
    return

  try {
    const response = await fetch(icon)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!response.ok || !contentType.startsWith('image/'))
      throw new Error('Imported organization logo is not an image')
    await uploadOrgLogoFile(orgId, await response.blob(), `${websitePreview.value?.hostname || 'website-logo'}.png`)
  }
  catch (error) {
    console.error('Failed to upload imported organization logo', error)
    toast.error(t('organization-onboarding-imported-logo-failed'))
  }
}
```

This uses the preview endpoint's bounded data URL and the existing upload helper. Do not copy the old page's manual-logo step or add URL-proxy logic.

- [ ] **Step 5: Add the collapsed import UI in the approved position**

Immediately after the organization-name input and before the active-user question, add:

```vue
<div class="space-y-3">
  <button
    type="button"
    class="d-btn min-h-11"
    :class="whiteCardSecondaryButtonClass()"
    data-test="onboarding-toggle-organization-import"
    :aria-expanded="isOrganizationImportOpen"
    @click="toggleOrganizationWebsiteImport"
  >
    <IconGlobe class="h-4 w-4" />
    {{ t('organization-onboarding-import-website') }}
  </button>

  <div v-if="isOrganizationImportOpen" class="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
    <label for="onboarding-organization-website" class="text-sm font-medium text-slate-800 dark:text-slate-200">
      {{ t('organization-onboarding-website-label') }}
    </label>
    <div class="flex flex-col gap-3 sm:flex-row">
      <input
        id="onboarding-organization-website"
        v-model="organizationWebsiteInput"
        type="url"
        placeholder="https://capgo.app"
        data-test="onboarding-organization-website"
        class="d-input min-h-11 w-full"
        @input="websitePreview = null"
      >
      <button
        type="button"
        class="d-btn min-h-11 shrink-0"
        :disabled="isImportingOrganizationWebsite || !organizationWebsiteInput.trim()"
        data-test="onboarding-import-organization-website"
        @click="importOrganizationWebsite"
      >
        <IconLoader v-if="isImportingOrganizationWebsite" class="h-4 w-4 animate-spin" />
        <IconSparkles v-else class="h-4 w-4" />
        {{ t('organization-onboarding-import-website') }}
      </button>
    </div>
    <div v-if="websitePreview" class="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
      <img v-if="websitePreview.icon" :src="websitePreview.icon" :alt="t('organization-onboarding-imported-logo-preview-alt')" class="h-10 w-10 rounded-lg object-cover">
      <span>{{ t('organization-onboarding-website-imported') }}</span>
    </div>
  </div>
</div>
```

Use the page's existing full input classes if `d-input` does not match the current form; do not introduce new CSS.

- [ ] **Step 6: Create both records, then branch by plan**

In `createOrganizationAndApp`, compute the branch only after validating the selected stop:

```ts
const shouldInvite = selectedUserCountStop.value?.planName !== 'Solo'
```

Pass the existing website field:

```ts
body: {
  name: orgName,
  email: main.auth?.email ?? '',
  estimatedMau,
  intent: selectedIntent.value,
  website: websitePreview.value?.website,
},
```

Replace the unconditional app transition with this exact order:

```ts
clearOnboardingAppDraft(onboardingUserId.value)
await createAppRecord({ nextStep: shouldInvite ? 'organization' : 'setup' })

if (!createdApp.value)
  return

await uploadImportedOrganizationLogo(data.id)
showOrganizationInvite.value = shouldInvite
if (shouldInvite)
  trackOrganizationEvent('onboarding_organization_invite_viewed')

removeBeforeUnloadWarning()
```

Keep the existing API-key preload after this block. Do not make app and organization creation transactional and do not add retry persistence.

Add the continuation handlers:

```ts
function onOrganizationInviteOpened() {
  trackOrganizationEvent('onboarding_organization_invite_opened')
}

function onOrganizationInviteSucceeded() {
  trackOrganizationEvent('onboarding_organization_invite_succeeded')
}

function continueFromOrganizationInvite(invitationCount: number) {
  if (!createdApp.value)
    return

  trackOrganizationEvent('onboarding_organization_invite_continued', {
    invitation_count: invitationCount,
  })
  showOrganizationInvite.value = false
  completeAndViewStep('setup', { appId: createdApp.value.app_id })
}
```

- [ ] **Step 7: Render the existing panel as a Step 3 substate**

Inside the existing `props.preOrg && flowStep === 'organization'` branch, render the panel before the form card:

```vue
<OrganizationOnboardingInvite
  v-if="showOrganizationInvite && createdApp && currentOrg"
  analytics-channel="onboarding-v3"
  :continue-label="t('continue')"
  :organization-id="currentOrg.gid"
  :organization-name="currentOrg.name"
  :tracking-version="3"
  @continue="continueFromOrganizationInvite"
  @invite-opened="onOrganizationInviteOpened"
  @invite-succeeded="onOrganizationInviteSucceeded"
/>
<div v-else class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
  <div class="space-y-6">
```

Keep the current organization form children, from its heading block through its Back/Create action row, unchanged inside that `space-y-6` element. Close the wrapper immediately after the current action row:

```vue
  </div>
</div>
```

Do not add `invite` to `PreOrgFlowStep` or `appOnboardingSteps`; the progress indicator must remain on organization.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
bunx vitest run tests/app-onboarding-v3.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts tests/onboarding-invite-components.unit.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/components/dashboard/AppOnboardingFlow.vue tests/app-onboarding-v3.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
git commit -m "feat(onboarding): add organization import and invite branch"
```

---

### Task 5: Add the technical invitation to Step 4 and extend the happy path

**Files:**

- Modify: `src/components/dashboard/AppOnboardingFlow.vue:1648-1740`
- Modify: `messages/en.json:1790-1795`
- Modify: `tests/app-onboarding-v3.unit.test.ts`
- Modify: `playwright/e2e/register.spec.ts:15-70`

- [ ] **Step 1: Add failing universal-visibility and browser assertions**

Add to `tests/app-onboarding-v3.unit.test.ts`:

```ts
it.concurrent('shows technical delegation unconditionally on pre-org setup', () => {
  const setup = onboardingSource.slice(
    onboardingSource.indexOf("flowStep === 'setup' && createdApp"),
    onboardingSource.indexOf("!props.preOrg && flowStep === 'choice'"),
  )
  expect(setup).toContain('<TechnicalTeammateInviteCard')
  expect(setup).toContain('analytics-channel="onboarding-v3"')
  expect(setup).toContain(':tracking-version="3"')
  expect(setup).not.toContain('selectedUserCountStop')
})
```

Update the existing registration happy path to select Maker and expect the two new states:

```ts
await page.locator('[data-test="onboarding-estimated-users-option"]').nth(1).click()
await page.click('[data-test="onboarding-create-org"]')

await expect(page.locator('[data-test="onboarding-invite-users"]')).toBeVisible({ timeout: 60000 })
await expect(page.locator('[data-test="app-onboarding-command-copy"]')).toHaveCount(0)
await page.click('[data-test="onboarding-finish"]')

await expect(page.locator('[data-test="app-onboarding-command-copy"]')).toBeVisible({ timeout: 60000 })
await expect(page.locator('[data-test="onboarding-technical-invite"]')).toBeVisible()
```

- [ ] **Step 2: Run the unit contract and confirm it fails**

Run:

```bash
bunx vitest run tests/app-onboarding-v3.unit.test.ts
```

Expected: failure because Step 4 does not render the card.

- [ ] **Step 3: Render the shared card on Step 4 for every plan**

Import `TechnicalTeammateInviteCard` and add these handlers:

```ts
function onTechnicalInviteOpened() {
  progressTracker?.trackStepEvent('onboarding_technical_invite_opened', 'setup')
}

function onTechnicalInviteSucceeded() {
  progressTracker?.trackStepEvent('onboarding_technical_invite_succeeded', 'setup')
}
```

In the pre-org Step 4 card, immediately below the CLI command/loading block and above the AI-help card, add:

```vue
<TechnicalTeammateInviteCard
  analytics-channel="onboarding-v3"
  :tracking-version="3"
  @opened="onTechnicalInviteOpened"
  @success="onTechnicalInviteSucceeded"
/>
```

Do not condition this component on plan or invitation history.

- [ ] **Step 4: Make the existing delegation copy accurate in both old and new contexts**

Update only these existing English messages:

```json
"onboarding-invite-option-dialog-desc": "We will invite them as an organization administrator and email instructions to finish setting up Capgo for this organization.",
"onboarding-invite-option-helper": "They will receive an email asking them to finish setting up Capgo for this organization.",
"onboarding-invite-option-subtitle": "Invite a technical teammate and we will email them instructions to finish setting up Capgo for this organization."
```

Do not add duplicate v3-only keys.

- [ ] **Step 5: Run focused unit and browser tests**

Run:

```bash
bunx vitest run tests/app-onboarding-v3.unit.test.ts tests/onboarding-invite-components.unit.test.ts
```

Expected: all tests pass.

Run:

```bash
bun test:front -- playwright/e2e/register.spec.ts
```

Expected: the registration suite passes; the first test observes Maker invitations before Step 4 and the technical invitation card on Step 4.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/AppOnboardingFlow.vue messages/en.json tests/app-onboarding-v3.unit.test.ts playwright/e2e/register.spec.ts
git commit -m "feat(onboarding): offer technical setup delegation"
```

---

### Task 6: Final verification and diff-budget audit

**Files:**

- Verify all files listed above.
- Do not add new production files unless a failing check proves one is required.

- [ ] **Step 1: Run formatting and lint before final validation**

Run:

```bash
bun lint
```

Expected: exit code `0`. Apply only formatter/lint fixes within the files in this plan.

- [ ] **Step 2: Run frontend type checking**

Run:

```bash
bun run typecheck:frontend
```

Expected: exit code `0` with no Vue or TypeScript errors.

- [ ] **Step 3: Run the focused unit suite**

Run:

```bash
bunx vitest run tests/app-onboarding-v3.unit.test.ts tests/app-onboarding-apikey-loading.unit.test.ts tests/app-onboarding-file-input.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/onboarding-details-field-debouncer.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts tests/onboarding-invite-components.unit.test.ts tests/organization-onboarding-logo-upload.unit.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Run the registration browser suite**

Run:

```bash
bun test:front -- playwright/e2e/register.spec.ts
```

Expected: all registration tests pass.

- [ ] **Step 5: Audit the actual diff against the simplicity requirement**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --numstat origin/main...HEAD
```

Expected:

- No backend, schema, migration, auth redirect, or persistence files changed.
- No copied onboarding orchestrator.
- Total added plus deleted lines remain below 1,200. If they exceed 1,200, remove abstraction or redundant tests before proceeding; do not continue toward 2,000 by default.

- [ ] **Step 6: Perform the acceptance audit**

Confirm each item from `docs/superpowers/specs/2026-08-14-onboarding-v3-design.md`:

```text
[ ] All AppOnboardingFlow progress events use version 3.
[ ] Organization import is collapsed below name and above size.
[ ] Import uses private/website_preview and the existing website field.
[ ] Imported logo uses uploadOrgLogoFile from the merged PR #3052 path.
[ ] Organization and app exist before invitations render.
[ ] Solo enters setup directly.
[ ] Maker, Team, and Enterprise see the existing invitation panel in Step 3.
[ ] Continue works with zero invites and has no confirmation dialog.
[ ] Technical invitation appears on Step 4 for every plan and remains org_admin.
[ ] Additional-organization invitation behavior is unchanged.
[ ] Refresh recovery, completion markers, date gates, and database changes are absent.
```

- [ ] **Step 7: Commit verification-only fixes if lint or typecheck changed files**

If no files changed, do not create an empty commit. Otherwise:

```bash
git add src/components/dashboard/AppOnboardingFlow.vue src/components/dashboard/InviteTeammateModal.vue src/components/dashboard/OrganizationOnboardingInvite.vue src/components/dashboard/StepsApp.vue src/components/dashboard/TechnicalTeammateInviteCard.vue src/pages/onboarding/organization.vue src/utils/onboardingProgressAnalytics.ts messages/en.json tests/app-onboarding-v3.unit.test.ts tests/app-onboarding-apikey-loading.unit.test.ts tests/app-onboarding-file-input.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/onboarding-details-field-debouncer.unit.test.ts tests/onboarding-progress-analytics.unit.test.ts tests/onboarding-invite-components.unit.test.ts tests/organization-onboarding-logo-upload.unit.test.ts playwright/e2e/register.spec.ts
git commit -m "test(onboarding): verify v3 flow"
```

Do not stage `codedb.snapshot` or unrelated user changes.
