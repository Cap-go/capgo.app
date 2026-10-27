<script setup lang="ts">
import type { Json } from '~/types/database.types'
import type { AiOnboardingGoal, OnboardingSetupMode } from '~/utils/onboardingSetupMode'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconBot from '~icons/lucide/bot'
import IconCheck from '~icons/lucide/check'
import IconCompass from '~icons/lucide/compass'
import IconLayers from '~icons/lucide/layers'
import IconLightbulb from '~icons/lucide/lightbulb'
import IconListChecks from '~icons/lucide/list-checks'
import IconLoader from '~icons/lucide/loader-2'
import IconMailCheck from '~icons/lucide/mail-check'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconSmartphone from '~icons/lucide/smartphone'
import IconUserPlus from '~icons/lucide/user-plus'
import IconUsers from '~icons/lucide/users'
import AppOnboardingHeader from '~/components/dashboard/AppOnboardingHeader.vue'
import BillingRegionChoice from '~/components/dashboard/BillingRegionChoice.vue'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'
import { developmentEnvironmentOptions } from '~/components/dashboard/onboardingDevelopmentEnvironmentOptions'
import OnboardingToolPattern from '~/components/dashboard/OnboardingToolPattern.vue'
import { getCapgoApiErrorCode, invokeCapgoApi } from '~/services/capgoApi'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { replaceUserOnboardingWithRetry, serializeUserOnboardingWrite } from '~/services/userOnboardingWriteQueue'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { onboardingPrimaryButtonClass, onboardingSecondaryButtonClass } from '~/utils/onboardingButtonClasses'
import { onboardingPlanStops } from '~/utils/onboardingPlanStops'
import { aiGoalToIntent, aiOnboardingPathFor, defaultAiOrganizationName, readAiOnboardingGoal, withAiSetupOrganization, withOnboardingFields, withOnboardingSetupMode, withoutAiAgentProgress } from '~/utils/onboardingSetupMode'

type SetupScreen = 'choice' | 'ai' | 'invite'

const props = defineProps<{ initialScreen: SetupScreen, newOrganization?: boolean }>()
const emit = defineEmits<{ manual: [] }>()

const { t } = useI18n()
const router = useRouter()
const main = useMainStore()
const organizationStore = useOrganizationStore()

const screen = ref<SetupScreen>(props.initialScreen)
const isInvite = computed(() => screen.value === 'invite')
const goalCopyPrefix = computed(() => isInvite.value ? 'invite' : 'ai')
// Organization to invite into. A refresh after the invite flow created it lands back on the
// invite step instead of offering to create a second one. Only that saved organization counts,
// never whichever organization happens to be current.
function savedInviteOrgId() {
  const onboarding = main.user?.onboarding
  const orgId = onboarding && typeof onboarding === 'object' && !Array.isArray(onboarding) ? onboarding.invite_setup_org_id : null
  return typeof orgId === 'string' && organizationStore.organizations.some(org => org.gid === orgId) ? orgId : null
}
const inviteOrgId = ref<string | null>(props.initialScreen === 'invite' && !props.newOrganization ? savedInviteOrgId() : null)
const invitedEmails = ref<string[]>([])
const inviteModalRef = ref<InstanceType<typeof InviteTeammateModal> | null>(null)
const isSaving = ref(false)
const isCreating = ref(false)
const planIndex = ref<number | null>(null)
// A refresh keeps the goal the user already picked.
const goal = ref<AiOnboardingGoal | null>(readAiOnboardingGoal(main.user?.onboarding))
const goalOptions = [
  { value: 'ota', icon: IconRefresh },
  { value: 'builder', icon: IconSmartphone },
  { value: 'both', icon: IconLayers },
  { value: 'unsure', icon: IconCompass },
] as const satisfies ReadonlyArray<{ value: AiOnboardingGoal, icon: unknown }>
const billingAccount = ref<'ee' | 'us' | undefined>()
const hasEditedOrgName = ref(false)
const orgNameInput = ref('')
const assistantIcons = developmentEnvironmentOptions.find(option => option.value === 'ai_assistant')?.icons ?? []

const defaultOrgName = computed(() => {
  const name = defaultAiOrganizationName(
    main.user?.first_name,
    t('ai-onboarding-default-org-name-fallback'),
    first => t('ai-onboarding-default-org-name', { name: first }),
  )
  // A second organization would collide with the first one's default name: ask instead.
  const taken = organizationStore.organizations.some(org => org.name.trim().toLowerCase() === name.toLowerCase())
  return taken ? '' : name
})
const orgName = computed({
  get: () => hasEditedOrgName.value ? orgNameInput.value : defaultOrgName.value,
  set: (value: string) => {
    hasEditedOrgName.value = true
    orgNameInput.value = value
  },
})
const planStops = computed(() => onboardingPlanStops(main.plans))
const selectedPlan = computed(() => planIndex.value === null ? null : planStops.value[planIndex.value] ?? null)
const canCreate = computed(() => !!goal.value && !!selectedPlan.value && orgName.value.trim().length >= 3 && !isCreating.value)
const steps = computed(() => [
  // Existing users creating another organization already filled in their profile.
  ...(props.newOrganization ? [] : [{ id: 'name', label: t('unified-onboarding-step-about-you') }]),
  { id: 'mode', label: t('ai-onboarding-step-mode') },
  { id: 'plan', label: t('ai-onboarding-step-plan') },
  isInvite.value
    ? { id: 'invite', label: t('invite-onboarding-step-invite') }
    : { id: 'agent', label: t('ai-onboarding-step-agent') },
])
const currentStepId = computed(() => {
  if (screen.value === 'choice')
    return 'mode'
  return inviteOrgId.value ? 'invite' : 'plan'
})

function planTitle(index: number) {
  const stop = planStops.value[index]
  if (!stop)
    return ''
  if (stop.startingOut)
    return t('organization-onboarding-starting-out')
  if (stop.value >= 1_000_000)
    return t('organization-onboarding-active-users-plus', { count: stop.label })
  return t('organization-onboarding-active-users-up-to', { count: stop.label })
}

// Remembering the choice lets a refresh land on the same screen. A failed write only costs
// that convenience, so the user is never blocked here.
function rememberSetupMode(mode: OnboardingSetupMode) {
  return rememberOnboarding(current => withOnboardingSetupMode(current, mode))
}

/** Returns whether the update was saved. Conflicts and write errors count as not saved. */
async function rememberOnboarding(update: (current: Json) => Json): Promise<boolean> {
  const userId = main.user?.id
  if (!userId)
    return false
  try {
    return await serializeUserOnboardingWrite(userId, async () => {
      const result = await replaceUserOnboardingWithRetry(
        userId,
        main.user!.onboarding,
        update,
        () => main.user?.id === userId,
      )
      if (result.status !== 'persisted' || main.user?.id !== userId)
        return false
      main.user = { ...main.user, onboarding: result.onboarding }
      return true
    })
  }
  catch (error) {
    console.warn('Cannot save onboarding choice', error)
    return false
  }
}

// Save the goal as soon as it is picked, so a refresh before submitting restores it.
// Organization creation saves it again and stops if that fails.
watch(goal, (value) => {
  if (value)
    void rememberOnboarding(current => withOnboardingFields(current, { intent: aiGoalToIntent(value) }))
})

async function chooseMode(mode: OnboardingSetupMode) {
  if (isSaving.value)
    return
  isSaving.value = true
  try {
    sendOnboardingEvent('onboarding_setup_mode_selected', { setup_mode: mode })
    // The mode drives redirects and the Getting started checklist, so it must be saved first.
    if (!await rememberSetupMode(mode)) {
      toast.error(t('account-error'))
      return
    }
    if (mode === 'manual') {
      emit('manual')
      return
    }
    screen.value = mode
  }
  finally {
    isSaving.value = false
  }
}

async function createOrganization() {
  const plan = selectedPlan.value
  const name = orgName.value.trim()
  const chosenGoal = goal.value
  if (!chosenGoal || !plan || name.length < 3 || isCreating.value)
    return

  const inviting = isInvite.value
  isCreating.value = true
  try {
    const intent = aiGoalToIntent(chosenGoal)
    // Saved before the agent registers the app: app creation reads it to pick the
    // matching Getting started checklist (live updates, Builder or both). Without it the
    // app could get the wrong checklist, so stop here and let the user retry.
    // An earlier AI setup's agent markers belong to another organization: start fresh.
    if (!await rememberOnboarding(current => withOnboardingFields(withoutAiAgentProgress(current), { intent }))) {
      toast.error(t('account-error'))
      return
    }
    const { data, error } = await invokeCapgoApi<{ id: string }>('organization', {
      method: 'POST',
      body: {
        name,
        email: main.auth?.email ?? '',
        estimatedMau: plan.value,
        startingOut: plan.startingOut === true,
        intent,
        // The invited teammate picks their own tooling.
        developmentEnvironment: inviting ? undefined : 'ai_assistant',
        billingAccount: billingAccount.value,
      },
    })
    if (error || !data?.id) {
      console.error('Cannot create organization for AI onboarding', error)
      const code = await getCapgoApiErrorCode(error)
      toast.error(code === '23505' ? t('org-with-this-name-exists') : t('cannot-create-org'))
      return
    }

    // Scope the agent markers to this organization. If this write fails, the backend falls
    // back to accepting any prompt key, which only matters with several AI setups in flight.
    if (!inviting && !await rememberOnboarding(current => withAiSetupOrganization(current, data.id)))
      console.warn('Cannot scope AI onboarding progress to the new organization')

    sendOnboardingEvent(inviting ? 'onboarding_invite_org_created' : 'onboarding_ai_org_created', {
      org_id: data.id,
      estimated_mau: plan.value,
      plan_name: plan.planName,
      starting_out: plan.startingOut === true,
      org_name_edited: hasEditedOrgName.value,
      goal: chosenGoal,
    })

    try {
      await organizationStore.fetchOrganizations()
      organizationStore.setCurrentOrganization(data.id)
    }
    catch (refreshError) {
      // The org exists; the AI page reloads organizations itself.
      console.warn('Cannot refresh organizations after AI onboarding create', refreshError)
    }
    if (inviting) {
      // Lets a refresh return to this organization's invite step.
      if (!await rememberOnboarding(current => withOnboardingFields(current, { invite_setup_org_id: data.id })))
        console.warn('Cannot remember the organization created for the teammate invite')
      inviteOrgId.value = data.id
      await nextTick()
      openInviteDialog()
      return
    }
    await router.replace(aiOnboardingPathFor(data.id))
  }
  finally {
    isCreating.value = false
  }
}

function openInviteDialog() {
  sendOnboardingEvent('onboarding_invite_dialog_opened', { org_id: inviteOrgId.value ?? '', invites_sent: invitedEmails.value.length })
  inviteModalRef.value?.openDialog()
}

function onInviteSuccess(invite: { email: string }) {
  invitedEmails.value = [...invitedEmails.value, invite.email]
  sendOnboardingEvent('onboarding_invite_sent', { org_id: inviteOrgId.value ?? '', invites_sent: invitedEmails.value.length })
}
</script>

<template>
  <section class="onboarding-flow-shell onboarding-flow-app-creation h-full min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-6 sm:px-6 lg:px-8 dark:bg-slate-950">
    <div class="onboarding-flow-content mx-auto w-full max-w-3xl space-y-6">
      <AppOnboardingHeader :title="props.newOrganization ? t('ai-onboarding-new-org-title') : t('onboarding-welcome-title')" :steps="steps" :current-step-id="currentStepId" />

      <div v-if="screen === 'choice'" class="onboarding-intent-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95" data-test="onboarding-setup-mode">
        <div class="onboarding-intent-card-content space-y-6">
          <div>
            <h2 class="text-2xl font-semibold text-slate-950 dark:text-white">
              {{ t('ai-onboarding-mode-title') }}
            </h2>
            <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('ai-onboarding-mode-subtitle') }}
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              class="d-btn d-btn-ghost group relative h-auto min-h-[13rem] w-full flex-col items-start justify-end gap-0 overflow-hidden whitespace-normal rounded-xl border border-primary-500 bg-white p-5 text-left ring-2 ring-primary-500/15 transition hover:border-primary-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:bg-slate-950/90 dark:hover:bg-slate-900"
              :disabled="isSaving"
              data-test="onboarding-setup-mode-ai"
              @click="chooseMode('ai')"
            >
              <OnboardingToolPattern :icons="assistantIcons" muted />
              <span class="relative z-10 mb-auto inline-flex items-center gap-1.5 rounded-full bg-primary-500 px-2.5 py-1 text-xs font-semibold text-white">
                {{ t('ai-onboarding-mode-recommended') }}
              </span>
              <span class="relative z-10 mt-6 flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
                <IconBot class="h-5 w-5 text-primary-500" aria-hidden="true" />
                {{ t('ai-onboarding-mode-ai-label') }}
              </span>
              <span class="relative z-10 mt-1 block text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('ai-onboarding-mode-ai-desc') }}
              </span>
            </button>

            <button
              type="button"
              class="d-btn d-btn-ghost group h-auto min-h-[13rem] w-full flex-col items-start justify-end gap-0 whitespace-normal rounded-xl border border-slate-200 bg-white p-5 text-left transition hover:border-primary-500/40 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-white/15 dark:bg-slate-950/90 dark:hover:border-white/30 dark:hover:bg-slate-900"
              :disabled="isSaving"
              data-test="onboarding-setup-mode-invite"
              @click="chooseMode('invite')"
            >
              <span class="flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
                <IconUserPlus class="h-5 w-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                {{ t('ai-onboarding-mode-invite-label') }}
              </span>
              <span class="mt-1 block text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('ai-onboarding-mode-invite-desc') }}
              </span>
            </button>

            <button
              type="button"
              class="d-btn d-btn-ghost group h-auto min-h-[13rem] w-full flex-col items-start justify-end gap-0 whitespace-normal rounded-xl border border-slate-200 bg-white p-5 text-left transition hover:border-primary-500/40 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-white/15 dark:bg-slate-950/90 dark:hover:border-white/30 dark:hover:bg-slate-900"
              :disabled="isSaving"
              data-test="onboarding-setup-mode-manual"
              @click="chooseMode('manual')"
            >
              <span class="flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
                <IconListChecks class="h-5 w-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                {{ t('ai-onboarding-mode-manual-label') }}
              </span>
              <span class="mt-1 block text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('ai-onboarding-mode-manual-desc') }}
              </span>
            </button>
          </div>

          <p class="text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('ai-onboarding-mode-footnote') }}
          </p>
        </div>
      </div>

      <div v-else-if="inviteOrgId" class="onboarding-details-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95" data-test="onboarding-invite-teammate">
        <div class="onboarding-details-card-content space-y-6">
          <div>
            <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
              {{ t('ai-onboarding-plan-kicker') }}
            </p>
            <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
              {{ t('invite-onboarding-title') }}
            </h2>
            <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('invite-onboarding-subtitle') }}
            </p>
          </div>

          <ul v-if="invitedEmails.length" class="space-y-2" data-test="onboarding-invite-sent">
            <li v-for="email in invitedEmails" :key="email" class="flex items-center gap-3 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
              <IconMailCheck class="h-4 w-4 shrink-0" aria-hidden="true" />
              <span class="min-w-0 break-all">{{ t('invite-onboarding-sent', { email }) }}</span>
            </li>
          </ul>

          <div class="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between dark:border-white/15">
            <button type="button" class="d-btn min-h-12" :class="invitedEmails.length ? onboardingPrimaryButtonClass : onboardingSecondaryButtonClass" data-test="onboarding-invite-dashboard" @click="router.replace('/dashboard')">
              {{ t('app-onboarding-explore-dashboard') }}
              <IconArrowRight v-if="invitedEmails.length" class="h-4 w-4" />
            </button>
            <button type="button" class="d-btn min-h-12" :class="invitedEmails.length ? onboardingSecondaryButtonClass : onboardingPrimaryButtonClass" data-test="onboarding-invite-open" @click="openInviteDialog">
              <IconUserPlus class="h-4 w-4" aria-hidden="true" />
              {{ invitedEmails.length ? t('invite-onboarding-invite-another') : t('onboarding-invite-option-cta') }}
            </button>
          </div>
        </div>

        <InviteTeammateModal
          ref="inviteModalRef"
          analytics-channel="onboarding-v3"
          invite-kind="technical"
          :organization-id="inviteOrgId"
          :tracking-version="3"
          @success="onInviteSuccess"
        />
      </div>

      <form v-else class="onboarding-details-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95" data-test="onboarding-ai-plan" @submit.prevent="createOrganization">
        <div class="onboarding-details-card-content space-y-6">
          <div>
            <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
              {{ t('ai-onboarding-plan-kicker') }}
            </p>
            <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
              {{ t('ai-onboarding-plan-title') }}
            </h2>
            <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ isInvite ? t('invite-onboarding-plan-subtitle') : t('ai-onboarding-plan-subtitle') }}
            </p>
          </div>

          <div>
            <p id="ai-onboarding-goal-label" class="text-sm font-medium text-slate-800 dark:text-slate-200">
              {{ isInvite ? t('invite-onboarding-goal-label') : t('ai-onboarding-goal-label') }}
            </p>
            <div class="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="ai-onboarding-goal-label" data-test="onboarding-ai-goal-options">
              <label v-for="option in goalOptions" :key="option.value" class="group cursor-pointer" :data-test="`onboarding-ai-goal-${option.value}`">
                <input v-model="goal" type="radio" name="ai-onboarding-goal" class="peer sr-only" :value="option.value">
                <span
                  class="flex h-full min-h-20 items-start gap-3 rounded-xl border p-3 text-left transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:peer-focus-visible:ring-offset-slate-900"
                  :class="goal === option.value
                    ? 'border-primary-500 bg-slate-100 text-slate-950 ring-2 ring-primary-500/15 dark:border-primary-500/80 dark:bg-primary-500/25 dark:text-white dark:ring-primary-500/30'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:bg-slate-900'"
                >
                  <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 text-primary-500"><component :is="option.icon" class="h-5 w-5" aria-hidden="true" /></span>
                  <span class="min-w-0">
                    <span class="block text-sm font-semibold">{{ t(`${goalCopyPrefix}-onboarding-goal-${option.value}-label`) }}</span>
                    <span class="mt-1 block text-xs leading-5 text-slate-600 dark:text-slate-300">{{ t(`${goalCopyPrefix}-onboarding-goal-${option.value}-desc`) }}</span>
                  </span>
                </span>
              </label>
            </div>
            <p class="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600 dark:bg-slate-950/60 dark:text-slate-300" data-test="onboarding-goal-decision-hint">
              <IconLightbulb class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              {{ t('onboarding-goal-decision-hint') }}
            </p>
          </div>

          <div>
            <p id="ai-onboarding-plan-label" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
              <IconUsers class="h-4 w-4 text-primary-500" />
              {{ t('organization-onboarding-existing-users-label') }}
            </p>
            <div class="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="ai-onboarding-plan-label" data-test="onboarding-ai-plan-options">
              <label
                v-for="(stop, index) in planStops"
                :key="`${stop.planName}-${stop.value}`"
                class="group cursor-pointer"
                :class="{ 'sm:col-span-2': stop.startingOut }"
                :data-test="stop.startingOut ? 'onboarding-ai-plan-starting-out' : 'onboarding-ai-plan-option'"
              >
                <input v-model="planIndex" type="radio" name="ai-onboarding-plan" class="peer sr-only" :value="index">
                <span
                  class="flex min-h-16 items-center justify-between gap-3 rounded-xl border p-3 text-left transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:peer-focus-visible:ring-offset-slate-900"
                  :class="planIndex === index
                    ? 'border-primary-500 bg-slate-100 text-slate-950 ring-2 ring-primary-500/15 dark:border-primary-500/80 dark:bg-primary-500/25 dark:text-white dark:ring-primary-500/30'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:bg-slate-900'"
                >
                  <span class="min-w-0">
                    <span class="block text-sm font-semibold">{{ planTitle(index) }}</span>
                    <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">{{ t('organization-onboarding-plan-match') }}: {{ stop.planName }}</span>
                  </span>
                  <span
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition"
                    :class="planIndex === index ? 'border-primary-500 bg-primary-500 text-white' : 'border-slate-300 bg-white text-transparent group-hover:border-slate-400 dark:border-white/20 dark:bg-slate-900'"
                    aria-hidden="true"
                  >
                    <IconCheck class="h-3.5 w-3.5" />
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div>
            <label for="ai-onboarding-org-name" class="text-sm font-medium text-slate-800 dark:text-slate-200">
              {{ t('ai-onboarding-org-name-label') }}
            </label>
            <input
              id="ai-onboarding-org-name"
              v-model="orgName"
              type="text"
              minlength="3"
              maxlength="80"
              autocomplete="organization"
              class="d-input mt-2 w-full rounded-xl border-slate-300 bg-white text-slate-950 dark:border-white/15 dark:bg-slate-950 dark:text-white"
              data-test="onboarding-ai-org-name"
            >
            <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {{ defaultOrgName ? t('ai-onboarding-org-name-help') : t('ai-onboarding-org-name-help-new') }}
            </p>
          </div>

          <BillingRegionChoice v-model="billingAccount" />

          <div class="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between dark:border-white/15">
            <button type="button" class="d-btn min-h-12" :class="onboardingSecondaryButtonClass" :disabled="isCreating" data-test="onboarding-ai-plan-back" @click="screen = 'choice'">
              {{ t('button-back') }}
            </button>
            <button type="submit" class="d-btn min-h-12" :class="onboardingPrimaryButtonClass" :disabled="!canCreate" data-test="onboarding-ai-create-org">
              <IconLoader v-if="isCreating" class="h-4 w-4 animate-spin" />
              {{ isInvite ? t('invite-onboarding-create-org') : t('ai-onboarding-create-org') }}
              <IconArrowRight v-if="!isCreating" class="h-4 w-4" />
            </button>
          </div>
        </div>
      </form>
    </div>
  </section>
</template>
