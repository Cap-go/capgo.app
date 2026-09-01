<script setup lang="ts">
import type { CicdDeployMode, CicdReleaseKind } from '~/utils/gettingStartedCicd'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import IconCheck from '~icons/lucide/check'
import {
  buildCicdAiPrompt,
  CICD_DEPLOY_MODES,
  CICD_DOCS_URL,
  CICD_GITHUB_ACTIONS_DOCS_URL,
  isCicdSetupComplete,
  loadCicdSetupProgress,
  markCicdSetupValidated,
  requiredCicdReleases,
  saveCicdSetupProgress,
} from '~/utils/gettingStartedCicd'
import { onboardingPrimaryButtonClass, onboardingSecondaryButtonClass } from '~/utils/onboardingButtonClasses'

const props = defineProps<{
  appId: string
  userId: string
}>()

const emit = defineEmits<{
  validated: []
}>()

const { t } = useI18n()
const progress = ref(loadCicdSetupProgress(props.userId, props.appId))
const helpMethod = ref<'docs' | 'ai' | null>(null)

const modeOptions = computed(() => CICD_DEPLOY_MODES.map(mode => ({
  mode,
  titleKey: `getting-started-cicd-mode-${mode}`,
  descKey: `getting-started-cicd-mode-${mode}-desc`,
})))

const requiredReleases = computed(() => requiredCicdReleases(progress.value.mode))
const canConfirm = computed(() => isCicdSetupComplete({ ...progress.value, validated: false }) && requiredReleases.value.length > 0)
const aiPrompt = computed(() => {
  if (!progress.value.mode)
    return ''
  return buildCicdAiPrompt(props.appId, progress.value.mode)
})

watch(() => [props.userId, props.appId], ([userId, appId]) => {
  progress.value = loadCicdSetupProgress(userId, appId)
  helpMethod.value = null
})

function persist() {
  saveCicdSetupProgress(props.userId, props.appId, progress.value)
}

function selectMode(mode: CicdDeployMode) {
  if (progress.value.mode === mode)
    return
  progress.value = {
    mode,
    releases: {},
    validated: false,
  }
  helpMethod.value = null
  persist()
}

function toggleRelease(kind: CicdReleaseKind, checked: boolean) {
  progress.value = {
    ...progress.value,
    releases: {
      ...progress.value.releases,
      [kind]: checked,
    },
    validated: false,
  }
  persist()
}

async function copyAiPrompt() {
  if (!aiPrompt.value)
    return
  try {
    await navigator.clipboard.writeText(aiPrompt.value)
    helpMethod.value = 'ai'
    toast.success(t('copied-to-clipboard'))
  }
  catch (error) {
    console.error('Cannot copy CI/CD AI prompt', error)
    toast.error(t('cannot-copy'))
  }
}

function confirmSetup() {
  if (!canConfirm.value)
    return
  markCicdSetupValidated(props.userId, props.appId)
  progress.value = { ...progress.value, validated: true }
  emit('validated')
}
</script>

<template>
  <div class="mt-3 space-y-4 rounded-xl border border-slate-200 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-slate-950/60" data-test="getting-started-cicd-panel">
    <fieldset>
      <legend class="text-sm font-semibold text-slate-950 dark:text-white">
        {{ t('getting-started-cicd-mode-title') }}
      </legend>
      <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ t('getting-started-cicd-mode-help') }}
      </p>
      <div class="mt-3 grid gap-2">
        <label
          v-for="option in modeOptions"
          :key="option.mode"
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-3"
          :class="progress.mode === option.mode
            ? 'border-azure-500 bg-white ring-2 ring-azure-500/20 dark:bg-slate-900'
            : 'border-slate-200 bg-white dark:border-white/15 dark:bg-slate-950/90'"
          :data-test="`getting-started-cicd-mode-${option.mode}`"
        >
          <input
            :id="`getting-started-cicd-mode-${option.mode}`"
            type="radio"
            class="mt-1"
            name="getting-started-cicd-mode"
            :value="option.mode"
            :checked="progress.mode === option.mode"
            @change="selectMode(option.mode)"
          >
          <span>
            <span class="block text-sm font-semibold text-slate-950 dark:text-white">
              {{ t(option.titleKey) }}
            </span>
            <span class="mt-1 block text-sm leading-5 text-slate-600 dark:text-slate-300">
              {{ t(option.descKey) }}
            </span>
          </span>
        </label>
      </div>
    </fieldset>

    <div v-if="progress.mode" class="space-y-3">
      <p class="text-sm font-semibold text-slate-950 dark:text-white">
        {{ t('getting-started-cicd-help-title') }}
      </p>
      <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ t('getting-started-cicd-help-body') }}
      </p>
      <div class="flex flex-wrap gap-2">
        <a
          :href="CICD_DOCS_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="d-btn d-btn-sm h-11 min-h-11"
          :class="onboardingSecondaryButtonClass"
          data-test="getting-started-cicd-docs"
          @click="helpMethod = 'docs'"
        >
          {{ t('getting-started-cicd-open-docs') }}
        </a>
        <a
          :href="CICD_GITHUB_ACTIONS_DOCS_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="d-btn d-btn-sm h-11 min-h-11"
          :class="onboardingSecondaryButtonClass"
        >
          {{ t('getting-started-cicd-open-github-docs') }}
        </a>
        <button
          type="button"
          class="d-btn d-btn-sm h-11 min-h-11"
          :class="onboardingSecondaryButtonClass"
          data-test="getting-started-cicd-copy-ai"
          @click="void copyAiPrompt()"
        >
          <IconCopy class="h-4 w-4" />
          {{ t('getting-started-cicd-copy-ai') }}
        </button>
      </div>
      <p v-if="helpMethod === 'docs'" class="text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ t('getting-started-cicd-docs-follow') }}
      </p>
      <div v-if="helpMethod === 'ai'" class="space-y-2">
        <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('getting-started-cicd-ai-copied') }}
        </p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100">{{ aiPrompt }}</pre>
      </div>
    </div>

    <fieldset v-if="requiredReleases.length" class="space-y-2">
      <legend class="text-sm font-semibold text-slate-950 dark:text-white">
        {{ t('getting-started-cicd-releases-title') }}
      </legend>
      <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ t('getting-started-cicd-releases-help') }}
      </p>
      <label
        v-for="kind in requiredReleases"
        :key="kind"
        class="flex items-start gap-3 rounded-lg py-1"
        :data-test="`getting-started-cicd-release-${kind}`"
      >
        <input
          :id="`getting-started-cicd-release-${kind}`"
          type="checkbox"
          class="mt-1"
          :checked="progress.releases[kind] === true"
          @change="toggleRelease(kind, ($event.target as HTMLInputElement).checked)"
        >
        <span class="text-sm leading-6 text-slate-700 dark:text-slate-200">
          {{ t(`getting-started-cicd-release-${kind}`) }}
        </span>
      </label>
    </fieldset>

    <button
      v-if="progress.mode"
      type="button"
      class="d-btn h-11 min-h-11"
      :class="onboardingPrimaryButtonClass"
      :disabled="!canConfirm"
      data-test="getting-started-cicd-confirm"
      @click="confirmSetup"
    >
      <IconCheck class="h-4 w-4" />
      {{ t('getting-started-cicd-confirm') }}
    </button>
  </div>
</template>
