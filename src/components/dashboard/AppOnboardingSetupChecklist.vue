<script setup lang="ts">
import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '~/utils/onboardingChannelAnalytics'
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconCopy from '~icons/ion/copy-outline'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconCircle from '~icons/lucide/circle'
import IconFileText from '~icons/lucide/file-text'
import IconInfo from '~icons/lucide/info'
import IconLoader from '~icons/lucide/loader-2'
import IconMessageCircle from '~icons/lucide/message-circle'
import IconMinus from '~icons/lucide/minus'
import { useAppOnboardingCliProgress } from '~/composables/useAppOnboardingCliProgress'
import { getAppOnboardingStepIds } from '~/services/appOnboarding'
import { isAppOnboardingChecklistStep } from '~/utils/appOnboardingChecklist'
import { APP_ONBOARDING_STEP_GUIDES } from '~/utils/appOnboardingGuides'
import ChannelSetupOnboardingDialog from './ChannelSetupOnboardingDialog.vue'
import TechnicalTeammateInviteCard from './TechnicalTeammateInviteCard.vue'

const props = defineProps<{
  appId: string
  initialOnboarding?: unknown
  command: string
  hiding: boolean
  leaving: boolean
}>()

const emit = defineEmits<{
  copyCommand: []
  copyAi: []
  hide: []
  explore: []
  complete: []
  inviteOpened: []
  inviteSucceeded: [invite: { email: string, firstName: string, lastName: string }]
  channelAnalytics: [event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties]
}>()

const { t } = useI18n()
const panelId = useId()
const { onboarding, refreshError, refreshOnboarding } = useAppOnboardingCliProgress(() => props.appId, () => props.initialOnboarding)
const steps = computed(() => getAppOnboardingStepIds(onboarding.value.todo_list_version).filter(isAppOnboardingChecklistStep).map((id, index) => ({
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
const completed = computed(() => onboarding.value.outcome === 'completed')
const checklistOpen = ref(false)
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
  checklistOpen.value = false
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
  <div class="mx-auto max-w-[1080px] space-y-6" data-test="onboarding-setup-cli">
    <header>
      <p class="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
        <span>{{ t('setup-checklist-app-created') }}</span>
        <IconArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
        <span class="font-medium text-slate-800 dark:text-slate-200">{{ t('setup-checklist-breadcrumb') }}</span>
      </p>
      <h1 class="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl dark:text-white">
        {{ t('setup-checklist-title') }}
      </h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-slate-600 dark:text-slate-300">
        {{ t('setup-checklist-subtitle') }}
      </p>
    </header>

    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6" data-test="setup-checklist-progress">
      <p class="shrink-0 text-sm font-medium text-slate-800 dark:text-slate-200" aria-live="polite" aria-atomic="true">
        {{ t('setup-checklist-progress', { done: doneCount, total: steps.length }) }}
      </p>
      <progress
        class="d-progress h-2.5 w-full text-primary-500"
        :value="doneCount"
        :max="steps.length"
        :aria-label="t('setup-checklist-progress', { done: doneCount, total: steps.length })"
      />
    </div>

    <div class="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)] dark:border-white/15 dark:bg-slate-900">
      <nav class="border-b border-slate-200 p-4 sm:p-6 lg:border-b-0 lg:border-r dark:border-white/15" :aria-label="t('setup-checklist-list-title')">
        <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
          {{ t('setup-checklist-list-title') }}
        </h2>
        <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
          {{ t('setup-checklist-list-subtitle') }}
        </p>

        <button
          type="button"
          class="d-btn d-btn-ghost mt-3 h-auto min-h-11 w-full justify-between px-0 text-left lg:hidden"
          :aria-expanded="checklistOpen"
          :aria-controls="`${panelId}-list`"
          data-test="setup-checklist-mobile-toggle"
          @click="checklistOpen = !checklistOpen"
        >
          <span class="min-w-0 text-sm">{{ selectedStep.index + 1 }}. {{ selectedStep.title }}</span>
          <IconChevronDown class="h-4 w-4 shrink-0" :class="{ 'rotate-180': checklistOpen }" aria-hidden="true" />
        </button>

        <ol :id="`${panelId}-list`" class="mt-4 lg:block" :class="checklistOpen ? 'block' : 'hidden'">
          <li
            v-for="step in steps"
            :key="step.id"
            class="border-b border-slate-100 last:border-b-0 dark:border-white/10"
            :data-test="`app-onboarding-cli-step-${step.id}`"
            :data-status="step.status ?? 'pending'"
          >
            <button
              type="button"
              class="flex min-h-14 w-full items-start gap-3 rounded-xl px-3 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-inset"
              :class="selectedStep.id === step.id ? 'bg-azure-500/5 text-primary-500 dark:bg-azure-500/10 dark:text-azure-300' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5'"
              :aria-current="currentStep?.id === step.id ? 'step' : undefined"
              :aria-label="t('setup-checklist-view-task', { task: step.title, status: statusLabel(step.status) })"
              :aria-controls="panelId"
              @click="selectStep(step.id)"
            >
              <IconCheck v-if="step.status === 'done'" class="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" :aria-label="statusLabel(step.status)" />
              <IconMinus v-else-if="step.status === 'skipped'" class="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" :aria-label="statusLabel(step.status)" />
              <IconCircle v-else class="mt-0.5 h-5 w-5 shrink-0" :class="currentStep?.id === step.id ? 'text-azure-500' : 'text-slate-300 dark:text-slate-600'" :aria-label="statusLabel(step.status)" />
              <span class="mt-0.5 shrink-0 text-xs text-slate-400 dark:text-slate-500" aria-hidden="true">{{ step.index + 1 }}.</span>
              <span class="min-w-0 flex-1 text-base leading-6" :class="{ 'font-medium': selectedStep.id === step.id }">
                {{ step.title }}
                <span v-if="currentStep?.id === step.id" class="mt-2 block w-fit rounded-md bg-azure-500/10 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-azure-500/15 dark:text-azure-300">{{ t('setup-checklist-current-task') }}</span>
              </span>
            </button>
          </li>
        </ol>
      </nav>

      <div :id="panelId" class="flex min-w-0 flex-col px-5 py-6 sm:p-8" data-test="setup-checklist-instructions">
        <template v-if="completed">
          <IconCheck class="mb-4 h-8 w-8 text-emerald-600" aria-hidden="true" />
          <h2 class="text-2xl font-semibold text-slate-950 dark:text-white">
            {{ t('setup-checklist-complete-title') }}
          </h2>
          <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('setup-checklist-complete-description') }}
          </p>
          <button type="button" class="d-btn mt-6 min-h-12 self-start border-primary-500 bg-primary-500 text-white hover:border-primary-600 hover:bg-primary-600" :disabled="hiding || leaving" @click="emit('complete')">
            {{ t('setup-checklist-open-app') }}
            <IconArrowRight class="h-4 w-4" aria-hidden="true" />
          </button>
        </template>
        <template v-else>
          <p class="text-sm font-medium text-sky-700 dark:text-azure-400">
            {{ isSelectedCurrent ? t('setup-checklist-current-task') : t('setup-checklist-task-number', { number: selectedStep.index + 1, total: steps.length }) }}
          </p>
          <h2 class="mt-3 text-2xl font-semibold leading-tight text-slate-950 sm:text-3xl dark:text-white">
            {{ selectedStep.title }}
          </h2>
          <p class="mt-4 max-w-prose text-base leading-7 text-slate-600 dark:text-slate-300">
            {{ selectedStep.description }}
          </p>

          <template v-if="isFirstStep">
            <p class="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('setup-checklist-command-location') }}
            </p>
            <button
              v-if="command"
              type="button"
              class="d-btn group relative mt-5 h-auto min-h-0 w-full justify-start whitespace-normal rounded-2xl border-0 bg-slate-950 p-5 pr-14 text-left font-normal hover:bg-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
              data-test="app-onboarding-command-copy"
              :aria-label="t('app-onboarding-command-copy')"
              @click="emit('copyCommand')"
            >
              <code class="block whitespace-pre-wrap break-all text-sm leading-6 text-sky-200">{{ command }}</code>
              <IconCopy class="absolute right-4 top-5 h-5 w-5 text-slate-400 group-hover:text-white" aria-hidden="true" />
            </button>
            <output v-else class="mt-5 block rounded-2xl bg-slate-950 p-5 text-sm text-slate-300">
              {{ t('app-onboarding-command-apikey-loading') }}
            </output>
            <div class="mt-5 grid gap-3 sm:grid-cols-2" data-test="setup-checklist-start-actions">
              <button type="button" class="d-btn h-auto min-h-14 border-primary-500 bg-primary-500 px-3 py-3 text-base text-white hover:border-primary-600 hover:bg-primary-600 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2" data-test="setup-checklist-copy-command" :disabled="!command" @click="emit('copyCommand')">
                <IconCopy class="h-4 w-4 shrink-0" aria-hidden="true" />
                {{ t('setup-checklist-copy-command') }}
              </button>
              <button type="button" class="d-btn h-auto min-h-14 border-azure-500 bg-white px-3 py-3 text-base text-sky-700 hover:border-azure-600 hover:bg-azure-500/5 focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:bg-slate-900 dark:text-azure-300 dark:hover:bg-azure-500/10" data-test="setup-checklist-copy-ai" @click="emit('copyAi')">
                <IconMessageCircle class="h-5 w-5 shrink-0" aria-hidden="true" />
                {{ t('setup-checklist-ai-action') }}
              </button>
            </div>
            <p class="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
              {{ t('setup-checklist-ai-description') }}
            </p>
          </template>
          <button
            v-if="selectedStep.id === 'add_channel' && selectedStep.status !== 'done'"
            type="button"
            class="d-btn mt-5 min-h-12 self-start border-primary-500 bg-primary-500 px-5 text-base text-white hover:border-primary-600 hover:bg-primary-600"
            data-test="setup-checklist-create-channel"
            @click="channelFlowOpen = true"
          >
            {{ t('setup-checklist-step-add_channel') }}
            <IconArrowRight class="h-4 w-4" aria-hidden="true" />
          </button>
          <p v-if="!isFirstStep && (selectedStep.id !== 'add_channel' || selectedStep.status !== 'done')" class="mt-5 flex items-start gap-3 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600 dark:bg-slate-950/60 dark:text-slate-300">
            <IconInfo class="mt-0.5 h-4 w-4 shrink-0 text-azure-500" aria-hidden="true" />
            {{ t(selectedStep.id === 'add_channel' ? 'setup-checklist-channel-detection' : 'setup-checklist-follow-terminal') }}
          </p>

          <output class="mt-7 block border-t border-slate-200 py-5 dark:border-white/15" aria-live="polite" aria-atomic="true">
            <span class="flex items-start gap-3 text-sm font-medium text-slate-800 dark:text-slate-200">
              <IconInfo v-if="refreshError" class="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
              <IconCheck v-else-if="selectedStep.status === 'done'" class="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
              <IconMinus v-else-if="selectedStep.status === 'skipped'" class="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
              <IconLoader v-else class="mt-0.5 h-5 w-5 shrink-0 text-slate-400 motion-safe:animate-spin" aria-hidden="true" />
              <span>{{ refreshError ? t('setup-checklist-refresh-error') : selectedStep.status ? statusLabel(selectedStep.status) : isSelectedCurrent || selectedStep.id === 'add_channel' ? t(waitingMessageKey) : t('setup-checklist-future-task') }}</span>
            </span>
            <span class="mt-2 block pl-8 text-sm leading-6 text-slate-500 dark:text-slate-400">
              {{ t('setup-checklist-auto-progress') }}
            </span>
            <button v-if="refreshError" type="button" class="d-btn d-btn-ghost mt-2 min-h-11 text-sky-700 dark:text-azure-300" @click="refreshOnboarding">
              {{ t('setup-checklist-retry') }}
            </button>
          </output>

          <button v-if="!isSelectedCurrent && currentStep" type="button" class="d-btn d-btn-ghost mt-4 min-h-11 self-start text-sky-700 dark:text-azure-300" @click="selectStep(currentStep.id)">
            {{ t('setup-checklist-return-current') }}
            <IconArrowRight class="h-4 w-4" aria-hidden="true" />
          </button>

          <a :href="guideHref" target="_blank" rel="noopener noreferrer" class="mt-auto inline-flex min-h-11 max-w-full items-center gap-2 self-start rounded-sm text-left font-normal text-sky-700 underline-offset-4 outline-none hover:text-sky-800 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-azure-500 dark:text-azure-300 dark:hover:text-azure-200" data-test="setup-checklist-manual-guide">
            <IconFileText class="h-5 w-5 shrink-0" aria-hidden="true" />
            {{ guideLabel }}
            <IconArrowRight class="h-4 w-4 shrink-0" aria-hidden="true" />
          </a>
        </template>
      </div>
    </div>

    <div v-if="!completed" class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:px-6 dark:border-white/15 dark:bg-slate-900" data-test="setup-checklist-handoff">
      <TechnicalTeammateInviteCard
        handoff
        analytics-channel="onboarding-v3"
        :show-manual-setup-link="false"
        :tracking-version="3"
        @opened="emit('inviteOpened')"
        @success="emit('inviteSucceeded', $event)"
      />
    </div>

    <footer class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
      <button
        type="button"
        class="d-btn min-h-12 shrink-0 border-slate-300 bg-white px-4 text-slate-700 hover:border-slate-400 hover:bg-slate-50 dark:border-white/20 dark:bg-slate-900 dark:text-slate-200"
        data-test="app-onboarding-dont-show-again"
        :disabled="hiding || leaving"
        @click="emit('hide')"
      >
        <IconLoader v-if="hiding" class="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
        {{ t('app-onboarding-dont-show-again') }}
      </button>
      <p class="max-w-prose text-sm leading-6 text-slate-500 sm:border-l sm:border-slate-200 sm:pl-5 dark:text-slate-400 dark:sm:border-white/15">
        {{ t('setup-checklist-hide-description') }}
      </p>
      <button
        v-if="!completed"
        type="button"
        class="mr-5 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-sm text-sm font-medium text-slate-600 underline-offset-4 outline-none hover:text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-azure-500 disabled:cursor-not-allowed disabled:opacity-50 sm:ml-auto sm:mr-6 dark:text-slate-300 dark:hover:text-white"
        data-test="setup-checklist-explore-dashboard"
        :disabled="hiding || leaving"
        @click="emit('explore')"
      >
        {{ t('setup-checklist-explore-dashboard') }}
        <IconArrowRight class="h-4 w-4" aria-hidden="true" />
      </button>
    </footer>

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
