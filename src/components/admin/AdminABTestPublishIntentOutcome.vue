<script setup lang="ts">
import type {
  AdminABTestPublishIntentOutcome,
  AdminABTestPublishIntentOutcomeName,
} from '~/services/adminABTestPublishIntentOutcome'
import { useI18n } from 'vue-i18n'
import { formatNumberValue } from '~/services/formatLocale'

defineProps<{
  outcome: AdminABTestPublishIntentOutcome
}>()

const { t } = useI18n()

const outcomeLabels: Record<AdminABTestPublishIntentOutcomeName, string> = {
  selected_publish: 'admin-ab-tests-publish-outcome-selected-publish',
  selected_another_intent: 'admin-ab-tests-publish-outcome-selected-another-intent',
  no_selection_yet: 'admin-ab-tests-publish-outcome-no-selection-yet',
}

const outcomeColors: Record<AdminABTestPublishIntentOutcomeName, string> = {
  selected_publish: 'd-progress-info',
  selected_another_intent: 'd-progress-secondary',
  no_selection_yet: 'd-progress-neutral',
}
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-gray-800">
    <header class="border-b border-slate-200 px-6 py-5 lg:px-8 lg:py-6 dark:border-slate-700">
      <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
        {{ t('admin-ab-tests-publish-outcome-title') }}
      </h2>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {{ t('admin-ab-tests-publish-outcome-description') }}
      </p>
      <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {{ t('admin-ab-tests-publish-outcome-cohort') }}
      </p>
    </header>

    <div class="grid gap-8 px-6 py-6 lg:grid-cols-[minmax(11rem,0.45fr)_minmax(0,1fr)] lg:px-8 lg:py-8">
      <div class="self-center">
        <p class="text-4xl font-semibold tabular-nums text-slate-900 dark:text-white">
          {{ formatNumberValue(outcome.total) }}
        </p>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('admin-ab-tests-publish-outcome-exposed') }}
        </p>
      </div>

      <div class="space-y-5">
        <div v-for="item in outcome.outcomes" :key="item.outcome">
          <div class="mb-2 flex items-baseline justify-between gap-4">
            <span class="text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ t(outcomeLabels[item.outcome]) }}
            </span>
            <span class="text-lg font-semibold tabular-nums text-slate-900 dark:text-white">
              {{ formatNumberValue(item.count) }}
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
  </section>
</template>
