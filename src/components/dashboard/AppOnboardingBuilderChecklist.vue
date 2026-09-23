<script setup lang="ts">
import type { BuilderPlatform, BuilderStepId } from '~/services/builderOnboardingChecklist'
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconCopy from '~icons/ion/copy-outline'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconFileText from '~icons/lucide/file-text'
import IconInfo from '~icons/lucide/info'
import IconLoader from '~icons/lucide/loader-2'
import IconAndroid from '~icons/mdi/android'
import IconApple from '~icons/mdi/apple'
import { parseBuilderOnboardingChecklist } from '~/services/builderOnboardingChecklist'

const props = defineProps<{
  initialOnboarding?: unknown
  command: string
  hiding: boolean
  leaving: boolean
}>()

const emit = defineEmits<{
  copyCommand: [platform: BuilderPlatform]
  hide: []
  explore: []
}>()

const { t } = useI18n()
const panelId = useId()
const checklist = computed(() => parseBuilderOnboardingChecklist(props.initialOnboarding))
const viewedPlatform = ref<BuilderPlatform | null>(checklist.value.selectedPlatform)
const selectedIds = ref<Record<BuilderPlatform, BuilderStepId | null>>({
  ios: null,
  android: null,
})

const steps = computed(() => {
  const platform = viewedPlatform.value
  if (!platform)
    return []

  return checklist.value.stepIds[platform].map((id, index) => ({
    id,
    index,
    title: t(`builder-checklist-${platform}-${id}-title`),
    description: t(`builder-checklist-${platform}-${id}-description`),
  }))
})
const selectedStep = computed(() => {
  const platform = viewedPlatform.value
  if (!platform)
    return undefined
  return steps.value.find(step => step.id === selectedIds.value[platform]) ?? steps.value[0]
})
const isFirstStep = computed(() => selectedStep.value?.index === 0)
const platformCommand = computed(() => viewedPlatform.value && props.command ? `${props.command} --platform ${viewedPlatform.value}` : '')
const guideHref = computed(() => viewedPlatform.value ? `https://capgo.app/docs/cli/cloud-build/${viewedPlatform.value}/` : '')

watch(() => props.initialOnboarding, (value) => {
  const selectedPlatform = parseBuilderOnboardingChecklist(value).selectedPlatform
  if (selectedPlatform)
    viewedPlatform.value = selectedPlatform
})

function selectPlatform(platform: BuilderPlatform) {
  viewedPlatform.value = platform
}

function selectStep(id: BuilderStepId) {
  const platform = viewedPlatform.value
  if (platform)
    selectedIds.value[platform] = id
}

function copyCommand() {
  const platform = viewedPlatform.value
  if (platform)
    emit('copyCommand', platform)
}
</script>

<template>
  <div class="mx-auto max-w-[1080px] space-y-6" data-test="builder-checklist">
    <header>
      <p class="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
        <span>{{ t('setup-checklist-app-created') }}</span>
        <IconArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
        <span class="font-medium text-slate-800 dark:text-slate-200">{{ t('builder-checklist-breadcrumb') }}</span>
      </p>
      <h1 class="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl dark:text-white">
        {{ t('builder-checklist-title') }}
      </h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-slate-600 dark:text-slate-300">
        {{ t('builder-checklist-subtitle') }}
      </p>
    </header>

    <section aria-labelledby="builder-platform-title" class="space-y-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="builder-platform-title" class="text-base font-semibold text-slate-950 dark:text-white">
          {{ t('builder-checklist-platform-title') }}
        </h2>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          {{ t('builder-checklist-platform-helper') }}
        </p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2" data-test="builder-checklist-platforms">
        <button
          v-for="platform in (['ios', 'android'] as const)"
          :key="platform"
          type="button"
          class="flex min-h-20 items-center gap-4 rounded-2xl border bg-white px-5 py-4 text-left shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 dark:bg-slate-900"
          :class="viewedPlatform === platform ? 'border-azure-500 ring-1 ring-azure-500/30 dark:border-azure-400' : 'border-slate-200 hover:border-slate-400 dark:border-white/15 dark:hover:border-white/35'"
          :aria-pressed="viewedPlatform === platform"
          :data-test="`builder-platform-${platform}`"
          @click="selectPlatform(platform)"
        >
          <IconApple v-if="platform === 'ios'" class="h-7 w-7 shrink-0 text-slate-800 dark:text-slate-200" aria-hidden="true" />
          <IconAndroid v-else class="h-7 w-7 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block text-base font-semibold text-slate-950 dark:text-white">{{ t(`builder-checklist-platform-${platform}`) }}</span>
            <span class="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">{{ t(`builder-checklist-platform-${platform}-description`) }}</span>
          </span>
          <IconCheck v-if="viewedPlatform === platform" class="h-5 w-5 shrink-0 text-azure-500" aria-hidden="true" />
        </button>
      </div>
    </section>

    <div v-if="viewedPlatform && selectedStep" class="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)] dark:border-white/15 dark:bg-slate-900">
      <nav class="border-b border-slate-200 p-4 sm:p-6 lg:border-b-0 lg:border-r dark:border-white/15" :aria-label="t('builder-checklist-tasks-title')">
        <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
          {{ t('builder-checklist-tasks-title') }}
        </h2>
        <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
          {{ t('builder-checklist-tasks-subtitle') }}
        </p>
        <ol class="mt-4">
          <li v-for="step in steps" :key="step.id" class="border-b border-slate-100 last:border-b-0 dark:border-white/10" :data-test="`builder-step-${step.id}`">
            <button
              type="button"
              class="flex min-h-14 w-full items-start gap-3 rounded-xl px-3 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-inset"
              :class="selectedStep.id === step.id ? 'bg-azure-500/5 text-primary-500 dark:bg-azure-500/10 dark:text-azure-300' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5'"
              :aria-current="selectedStep.id === step.id ? 'step' : undefined"
              :aria-controls="panelId"
              @click="selectStep(step.id)"
            >
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current text-xs font-semibold" aria-hidden="true">{{ step.index + 1 }}</span>
              <span class="min-w-0 flex-1 text-base leading-6" :class="{ 'font-medium': selectedStep.id === step.id }">{{ step.title }}</span>
            </button>
          </li>
        </ol>
      </nav>

      <div :id="panelId" class="flex min-w-0 flex-col px-5 py-6 sm:p-8" data-test="builder-checklist-instructions">
        <p class="text-sm font-medium text-sky-700 dark:text-azure-400">
          {{ t('setup-checklist-task-number', { number: selectedStep.index + 1, total: steps.length }) }}
        </p>
        <h2 class="mt-3 text-2xl font-semibold leading-tight text-slate-950 sm:text-3xl dark:text-white">
          {{ selectedStep.title }}
        </h2>
        <p class="mt-4 max-w-prose text-base leading-7 text-slate-600 dark:text-slate-300">
          {{ selectedStep.description }}
        </p>

        <template v-if="isFirstStep">
          <p class="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('builder-checklist-command-location') }}
          </p>
          <button
            v-if="platformCommand"
            type="button"
            class="d-btn group relative mt-5 h-auto min-h-0 w-full justify-start whitespace-normal rounded-2xl border-0 bg-slate-950 p-5 pr-14 text-left font-normal hover:bg-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
            data-test="builder-checklist-command"
            :aria-label="t('builder-checklist-copy-command')"
            @click="copyCommand"
          >
            <code class="block whitespace-pre-wrap break-all text-sm leading-6 text-sky-200">{{ platformCommand }}</code>
            <IconCopy class="absolute right-4 top-5 h-5 w-5 text-slate-400 group-hover:text-white" aria-hidden="true" />
          </button>
          <output v-else class="mt-5 block rounded-2xl bg-slate-950 p-5 text-sm text-slate-300">
            {{ t('app-onboarding-command-apikey-loading') }}
          </output>
          <button type="button" class="d-btn mt-4 min-h-12 self-start border-primary-500 bg-primary-500 px-5 text-white hover:border-primary-600 hover:bg-primary-600" :disabled="!platformCommand" @click="copyCommand">
            <IconCopy class="h-4 w-4" aria-hidden="true" />
            {{ t('builder-checklist-copy-command') }}
          </button>
        </template>

        <p v-else class="mt-5 flex items-start gap-3 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600 dark:bg-slate-950/60 dark:text-slate-300">
          <IconInfo class="mt-0.5 h-4 w-4 shrink-0 text-azure-500" aria-hidden="true" />
          {{ t('builder-checklist-follow-terminal') }}
        </p>

        <a :href="guideHref" target="_blank" rel="noopener noreferrer" class="mt-auto inline-flex min-h-11 items-center gap-2 self-start rounded-sm text-sky-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500 dark:text-azure-300" data-test="builder-checklist-guide">
          <IconFileText class="h-5 w-5" aria-hidden="true" />
          {{ t('builder-checklist-guide', { platform: t(`builder-checklist-platform-${viewedPlatform}`) }) }}
          <IconArrowRight class="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
    </div>

    <div v-else class="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-white/15 dark:bg-slate-900" data-test="builder-checklist-choose-platform">
      <h2 class="text-xl font-semibold text-slate-950 dark:text-white">
        {{ t('builder-checklist-choose-platform-title') }}
      </h2>
      <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ t('builder-checklist-choose-platform-description') }}
      </p>
    </div>

    <footer class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
      <button type="button" class="d-btn min-h-12 shrink-0 border-slate-300 bg-white px-4 text-slate-700 hover:border-slate-400 hover:bg-slate-50 dark:border-white/20 dark:bg-slate-900 dark:text-slate-200" :disabled="hiding || leaving" @click="emit('hide')">
        <IconLoader v-if="hiding" class="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
        {{ t('app-onboarding-dont-show-again') }}
      </button>
      <p class="max-w-prose text-sm leading-6 text-slate-500 sm:border-l sm:border-slate-200 sm:pl-5 dark:text-slate-400 dark:sm:border-white/15">
        {{ t('setup-checklist-hide-description') }}
      </p>
      <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-medium text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500 sm:ml-auto dark:text-slate-300" :disabled="hiding || leaving" @click="emit('explore')">
        {{ t('setup-checklist-explore-dashboard') }}
        <IconArrowRight class="h-4 w-4" aria-hidden="true" />
      </button>
    </footer>
  </div>
</template>
