<script setup lang="ts">
import type { Json } from '~/types/database.types'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconLoader from '~icons/lucide/loader-2'
import AppOnboardingHeader from '~/components/dashboard/AppOnboardingHeader.vue'
import AppOnboardingPageFrame from '~/components/dashboard/AppOnboardingPageFrame.vue'
import OnboardingProfile from '~/components/OnboardingProfile.vue'
import { getLocalConfig } from '~/services/console'
import { mergeUserOnboardingProgress, replaceUserOnboardingWithRetry, serializeUserOnboardingWrite } from '~/services/userOnboardingWriteQueue'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { onboardingPrimaryButtonClass } from '~/utils/onboardingButtonClasses'
import { canEditInitialOnboardingName, consumeProfileOnboardingHandoff, initialProfileOnboardingProgressSteps, initialProfileOnboardingSteps, needsInitialOnboardingName, PROFILE_ONBOARDING_HANDOFF_KEY } from '~/utils/onboardingProfile'
import { createOnboardingDetailsFieldDebouncer, createOnboardingProgressTracker, createOnboardingTelemetryIdentity, PROFILE_ONBOARDING_ANALYTICS_VERSION } from '~/utils/onboardingProgressAnalytics'
import { openOnboardingResumeDialog } from '~/utils/onboardingResumeDialog'
import { initialOnboardingSetupScreen } from '~/utils/onboardingSetupMode'
import { validateRedirectPath } from '~/utils/safeRedirect'

const main = useMainStore()
const dialogStore = useDialogV2Store()
const initialUserId = main.user?.id
const initialAuthGeneration = main.authGeneration
const organizationStore = useOrganizationStore()
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const profileForm = ref<InstanceType<typeof OnboardingProfile> | null>(null)
const isSaving = ref(false)
const isLoggingOut = ref(false)
const onboarding = main.user?.onboarding
const savedOnboarding = onboarding && typeof onboarding === 'object' && !Array.isArray(onboarding) ? onboarding : {}
const savedDraft = savedOnboarding.profile_draft
const isEditingProfile = computed(() => route.query.edit === '1' && canEditInitialOnboardingName(main.user, organizationStore.hasOrganizations))
const hasSavedDraft = Boolean(savedDraft && typeof savedDraft === 'object' && !Array.isArray(savedDraft))
const targetPath = computed(() => validateRedirectPath(typeof route.query.to === 'string' ? route.query.to : '', '/onboarding/app', { blockedPrefixes: ['/onboarding/name'] }))
// Before the AI-or-manual choice, show the steps of the screen that comes next.
const showsSetupChoiceNext = computed(() => !targetPath.value.startsWith('/onboarding/organization')
  && initialOnboardingSetupScreen({ onboarding: main.user?.onboarding, newOrganization: false, resuming: false }) !== 'manual')
const progressSteps = computed(() => showsSetupChoiceNext.value
  ? [
      { id: 'name', label: t('unified-onboarding-step-about-you') },
      { id: 'mode', label: t('ai-onboarding-step-mode') },
      { id: 'plan', label: t('ai-onboarding-step-plan') },
      { id: 'agent', label: t('ai-onboarding-step-agent') },
    ]
  : initialProfileOnboardingProgressSteps(main.user?.onboarding)
      .filter(step => !targetPath.value.startsWith('/onboarding/organization') || step.id === 'name' || step.id === 'organization')
      .map(step => ({ id: step.id, label: t(step.labelKey) })))
const profileHandoff = consumeProfileOnboardingHandoff(window.history)
// Signup opens straight on About you; only saved names or an edit offer the resume choice.
let resumed = (isEditingProfile.value || hasSavedDraft) && !profileHandoff
const resumePending = ref(resumed)
const identity = createOnboardingTelemetryIdentity({ continueFrom: profileHandoff, flow: 'pre_org', onboardingVersion: () => PROFILE_ONBOARDING_ANALYTICS_VERSION, apiHost: getLocalConfig().apiHost })
const analyticsSteps = targetPath.value.startsWith('/onboarding/organization') ? ['name', 'organization'] as const : initialProfileOnboardingSteps(main.user?.onboarding, false)
let tracker: ReturnType<typeof createOnboardingProgressTracker> | undefined
let disposed = false
const fields = createOnboardingDetailsFieldDebouncer((event, step, properties) => tracker?.trackDetailsEvent(event, step, properties), 500)

function trackField(field: 'first_name' | 'last_name' | 'company_name', value: string) {
  const event = field === 'company_name' ? 'onboarding_company_name_entered' : field === 'first_name' ? 'onboarding_first_name_entered' : 'onboarding_last_name_entered'
  fields.schedule(event, field, 'name', value)
}

async function persistProfileProgress(patch: Record<string, Json> | ((current: Json) => Json)) {
  const userId = initialUserId
  if (!userId || main.user?.id !== userId || main.authGeneration !== initialAuthGeneration)
    return false
  const authGeneration = initialAuthGeneration
  return serializeUserOnboardingWrite(userId, async () => {
    const isCurrentUser = () => !disposed && main.user?.id === userId && main.authGeneration === authGeneration
    if (!isCurrentUser())
      return false
    const result = await replaceUserOnboardingWithRetry(userId, main.user!.onboarding, current => typeof patch === 'function'
      ? patch(current)
      : ({
          ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
          ...patch,
        }), isCurrentUser)
    if (result.status !== 'persisted' || !isCurrentUser())
      return false
    main.user = { ...main.user!, onboarding: result.onboarding }
    return true
  })
}

async function continueAfterName() {
  if (isSaving.value || !profileForm.value?.isValid)
    return
  isSaving.value = true
  try {
    if (!await profileForm.value.save())
      return
    let confirmed = false
    try {
      confirmed = await persistProfileProgress({ profile_completed_at: new Date().toISOString() })
    }
    catch (error) {
      console.warn('Cannot confirm profile onboarding', error)
    }
    if (!confirmed) {
      tracker?.trackStepEvent('onboarding_profile_save_failed', 'name')
      toast.error(t('account-error'))
      return
    }
    fields.dispose()
    tracker?.trackStepEvent('onboarding_profile_saved', 'name')
    tracker?.completeStep('name', { nextStep: targetPath.value.startsWith('/onboarding/organization') ? 'organization' : 'intent' })
    const destination = router.resolve(targetPath.value)
    await router.replace({ path: destination.path, query: destination.query, hash: destination.hash, state: { [PROFILE_ONBOARDING_HANDOFF_KEY]: { attemptId: identity.attemptId, runId: identity.runId } } })
  }
  finally {
    isSaving.value = false
  }
}

async function logout() {
  if (isLoggingOut.value || isSaving.value)
    return
  isLoggingOut.value = true
  try {
    await main.logout()
    await router.replace('/login')
  }
  catch (error) {
    console.error('Failed to log out from name onboarding', error)
    toast.error(t('cannot-sign-off'))
  }
  finally {
    isLoggingOut.value = false
  }
}

function visibilityChanged() {
  tracker?.trackVisibilityChange(document.visibilityState)
}

async function restartProfileOnboarding() {
  try {
    if (await persistProfileProgress(current => mergeUserOnboardingProgress({ onboarding_attempt_id: identity.attemptId, last_run_id: identity.runId }, current, { clearIntent: true, clearProfileDraft: true })))
      return true
  }
  catch (error) {
    console.warn('Cannot restart profile onboarding', error)
  }
  toast.error(t('account-error'))
  return false
}

async function resumeSavedProfile() {
  identity.prepareResumeCandidate({
    onboardingAttemptId: typeof savedOnboarding.onboarding_attempt_id === 'string' ? savedOnboarding.onboarding_attempt_id : undefined,
    lastRunId: typeof savedOnboarding.last_run_id === 'string' ? savedOnboarding.last_run_id : undefined,
    savedStep: 'name',
    steps: analyticsSteps,
  })
  const dismissal = openOnboardingResumeDialog(dialogStore, t, {
    id: 'onboarding-profile-resume',
    onRestart: restartProfileOnboarding,
  })
  identity.recordResumeDialogViewed()
  await dismissal
  if (disposed || main.user?.id !== initialUserId || main.authGeneration !== initialAuthGeneration)
    return false
  if (dialogStore.lastButtonRole === 'onboarding-resume-restart') {
    identity.recordResumeRestarted()
    resumed = false
    if (isEditingProfile.value) {
      const { edit: _edit, ...query } = route.query
      await router.replace({ path: '/onboarding/name', query })
    }
  }
  else if (dialogStore.lastButtonRole === 'onboarding-resume-continue') {
    identity.recordResumeContinued()
  }
  else {
    return false
  }
  resumePending.value = false
  return true
}

onMounted(async () => {
  if (!isEditingProfile.value && !needsInitialOnboardingName(main.user, organizationStore.hasOrganizations)) {
    await router.replace(targetPath.value)
    return
  }
  if (resumePending.value && !await resumeSavedProfile())
    return
  tracker = createOnboardingProgressTracker({ flow: 'pre_org', onboardingVersion: () => PROFILE_ONBOARDING_ANALYTICS_VERSION, resumed, steps: analyticsSteps, apiHost: getLocalConfig().apiHost, onboardingAttemptId: identity.attemptId, onboardingRunId: identity.runId })
  tracker.viewStep('name', isEditingProfile.value ? 'intent' : undefined)
  document.addEventListener('visibilitychange', visibilityChanged)
  try {
    await persistProfileProgress({ onboarding_attempt_id: identity.attemptId, last_run_id: identity.runId })
  }
  catch (error) {
    console.warn('Cannot persist profile onboarding identity', error)
  }
})

onBeforeUnmount(() => {
  disposed = true
  if (resumePending.value && dialogStore.dialogOptions.id === 'onboarding-profile-resume')
    void dialogStore.closeDialog()
  fields.dispose()
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <AppOnboardingPageFrame :is-logging-out="isLoggingOut" :disabled="isSaving || resumePending" @logout="logout">
    <section v-if="!resumePending" class="onboarding-flow-shell onboarding-flow-app-creation onboarding-flow-details-name h-full min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-6 sm:px-6 lg:px-8 dark:bg-slate-950">
      <div class="onboarding-flow-content mx-auto w-full max-w-3xl space-y-6">
        <AppOnboardingHeader :title="t('onboarding-welcome-title')" :steps="progressSteps" current-step-id="name" />
        <form class="onboarding-details-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95" data-test="onboarding-name-step" @submit.prevent="continueAfterName">
          <div class="onboarding-details-card-content space-y-6">
            <div class="onboarding-details-heading">
              <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                {{ t('onboarding-name-kicker') }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                {{ t('unified-onboarding-step-about-you') }}
              </h2>
              <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                {{ t('onboarding-name-description') }}
              </p>
            </div>
            <OnboardingProfile ref="profileForm" initial :disabled="isSaving" @field-input="trackField" @save-failed="tracker?.trackStepEvent('onboarding_profile_save_failed', 'name')" />
            <p class="text-sm leading-6 text-slate-500 dark:text-slate-400">
              {{ t('onboarding-name-required') }}
            </p>
            <div class="onboarding-details-actions flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-end dark:border-white/15">
              <button type="submit" class="d-btn min-h-12" :class="onboardingPrimaryButtonClass" :disabled="!profileForm?.isValid || isSaving" data-test="onboarding-name-continue">
                <IconLoader v-if="isSaving" class="h-4 w-4 animate-spin" />
                {{ t('continue') }}
                <IconArrowRight v-if="!isSaving" class="h-4 w-4" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  </AppOnboardingPageFrame>
</template>

<route lang="yaml">
meta:
  layout: naked
  middleware: auth
</route>
