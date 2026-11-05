<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowLeft from '~icons/lucide/arrow-left'
import IconCheck from '~icons/lucide/check'
import IconSparkles from '~icons/lucide/sparkles'

const props = withDefaults(defineProps<{
  title: string
  steps: Array<{ id: string, label: string }>
  currentStepId: string
  showIntro?: boolean
  showBack?: boolean
}>(), { showIntro: true })
const emit = defineEmits<{ back: [] }>()
const { t } = useI18n()
const currentStepIndex = computed(() => Math.max(0, props.steps.findIndex(entry => entry.id === props.currentStepId)))
const stepProgress = computed(() => `${props.steps.length ? ((currentStepIndex.value + 1) / props.steps.length) * 100 : 0}%`)
</script>

<template>
  <header class="onboarding-flow-header">
    <div class="flex items-center gap-2">
      <button
        v-if="showBack"
        type="button"
        class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:-translate-x-0.5 hover:border-slate-300 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-white/15 dark:bg-slate-900/95 dark:text-slate-300 dark:hover:border-white/30 dark:hover:text-white"
        data-test="onboarding-setup-back"
        :aria-label="t('button-back')"
        :title="t('button-back')"
        @click="emit('back')"
      >
        <IconArrowLeft class="h-4 w-4" aria-hidden="true" />
      </button>
      <div v-if="showIntro" class="onboarding-flow-badge inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-700 shadow-sm dark:border-white/15 dark:bg-slate-900/95 dark:text-slate-200">
        <IconSparkles class="h-4 w-4" />
        {{ t('app-onboarding-badge') }}
      </div>
    </div>
    <template v-if="showIntro">
      <h1 class="onboarding-flow-title mt-4 text-2xl font-semibold text-slate-950 sm:text-3xl dark:text-white">
        {{ title }}
      </h1>

      <nav class="mt-6" :aria-label="t('app-onboarding-progress-label')">
        <ol class="flex items-center gap-2">
          <li
            v-for="(entry, index) in steps"
            :key="entry.id"
            class="flex min-w-0 flex-1 items-center gap-2"
            :aria-current="currentStepId === entry.id ? 'step' : undefined"
          >
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              :class="index < currentStepIndex ? 'bg-emerald-500 text-white' : currentStepId === entry.id ? 'bg-primary-500 text-white' : 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400'"
            >
              <IconCheck v-if="index < currentStepIndex" class="h-3.5 w-3.5" />
              <span v-else>{{ index + 1 }}</span>
            </span>
            <span
              class="hidden truncate text-sm font-medium sm:block"
              :class="currentStepId === entry.id ? 'text-slate-950 dark:text-white' : index < currentStepIndex ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-400 dark:text-slate-500'"
            >
              {{ entry.label }}
            </span>
            <span
              v-if="index < steps.length - 1"
              class="mx-1 hidden h-px flex-1 bg-slate-200 sm:block dark:bg-white/15"
              aria-hidden="true"
            />
          </li>
        </ol>
        <div class="mt-3 h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden="true">
          <div class="h-full rounded-full bg-primary-500 transition-all duration-300" :style="{ width: stepProgress }" />
        </div>
      </nav>
    </template>
  </header>
</template>
