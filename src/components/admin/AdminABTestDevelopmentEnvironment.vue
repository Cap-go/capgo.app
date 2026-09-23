<script setup lang="ts">
import type {
  AdminABTestDevelopmentEnvironment,
  AdminABTestDevelopmentEnvironmentOutcomeName,
} from '~/services/adminABTestDevelopmentEnvironment'
import { useI18n } from 'vue-i18n'
import { developmentEnvironmentPercentage } from '~/services/adminABTestDevelopmentEnvironment'
import { formatNumberValue } from '~/services/formatLocale'

defineProps<{
  outcome: AdminABTestDevelopmentEnvironment
}>()

const { t } = useI18n()

const outcomeLabels: Record<AdminABTestDevelopmentEnvironmentOutcomeName, string> = {
  ai_assistant: 'admin-ab-tests-development-environment-ai-assistant',
  hosted_builder: 'admin-ab-tests-development-environment-hosted-builder',
  other: 'admin-ab-tests-development-environment-other',
  hand_coded: 'admin-ab-tests-development-environment-hand-coded',
  no_selection_yet: 'admin-ab-tests-development-environment-no-selection-yet',
}

const outcomeColors: Record<AdminABTestDevelopmentEnvironmentOutcomeName, string> = {
  ai_assistant: 'd-progress-info',
  hosted_builder: 'd-progress-secondary',
  other: 'd-progress-accent',
  hand_coded: 'd-progress-primary',
  no_selection_yet: 'd-progress-neutral',
}

function formatPercentage(count: number, total: number) {
  return `${formatNumberValue(developmentEnvironmentPercentage(count, total), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-gray-800">
    <header class="border-b border-slate-200 px-6 py-5 lg:px-8 lg:py-6 dark:border-slate-700">
      <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
        {{ t('admin-ab-tests-development-environment-title') }}
      </h2>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {{ t('admin-ab-tests-development-environment-description') }}
      </p>
      <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {{ t('admin-ab-tests-development-environment-cohort') }}
      </p>
    </header>

    <div class="grid gap-8 px-6 py-6 lg:grid-cols-[minmax(11rem,0.45fr)_minmax(0,1fr)] lg:px-8 lg:py-8">
      <div class="self-center">
        <p class="text-4xl font-semibold tabular-nums text-slate-900 dark:text-white">
          {{ formatNumberValue(outcome.total) }}
        </p>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('admin-ab-tests-development-environment-assigned') }}
        </p>
        <p v-if="outcome.total === 0" class="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {{ t('admin-ab-tests-development-environment-empty') }}
        </p>
      </div>

      <div class="space-y-5">
        <div v-for="item in outcome.outcomes" :key="item.outcome">
          <div class="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span class="text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ t(outcomeLabels[item.outcome]) }}
            </span>
            <span class="flex items-baseline gap-3 tabular-nums">
              <span class="text-lg font-semibold text-slate-900 dark:text-white">{{ formatNumberValue(item.count) }}</span>
              <span class="text-sm text-slate-500 dark:text-slate-400">{{ formatPercentage(item.count, outcome.total) }}</span>
            </span>
          </div>
          <progress
            :aria-label="t(outcomeLabels[item.outcome])"
            class="d-progress h-3 w-full"
            :class="outcomeColors[item.outcome]"
            :value="item.count"
            :max="Math.max(outcome.total, 1)"
          />
        </div>
      </div>
    </div>

    <footer class="space-y-1 border-t border-slate-200 px-6 py-4 text-xs text-slate-500 lg:px-8 dark:border-slate-700 dark:text-slate-400">
      <p>{{ t('admin-ab-tests-development-environment-ai-assistant-note') }}</p>
      <p>{{ t('admin-ab-tests-development-environment-no-selection-note') }}</p>
    </footer>
  </section>
</template>
