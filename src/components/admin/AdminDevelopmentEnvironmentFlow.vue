<script setup lang="ts">
import type { AdminOnboardingJourneyGraphConfig, AdminOnboardingJourneyNode } from './adminOnboardingJourneyGraph'
import type { AdminDevelopmentEnvironmentFlow, DevelopmentEnvironmentFlowAnswer } from '~/services/adminDevelopmentEnvironmentFlow'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatNumberValue } from '~/services/formatLocale'
import AdminOnboardingJourneyGraph from './AdminOnboardingJourneyGraph.vue'

const props = defineProps<{ analytics: AdminDevelopmentEnvironmentFlow | null, loading: boolean }>()
defineEmits<{ retry: [] }>()
const { t } = useI18n()
const labels: Record<DevelopmentEnvironmentFlowAnswer, string> = {
  answered: 'admin-ab-question-flow-answered',
  skipped: 'admin-ab-question-flow-skipped',
  no_answer: 'admin-ab-question-flow-no-answer',
}
const graph = computed<AdminOnboardingJourneyGraphConfig>(() => {
  const reached = props.analytics?.reached ?? 0
  const percent = (count: number, total: number) => total > 0 ? count / total * 100 : 0
  const nodes: AdminOnboardingJourneyNode[] = [{
    id: 'reached',
    label: t('admin-ab-question-flow-reached'),
    count: reached,
    totalPercent: percent(reached, reached),
    x: 180,
    y: 330,
    width: 320,
    kind: 'stage',
    icon: 'intent',
  }]
  const edges: AdminOnboardingJourneyGraphConfig['edges'] = []
  for (const [index, group] of (props.analytics?.groups ?? []).entries()) {
    const y = 185 + index * 185
    nodes.push({ id: group.answer, label: t(labels[group.answer]), count: group.people, totalPercent: percent(group.people, reached), x: 630, y, kind: 'stage', icon: group.answer === 'answered' ? 'success' : 'details', tone: group.answer === 'no_answer' ? 'muted' : 'default' })
    edges.push({ from: 'reached', to: group.answer, style: 'primary' })
    for (const continued of [true, false]) {
      // Clicking Skip advances immediately; a skipped/non-continued branch
      // would suggest behavior that the product does not support.
      if (!continued && group.answer === 'skipped')
        continue
      const id = `${group.answer}_${continued ? 'continued' : 'did_not_continue'}`
      const count = continued ? group.continued : group.did_not_continue
      nodes.push({ id, label: t(continued ? 'admin-ab-question-flow-continued' : 'admin-ab-question-flow-did-not-continue'), count, totalPercent: percent(count, reached), parentPercent: percent(count, group.people), x: 1130, y: group.answer === 'skipped' ? y : y + (continued ? -50 : 50), width: 330, kind: 'stage', icon: continued ? 'success' : 'close', tone: continued ? 'success' : 'danger' })
      edges.push({ from: group.answer, to: id, style: 'branch' })
    }
  }
  return {
    width: 1330,
    height: 735,
    nodes,
    edges,
    levels: [{ label: '1', start: 0, end: 400, divider: 400 }, { label: '2', start: 400, end: 850, divider: 850 }, { label: '3', start: 850, end: 1330 }],
    formatters: {
      totalPercent: value => t('admin-ab-question-flow-percent-reached', { percent: formatNumberValue(value, { maximumFractionDigits: 1 }) }),
      parentPercent: value => t('admin-ab-question-flow-percent-group', { percent: formatNumberValue(value, { maximumFractionDigits: 1 }) }),
      levelPercent: value => `${formatNumberValue(value, { maximumFractionDigits: 1 })}%`,
      previousPercent: value => `${formatNumberValue(value, { maximumFractionDigits: 1 })}%`,
    },
  }
})
const period = computed(() => props.analytics
  ? `${props.analytics.period.start.slice(0, 10)} – ${props.analytics.period.end.slice(0, 10)} (UTC)`
  : '')
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-gray-800">
    <header class="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 dark:border-slate-700">
      <div class="min-w-0">
        <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
          {{ t('admin-ab-question-flow-title') }}
        </h2>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {{ t('admin-ab-question-flow-description') }}
        </p>
        <p v-if="period" class="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {{ period }}
        </p>
      </div>
      <button type="button" class="d-btn d-btn-outline d-btn-sm" :disabled="loading" @click="$emit('retry')">
        {{ t('refresh') }}
      </button>
    </header>
    <div class="min-w-0 px-6 py-6" aria-live="polite">
      <p v-if="loading" class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('loading') }}
      </p>
      <p v-else-if="!analytics || analytics.data_quality.failure_reason" role="alert" class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('admin-ab-question-flow-unavailable') }}
      </p>
      <p v-else-if="analytics.reached === 0" class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('admin-ab-question-flow-empty') }}
      </p>
      <AdminOnboardingJourneyGraph v-else :config="graph" />
    </div>
    <footer class="space-y-1 border-t border-slate-200 px-6 py-4 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
      <p>{{ t('admin-ab-question-flow-counting-note') }}</p>
      <p>{{ t('admin-ab-question-flow-continuation-note') }}</p>
    </footer>
  </section>
</template>
