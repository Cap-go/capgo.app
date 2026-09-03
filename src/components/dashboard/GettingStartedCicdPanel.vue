<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import IconCheck from '~icons/lucide/check'
import {
  buildCicdAiPrompt,
  CICD_DOCS_URL,
  markCicdSetupValidated,
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
const helpMethod = ref<'docs' | 'ai' | null>(null)
const aiPrompt = computed(() => buildCicdAiPrompt(props.appId, 'prod'))

async function copyAiPrompt() {
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
  markCicdSetupValidated(props.userId, props.appId)
  emit('validated')
}
</script>

<template>
  <div class="mt-3 space-y-4 rounded-xl border border-slate-200 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-slate-950/60" data-test="getting-started-cicd-panel">
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
    <button
      type="button"
      class="d-btn h-11 min-h-11"
      :class="onboardingPrimaryButtonClass"
      data-test="getting-started-cicd-confirm"
      @click="confirmSetup"
    >
      <IconCheck class="h-4 w-4" />
      {{ t('getting-started-cicd-confirm') }}
    </button>
  </div>
</template>
