<script setup lang="ts">
import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '~/utils/onboardingChannelAnalytics'
import type { ChecklistTaskListMode } from '~/utils/onboardingSetupMode'
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconCircle from '~icons/lucide/circle'
import IconFileText from '~icons/lucide/file-text'
import IconInfo from '~icons/lucide/info'
import IconLoader from '~icons/lucide/loader-2'
import IconMinus from '~icons/lucide/minus'
import { useAppOnboardingCliProgress } from '~/composables/useAppOnboardingCliProgress'
import { getAppOnboardingStepIds, hasSupportedOtaTodoList, isOpenOnboardingStepStatus } from '~/services/appOnboarding'
import { isAppOnboardingChecklistStep } from '~/utils/appOnboardingChecklist'
import { APP_ONBOARDING_STEP_GUIDES } from '~/utils/appOnboardingGuides'
import { hasDualOnboardingChecklists } from '~/utils/dualOnboardingChecklists'
import { initialChecklistOpen } from '~/utils/onboardingSetupMode'
import { skipOnboardingStep } from '~/utils/onboardingSkipStep'
import AppOnboardingAiButton from './AppOnboardingAiButton.vue'
import AppOnboardingSkipStep from './AppOnboardingSkipStep.vue'
import ChannelSetupOnboardingDialog from './ChannelSetupOnboardingDialog.vue'
import TechnicalTeammateInviteCard from './TechnicalTeammateInviteCard.vue'

const props = withDefaults(defineProps<{
  appId: string
  initialOnboarding?: unknown
  command: string
  hiding: boolean
  leaving: boolean
  active?: boolean
  hideFooter?: boolean
  completionAction?: string
  /** hidden: one next step, no counts or list. open: list expanded (AI setup). */
  taskList?: ChecklistTaskListMode
}>(), { active: true, taskList: 'default' })

const emit = defineEmits<{
  copyCommand: []
  copyAi: [placement?: 'checklist']
  hide: []
  explore: []
  complete: []
  inviteOpened: []
  inviteSucceeded: [invite: { email: string, firstName: string, lastName: string }]
  channelAnalytics: [event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties]
  snapshot: [onboarding: unknown, hasChannel: boolean | null]
}>()

const { t } = useI18n()
const panelId = useId()
const { onboarding, rawOnboarding, hasChannel, refreshError, refreshOnboarding, applyOnboarding } = useAppOnboardingCliProgress(() => props.appId, () => props.initialOnboarding, () => props.active !== false)
watch([rawOnboarding, hasChannel], ([value, observedChannel]) => emit('snapshot', value, observedChannel))
const steps = computed(() => getAppOnboardingStepIds(onboarding.value.todo_list_version, onboarding.value.ota_todo_list_version).filter(isAppOnboardingChecklistStep).map((id, index) => ({
  id,
  index,
  status: onboarding.value.steps[id]?.status,
  title: t(`setup-checklist-step-${id}`),
  description: t(`setup-checklist-description-${id}`),
})))
const doneCount = computed(() => steps.value.filter(step => step.status === 'done' || step.status === 'skipped').length)
const currentStep = computed(() => steps.value.find(step => step.status !== 'done' && step.status !== 'skipped'))
const selectedId = ref<string | null>(null)
const selectedStep = computed(() => steps.value.find(step => step.id === selectedId.value) ?? currentStep.value ?? steps.value.at(-1)!)
const isSelectedCurrent = computed(() => selectedStep.value.id === currentStep.value?.id)
// v3/v4 live-update checklist: any open step can be skipped with a reason.
const canSkipSelected = computed(() => hasSupportedOtaTodoList(onboarding.value) && isOpenOnboardingStepStatus(selectedStep.value.status))
const skipping = ref(false)
const isFirstStep = computed(() => selectedStep.value.index === 0)
const guideHref = computed(() => APP_ONBOARDING_STEP_GUIDES[selectedStep.value.id])
const guideLabel = computed(() => isFirstStep.value ? t('setup-checklist-manual-guide') : t('setup-checklist-task-guide', { task: selectedStep.value.title }))
const waitingMessageKey = computed(() => {
  if (isFirstStep.value)
    return 'setup-checklist-waiting-start'
  if (['add_channel', 'run_device', 'upload_bundle', 'test_update'].includes(selectedStep.value.id))
    return `setup-checklist-waiting-${selectedStep.value.id}`
  return 'setup-checklist-waiting-step'
})
const selectedStatusText = computed(() => {
  if (refreshError.value)
    return t('setup-checklist-refresh-error')
  const status = selectedStep.value.status
  if (status === 'done' || status === 'skipped')
    return statusLabel(status)
  if (isSelectedCurrent.value || selectedStep.value.id === 'add_channel')
    return t(waitingMessageKey.value)
  return t('setup-checklist-future-task')
})
const completed = computed(() => (steps.value.length > 0 && doneCount.value === steps.value.length)
  || (!hasDualOnboardingChecklists(rawOnboarding.value) && onboarding.value.outcome === 'completed'))
// Every step is shown by default on wide screens; new manual signups only see their next step.
const checklistOpen = ref(initialChecklistOpen(props.taskList, typeof window === 'undefined' || window.matchMedia('(min-width: 1024px)').matches))
const showTaskList = computed(() => props.taskList !== 'hidden')
const channelFlowOpen = ref(false)

watch(() => props.appId, () => {
  channelFlowOpen.value = false
})

function closeChannelFlow() {
  channelFlowOpen.value = false
  void refreshOnboarding()
}

function trackChannelEvent(event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) {
  emit('channelAnalytics', event, properties)
}

watch(() => currentStep.value?.id, (id, previous) => {
  if (selectedId.value === null || selectedId.value === previous)
    selectedId.value = id ?? null
}, { immediate: true })

function selectStep(id: string) {
  selectedId.value = id
  // AI setup keeps the list open so the agent's progress stays visible.
  if (props.taskList !== 'open')
    checklistOpen.value = false
}

async function skipSelectedStep(reason: string) {
  const id = selectedStep.value.id
  const appId = props.appId
  skipping.value = true
  try {
    const value = await skipOnboardingStep(appId, `ota.${id}`, reason)
    if (appId !== props.appId)
      return
    if (value === undefined)
      void refreshOnboarding()
    else
      applyOnboarding(value)
    // Fall back to the next open task, unless the user picked another one meanwhile.
    if (selectedStep.value.id === id)
      selectedId.value = null
  }
  catch (error) {
    console.error('Cannot skip onboarding step', error)
    toast.error(t('setup-checklist-skip-step-error'))
  }
  finally {
    skipping.value = false
  }
}

function statusLabel(status: string | undefined) {
  if (status === 'done')
    return t('app-onboarding-cli-step-done')
  if (status === 'skipped')
    return t('app-onboarding-cli-step-skipped')
  return t('app-onboarding-cli-step-pending')
}
</script>

<template>
  <div class="mx-auto max-w-[1080px] space-y-3" data-test="onboarding-setup-cli">
    <header class="space-y-2">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 class="text-xl font-semibold tracking-tight text-slate-950 dark:text-white">
          {{ t('setup-checklist-title') }}
        </h1>
        <p v-if="showTaskList" class="text-sm font-medium text-slate-700 dark:text-slate-200" data-test="setup-checklist-progress" aria-live="polite" aria-atomic="true">
          {{ t('setup-checklist-progress', { done: doneCount, total: steps.length }) }}
        </p>
      </div>
      <progress
        v-if="showTaskList"
        class="d-progress h-1.5 w-full text-primary-500"
        :value="doneCount"
        :max="steps.length"
        :aria-label="t('setup-checklist-progress', { done: doneCount, total: steps.length })"
      />
    </header>

    <div class="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-white/15 dark:bg-slate-900" :class="{ 'lg:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)]': checklistOpen && showTaskList }">
      <nav v-if="showTaskList" class="border-b border-slate-200 px-3 py-2 sm:px-4 dark:border-white/15" :class="{ 'lg:border-b-0 lg:border-r': checklistOpen }" :aria-label="t('setup-checklist-list-title')">
        <!-- Show every step by default; users can hide the list. -->
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-950 dark:text-white">
            {{ t('setup-checklist-list-title') }}
          </h2>
          <button
            type="button"
            class="d-btn d-btn-ghost h-8 min-h-8 px-2 text-sm text-sky-700 dark:text-azure-300"
            :aria-expanded="checklistOpen"
            :aria-controls="`${panelId}-list`"
            data-test="setup-checklist-toggle"
            @click="checklistOpen = !checklistOpen"
          >
            {{ checklistOpen ? t('setup-checklist-hide-steps') : t('setup-checklist-show-steps', { total: steps.length }) }}
            <IconChevronDown class="h-4 w-4 shrink-0" :class="{ 'rotate-180': checklistOpen }" aria-hidden="true" />
          </button>
        </div>

        <ol :id="`${panelId}-list`" class="mt-1" :class="checklistOpen ? 'block' : 'hidden'">
          <li
            v-for="step in steps"
            :key="step.id"
            class="border-b border-slate-100 last:border-b-0 dark:border-white/10"
            :data-test="`app-onboarding-cli-step-${step.id}`"
            :data-status="step.status ?? 'pending'"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-inset"
              :class="selectedStep.id === step.id ? 'bg-azure-500/5 text-primary-500 dark:bg-azure-500/10 dark:text-azure-300' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5'"
              :aria-current="currentStep?.id === step.id ? 'step' : undefined"
              :aria-label="t('setup-checklist-view-task', { task: step.title, status: statusLabel(step.status) })"
              :aria-controls="panelId"
              @click="selectStep(step.id)"
            >
              <IconCheck v-if="step.status === 'done'" class="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" :aria-label="statusLabel(step.status)" />
              <IconMinus v-else-if="step.status === 'skipped'" class="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" :aria-label="statusLabel(step.status)" />
              <IconCircle v-else class="h-4 w-4 shrink-0" :class="currentStep?.id === step.id ? 'text-azure-500' : 'text-slate-300 dark:text-slate-600'" :aria-label="statusLabel(step.status)" />
              <span class="w-4 shrink-0 text-xs text-slate-400 dark:text-slate-500" aria-hidden="true">{{ step.index + 1 }}.</span>
              <span class="min-w-0 flex-1 text-sm leading-5" :class="{ 'font-medium': selectedStep.id === step.id }">
                {{ step.title }}
              </span>
            </button>
          </li>
        </ol>
        <div v-if="checklistOpen" class="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-slate-100 px-2 py-2 dark:border-white/10" data-test="setup-checklist-cicd-step">
          <p class="min-w-0 text-sm leading-5 text-slate-600 dark:text-slate-300">
            <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('setup-checklist-optional-next-step') }}</span>
            <span class="mx-1 text-slate-300 dark:text-slate-600" aria-hidden="true">·</span>
            <span class="font-medium text-slate-800 dark:text-slate-200">{{ t('setup-checklist-cicd-title') }}</span>
          </p>
          <a href="https://capgo.app/docs/getting-started/cicd-integration/" target="_blank" rel="noopener noreferrer" class="inline-flex min-h-8 shrink-0 items-center gap-1.5 text-sm font-medium text-sky-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 dark:text-azure-300">
            <IconFileText class="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{{ t('setup-checklist-cicd-guide') }}</span>
          </a>
        </div>
      </nav>

      <div :id="panelId" class="flex min-w-0 flex-col px-4 py-3 sm:px-5" data-test="setup-checklist-instructions">
        <template v-if="completed">
          <IconCheck class="mb-3 h-6 w-6 text-emerald-600" aria-hidden="true" />
          <h2 class="text-xl font-semibold text-slate-950 dark:text-white">
            {{ t('setup-checklist-complete-title') }}
          </h2>
          <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('setup-checklist-complete-description') }}
          </p>
          <button type="button" class="d-btn mt-4 min-h-11 self-start border-primary-500 bg-primary-500 text-white hover:border-primary-500 hover:bg-primary-500/90" :disabled="hiding || leaving" @click="emit('complete')">
            {{ completionAction || t('setup-checklist-open-app') }}
            <IconArrowRight class="h-4 w-4" aria-hidden="true" />
          </button>
        </template>
        <template v-else>
          <p class="text-sm font-medium text-sky-700 dark:text-azure-400">
            {{ showTaskList ? t(isSelectedCurrent ? 'setup-checklist-current-task-number' : 'setup-checklist-task-number', { number: selectedStep.index + 1, total: steps.length }) : t('setup-checklist-next-step') }}
          </p>
          <h2 class="mt-1 text-lg font-semibold leading-tight text-slate-950 dark:text-white">
            {{ selectedStep.title }}
          </h2>
          <p class="mt-2 max-w-prose text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ selectedStep.description }}
          </p>

          <template v-if="isFirstStep">
            <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('setup-checklist-command-location') }}
            </p>
            <button
              v-if="command"
              type="button"
              class="d-btn group relative mt-3 h-auto min-h-0 w-full justify-start whitespace-normal rounded-xl border-0 bg-slate-950 p-3 pr-12 text-left font-normal hover:bg-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
              data-test="app-onboarding-command-copy"
              :aria-label="t('app-onboarding-command-copy')"
              @click="emit('copyCommand')"
            >
              <code class="block whitespace-pre-wrap break-all text-sm leading-6 text-sky-200">{{ command }}</code>
              <IconCopy class="absolute right-3 top-3 h-4 w-4 text-slate-400 group-hover:text-white" aria-hidden="true" />
            </button>
            <output v-else class="mt-3 block rounded-xl bg-slate-950 p-3 text-sm text-slate-300">
              {{ t('app-onboarding-command-apikey-loading') }}
            </output>
            <div class="mt-3 flex flex-wrap gap-2" data-test="setup-checklist-start-actions">
              <button type="button" class="d-btn h-auto min-h-11 border-primary-500 bg-primary-500 px-3 py-2 text-sm text-white hover:border-primary-500 hover:bg-primary-500/90 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2" data-test="setup-checklist-copy-command" :disabled="!command" @click="emit('copyCommand')">
                <IconCopy class="h-4 w-4 shrink-0" aria-hidden="true" />
                {{ t('setup-checklist-copy-command') }}
              </button>
            </div>
          </template>
          <button
            v-if="selectedStep.id === 'add_channel' && selectedStep.status !== 'done'"
            type="button"
            class="d-btn mt-3 min-h-11 self-start border-primary-500 bg-primary-500 px-4 text-sm text-white hover:border-primary-500 hover:bg-primary-500/90"
            data-test="setup-checklist-create-channel"
            @click="channelFlowOpen = true"
          >
            {{ t('setup-checklist-step-add_channel') }}
            <IconArrowRight class="h-4 w-4" aria-hidden="true" />
          </button>
          <p v-if="selectedStep.id === 'add_channel' && selectedStep.status !== 'done'" class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            {{ t('setup-checklist-channel-detection') }}
          </p>

          <output class="mt-3 flex items-start gap-2 text-sm leading-5 text-slate-600 dark:text-slate-300" aria-live="polite" aria-atomic="true">
            <IconInfo v-if="refreshError" class="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <IconCheck v-else-if="selectedStep.status === 'done'" class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            <IconMinus v-else-if="selectedStep.status === 'skipped'" class="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <IconLoader v-else-if="isSelectedCurrent || selectedStep.id === 'add_channel'" class="mt-0.5 h-4 w-4 shrink-0 text-slate-400 motion-safe:animate-spin" aria-hidden="true" />
            <IconCircle v-else class="mt-0.5 h-4 w-4 shrink-0 text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <span class="font-medium text-slate-800 dark:text-slate-200">{{ selectedStatusText }}</span>
          </output>
          <button v-if="refreshError" type="button" class="d-btn d-btn-ghost mt-1 min-h-11 self-start text-sky-700 dark:text-azure-300" @click="refreshOnboarding">
            {{ t('setup-checklist-retry') }}
          </button>

          <AppOnboardingSkipStep v-if="canSkipSelected" :key="selectedStep.id" test-id="setup-checklist" :skipping="skipping" @skip="skipSelectedStep" />

          <div class="mt-3 flex flex-wrap items-stretch gap-2" data-test="setup-checklist-task-actions">
            <AppOnboardingAiButton @copy="emit('copyAi', isFirstStep ? undefined : 'checklist')" />
            <button v-if="!isSelectedCurrent && currentStep" type="button" class="d-btn d-btn-ghost h-auto min-h-11 gap-2 rounded-lg border-slate-200 bg-transparent px-3 py-2 text-sm font-medium text-slate-600 shadow-none hover:border-slate-300 hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:border-white/15 dark:text-slate-300 dark:hover:border-white/25 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:ring-offset-slate-900 min-w-0 max-w-full shrink whitespace-normal" @click="selectStep(currentStep.id)">
              {{ t('setup-checklist-return-current') }}
            </button>
            <a :href="guideHref" target="_blank" rel="noopener noreferrer" class="d-btn d-btn-ghost h-auto min-h-11 gap-2 rounded-lg border-slate-200 bg-transparent px-3 py-2 text-sm font-medium text-slate-600 shadow-none hover:border-slate-300 hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:border-white/15 dark:text-slate-300 dark:hover:border-white/25 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:ring-offset-slate-900 min-w-0 max-w-full text-left whitespace-normal" data-test="setup-checklist-manual-guide">
              <IconFileText class="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{{ guideLabel }}</span>
            </a>
          </div>
        </template>
      </div>
    </div>

    <div v-if="!completed || !hideFooter" class="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between dark:border-white/15 dark:bg-slate-900" :data-test="completed ? undefined : 'setup-checklist-handoff'">
      <TechnicalTeammateInviteCard
        v-if="!completed"
        handoff
        analytics-channel="onboarding-v3"
        :show-manual-setup-link="false"
        :tracking-version="3"
        @opened="emit('inviteOpened')"
        @success="emit('inviteSucceeded', $event)"
      />
      <footer v-if="!hideFooter" class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          class="d-btn min-h-11 shrink-0 border-slate-300 bg-white px-3 text-sm text-slate-700 hover:border-slate-400 hover:bg-slate-50 dark:border-white/20 dark:bg-slate-900 dark:text-slate-200"
          data-test="app-onboarding-dont-show-again"
          :title="t('setup-checklist-hide-description')"
          :disabled="hiding || leaving"
          @click="emit('hide')"
        >
          <IconLoader v-if="hiding" class="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
          {{ t('app-onboarding-dont-show-again') }}
        </button>
        <p class="sr-only">{{ t('setup-checklist-hide-description') }}</p>
        <button
          v-if="!completed"
          type="button"
          class="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-sm text-sm font-medium text-slate-600 underline-offset-4 outline-none hover:text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-azure-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:hover:text-white"
          data-test="setup-checklist-explore-dashboard"
          :disabled="hiding || leaving"
          @click="emit('explore')"
        >
          {{ t('setup-checklist-explore-dashboard') }}
          <IconArrowRight class="h-4 w-4" aria-hidden="true" />
        </button>
      </footer>
    </div>

    <ChannelSetupOnboardingDialog
      v-if="channelFlowOpen"
      :key="appId"
      :app-id="appId"
      @analytics="trackChannelEvent"
      @close="closeChannelFlow"
      @complete="closeChannelFlow"
    />
  </div>
</template>
