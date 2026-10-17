<script setup lang="ts">
import type { BuilderPlatform } from '~/services/builderOnboardingChecklist'
import type { ChecklistPath } from '~/utils/dualOnboardingChecklists'
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconLayers from '~icons/lucide/layers'
import IconLoader from '~icons/lucide/loader-2'
import IconRefresh from '~icons/lucide/refresh-cw'
import { loadChecklistPreference, resolveDualChecklistResume, saveChecklistPreference } from '~/utils/dualOnboardingChecklists'

const props = defineProps<{
  appId: string
  userId?: string | null
  initialOnboarding: unknown
  hiding: boolean
  leaving: boolean
}>()
const emit = defineEmits<{
  pathChanged: [path: ChecklistPath | null]
  hide: []
  explore: []
}>()
const { t } = useI18n()
const id = useId()
const preference = ref(loadChecklistPreference(props.userId, props.appId))
const snapshot = ref(props.initialOnboarding)
const resume = computed(() => resolveDualChecklistResume(snapshot.value, preference.value))
const activePath = ref<ChecklistPath | null>(resume.value.path)
const platform = ref<BuilderPlatform | null>(resume.value.platform)
const visited = ref({ ota: activePath.value === 'ota', builder: activePath.value === 'builder' })
const paths = ['ota', 'builder'] as const
const label = (path: ChecklistPath) => t(path === 'ota' ? 'setup-goal-live-updates' : 'setup-goal-builder')

watch(() => props.initialOnboarding, value => snapshot.value = value)
watch(activePath, path => emit('pathChanged', path), { immediate: true })

function selectPath(path: ChecklistPath) {
  activePath.value = path
  visited.value[path] = true
  preference.value = { ...preference.value, path }
  saveChecklistPreference(props.userId, props.appId, preference.value)
}

function selectPlatform(value: BuilderPlatform) {
  platform.value = value
  preference.value = { ...preference.value, platform: value }
  saveChecklistPreference(props.userId, props.appId, preference.value)
}

function updateSnapshot(value: unknown) {
  snapshot.value = value
}

function completePath() {
  if (activePath.value === 'builder' && !resume.value.builderComplete && resume.value.platform) {
    selectPlatform(resume.value.platform)
    return
  }
  const other = activePath.value === 'ota' ? 'builder' : 'ota'
  if (other === 'ota' ? !resume.value.otaComplete : !resume.value.builderComplete)
    selectPath(other)
  else
    emit('explore')
}

function completionAction(path: ChecklistPath) {
  if (path === 'builder' && !resume.value.builderComplete && resume.value.platform)
    return t('setup-goal-continue-builder')
  if (path === 'ota' && !resume.value.builderComplete)
    return t('setup-goal-continue-builder')
  if (path === 'builder' && !resume.value.otaComplete)
    return t('setup-goal-continue-live-updates')
  return undefined
}

async function onTabKey(event: KeyboardEvent, path: ChecklistPath) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
    return
  event.preventDefault()
  const next = event.key === 'Home' ? 'ota' : event.key === 'End' ? 'builder' : path === 'ota' ? 'builder' : 'ota'
  selectPath(next)
  await nextTick()
  document.getElementById(`${id}-tab-${next}`)?.focus()
}
</script>

<template>
  <div class="mx-auto flex min-h-[calc(100dvh-10rem)] w-full max-w-[1080px] flex-col" data-test="dual-onboarding-checklists">
    <div v-if="!activePath" data-test="setup-goal-chooser">
      <h1 class="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl dark:text-white">
        {{ t('setup-goal-title') }}
      </h1>
      <p class="mt-3 text-base leading-7 text-slate-600 dark:text-slate-300">
        {{ t('setup-goal-description') }}
      </p>
      <div class="mt-8 grid gap-5 sm:grid-cols-2">
        <button
          v-for="path in paths"
          :key="path"
          type="button"
          class="flex min-w-0 flex-col items-start rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:border-azure-500 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500 dark:border-white/15 dark:bg-slate-900"
          @click="selectPath(path)"
        >
          <component :is="path === 'ota' ? IconRefresh : IconLayers" class="mb-5 h-7 w-7 text-primary-500 dark:text-azure-300" aria-hidden="true" />
          <span class="text-xl font-semibold text-slate-950 dark:text-white">{{ label(path) }}</span>
          <span class="mt-3 text-base leading-7 text-slate-600 dark:text-slate-300">{{ t(path === 'ota' ? 'setup-goal-live-updates-description' : 'setup-goal-builder-description') }}</span>
          <span class="mt-6 flex items-center gap-2 text-sm font-medium text-sky-700 dark:text-azure-300">{{ t(path === 'ota' ? 'setup-goal-start-live-updates' : 'setup-goal-start-builder') }}<IconArrowRight class="h-4 w-4" aria-hidden="true" /></span>
        </button>
      </div>
    </div>

    <template v-else>
      <div class="mb-6 flex gap-6 border-b border-slate-200 dark:border-white/15" role="tablist" :aria-label="t('setup-goal-tabs-label')">
        <button
          v-for="path in paths"
          :id="`${id}-tab-${path}`"
          :key="path"
          type="button"
          role="tab"
          :aria-selected="activePath === path"
          :aria-controls="`${id}-panel-${path}`"
          :tabindex="activePath === path ? 0 : -1"
          class="min-h-12 border-b-2 px-1 text-base font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
          :class="activePath === path ? 'border-primary-500 text-sky-700 dark:text-azure-300' : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'"
          @click="selectPath(path)"
          @keydown="onTabKey($event, path)"
        >
          {{ label(path) }}
        </button>
      </div>
      <div
        v-for="path in paths"
        v-show="activePath === path"
        :id="`${id}-panel-${path}`"
        :key="path"
        role="tabpanel"
        :aria-labelledby="`${id}-tab-${path}`"
        tabindex="0"
        class="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500"
      >
        <slot v-if="visited[path]" :name="path" :active="activePath === path" :platform="platform" :snapshot="updateSnapshot" :select-platform="selectPlatform" :complete="completePath" :completion-action="completionAction(path)" />
      </div>
    </template>

    <footer class="mt-auto flex flex-col items-start gap-3 pt-10 sm:flex-row sm:items-center sm:justify-between">
      <button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-sm text-sm text-slate-500 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500 dark:text-slate-400" data-test="app-onboarding-dont-show-again" :disabled="hiding || leaving" @click="emit('hide')">
        <IconLoader v-if="hiding" class="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
        {{ t('app-onboarding-dont-show-again') }}
      </button>
      <button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-sm text-sm font-medium text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500 dark:text-slate-300" data-test="setup-checklist-explore-dashboard" :disabled="hiding || leaving" @click="emit('explore')">
        {{ t('setup-checklist-explore-dashboard') }}<IconArrowRight class="h-4 w-4" aria-hidden="true" />
      </button>
    </footer>
  </div>
</template>
