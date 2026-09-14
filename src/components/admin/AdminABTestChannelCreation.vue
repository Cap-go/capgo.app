<script setup lang="ts">
import type {
  AdminABTestChannelCreation,
  AdminChannelAnimationCohortName,
  AdminChannelAnimationStageName,
  AdminChannelExperimentStatus,
} from '~/services/adminABTestChannelCreation'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowPath from '~icons/heroicons/arrow-path'
import IconInformationCircle from '~icons/heroicons/information-circle'
import AdminABTestAnimationRetentionChart from '~/components/admin/AdminABTestAnimationRetentionChart.vue'
import { formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

const props = defineProps<{
  analytics: AdminABTestChannelCreation
}>()

const { t } = useI18n()
const selectedStageName = ref<AdminChannelAnimationStageName>('channel-self-assign')

const stageLabelKeys: Record<AdminChannelAnimationStageName, string> = {
  'channel-routing': 'admin-ab-tests-channel-stage-routing',
  'channel-self-assign': 'admin-ab-tests-channel-stage-self-assign',
  'channel-console-assign': 'admin-ab-tests-channel-stage-console-assign',
}

const cohortLabelKeys: Record<AdminChannelAnimationCohortName, string> = {
  automatic: 'admin-ab-tests-channel-cohort-automatic',
  replay: 'admin-ab-tests-channel-cohort-replay',
  reduced_motion: 'admin-ab-tests-channel-cohort-reduced-motion',
  unavailable: 'admin-ab-tests-channel-cohort-unavailable',
}

const statusLabelKeys: Record<AdminChannelExperimentStatus, string> = {
  collecting: 'admin-ab-tests-channel-status-collecting',
  treatment_ahead: 'admin-ab-tests-channel-status-treatment-ahead',
  control_ahead: 'admin-ab-tests-channel-status-control-ahead',
  inconclusive: 'admin-ab-tests-channel-status-inconclusive',
}

const selectedStage = computed(() => props.analytics.stages.find(stage => stage.stage === selectedStageName.value) ?? props.analytics.stages[0])
const animationDataAvailable = computed(() => (
  props.analytics.data_quality.posthog_connected
  && props.analytics.data_quality.posthog_failure_reason === null
))

function formatPercentage(value: number | null) {
  return value === null
    ? '—'
    : `${formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatDifference(value: number | null) {
  if (value === null)
    return '—'
  const formatted = formatNumberValue(Math.abs(value), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatted} pp`
}

function formatWatchTime(value: number | null) {
  if (value === null)
    return '—'
  const seconds = Math.round(value / 1_000)
  if (seconds < 60)
    return t('admin-ab-tests-channel-seconds', { count: formatNumberValue(seconds) })
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return t('admin-ab-tests-channel-minutes-seconds', {
    minutes: formatNumberValue(minutes),
    seconds: formatNumberValue(remainder, { minimumIntegerDigits: 2 }),
  })
}

function statusTone(status: AdminChannelExperimentStatus) {
  if (status === 'treatment_ahead')
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (status === 'control_ahead')
    return 'border-error/30 bg-error/10 text-error'
  if (status === 'inconclusive')
    return 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
  return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
}
</script>

<template>
  <div class="space-y-4">
    <section class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-gray-800">
      <header class="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-start lg:justify-between lg:px-8 dark:border-slate-700">
        <div>
          <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
            {{ t('admin-ab-tests-channel-title') }}
          </h2>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {{ t('admin-ab-tests-channel-description', { hours: analytics.experiment.observation_window_hours }) }}
          </p>
        </div>
        <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span class="size-2 rounded-full bg-[#119eff]" aria-hidden="true" />
          <span>{{ t('admin-ab-tests-channel-updated', { date: formatLocalDateTime(analytics.generated_at) }) }}</span>
        </div>
      </header>

      <div class="grid gap-5 px-6 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:items-center lg:px-8">
        <div v-for="(branch, index) in analytics.experiment.branches" :key="branch.branch" class="min-w-0">
          <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <span class="size-2.5 shrink-0 rounded-full" :class="index === 0 ? 'bg-[#119eff]' : 'bg-violet-500'" aria-hidden="true" />
            <span class="truncate">{{ branch.label }}</span>
          </div>
          <p class="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums">
            <span class="text-2xl font-semibold text-slate-900 dark:text-white">
              {{ formatNumberValue(branch.converted) }} / {{ formatNumberValue(branch.eligible) }}
            </span>
            <span class="text-sm text-slate-500 dark:text-slate-400">({{ formatPercentage(branch.conversion_percentage) }})</span>
          </p>
          <p v-if="branch.pending > 0" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('admin-ab-tests-channel-pending', { count: formatNumberValue(branch.pending), hours: analytics.experiment.observation_window_hours }) }}
          </p>
        </div>

        <div class="border-slate-200 lg:border-l lg:pl-5 dark:border-slate-700">
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {{ t('admin-ab-tests-channel-difference') }}
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {{ formatDifference(analytics.experiment.difference_percentage_points) }}
          </p>
        </div>

        <div class="rounded-lg border px-4 py-3" :class="statusTone(analytics.experiment.status)">
          <p class="flex items-center gap-2 text-sm font-semibold">
            <IconInformationCircle class="size-4 shrink-0" />
            {{ t(statusLabelKeys[analytics.experiment.status]) }}
          </p>
          <p class="mt-1 max-w-56 text-xs opacity-80">
            {{ analytics.experiment.status === 'collecting'
              ? t('admin-ab-tests-channel-status-collecting-description', {
                count: formatNumberValue(analytics.experiment.minimum_branch_sample),
              })
              : t('admin-ab-tests-channel-status-confidence', {
                confidence: formatPercentage(analytics.experiment.confidence_percentage),
              }) }}
          </p>
        </div>
      </div>
    </section>

    <section class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-gray-800">
      <div class="px-6 py-5 lg:px-8 lg:py-6">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
              {{ t('admin-ab-tests-channel-animation-title') }}
            </h3>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {{ t('admin-ab-tests-channel-animation-description') }}
            </p>
          </div>
          <p class="flex max-w-xl items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
            <IconInformationCircle class="mt-0.5 size-4 shrink-0" />
            <span>{{ t('admin-ab-tests-channel-diagnostic-note') }}</span>
          </p>
        </div>

        <div v-if="!animationDataAvailable" role="alert" class="mt-5 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <IconInformationCircle class="mt-0.5 size-5 shrink-0" />
          <span>{{ analytics.data_quality.posthog_configured ? t('admin-ab-tests-channel-posthog-unavailable') : t('admin-ab-tests-channel-posthog-unconfigured') }}</span>
        </div>

        <template v-else>
          <div class="mt-5 grid overflow-hidden rounded-lg border border-slate-200 sm:grid-cols-3 dark:border-slate-700" role="tablist" :aria-label="t('admin-ab-tests-channel-stage-selector')">
            <button
              v-for="(stage, index) in analytics.stages"
              :key="stage.stage"
              type="button"
              role="tab"
              :aria-selected="stage.stage === selectedStageName"
              class="flex min-w-0 items-start gap-3 border-b border-slate-200 px-4 py-4 text-left transition last:border-b-0 hover:bg-slate-50 sm:border-b-0 sm:border-r sm:last:border-r-0 dark:border-slate-700 dark:hover:bg-slate-900/40"
              :class="stage.stage === selectedStageName ? 'bg-sky-50 ring-1 ring-inset ring-[#119eff] dark:bg-[#119eff]/10' : ''"
              @click="selectedStageName = stage.stage"
            >
              <span class="flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold" :class="stage.stage === selectedStageName ? 'border-[#119eff] bg-[#119eff]/15 text-sky-700 dark:text-sky-300' : 'border-slate-300 text-slate-500 dark:border-slate-600 dark:text-slate-300'">
                {{ index + 1 }}
              </span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold text-slate-900 dark:text-white">{{ t(stageLabelKeys[stage.stage]) }}</span>
                <span class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  <span>{{ t('admin-ab-tests-channel-reached-short', { count: formatNumberValue(stage.reached) }) }}</span>
                  <span>{{ t('admin-ab-tests-channel-complete-short', { percent: formatPercentage(stage.completion_percentage) }) }}</span>
                  <span>{{ t('admin-ab-tests-channel-skip-short', { percent: formatPercentage(stage.started === 0 ? null : (stage.skipped / stage.started) * 100) }) }}</span>
                </span>
              </span>
            </button>
          </div>

          <div v-if="selectedStage" class="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.42fr)]">
            <div class="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
                <h4 class="text-sm font-semibold text-slate-900 dark:text-white">
                  {{ t('admin-ab-tests-channel-retention-title') }}
                </h4>
                <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('admin-ab-tests-channel-retention-description') }}
                </p>
              </div>
              <div class="px-3 py-2">
                <AdminABTestAnimationRetentionChart :stage="selectedStage" />
              </div>
            </div>

            <div class="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
                <h4 class="text-sm font-semibold text-slate-900 dark:text-white">
                  {{ t('admin-ab-tests-channel-stage-metrics', { stage: t(stageLabelKeys[selectedStage.stage]) }) }}
                </h4>
              </div>
              <dl class="divide-y divide-slate-200 text-sm dark:divide-slate-700">
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-started') }}</dt><dd class="font-semibold tabular-nums">
                    {{ formatNumberValue(selectedStage.started) }}
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-completed') }}</dt><dd class="font-semibold tabular-nums">
                    {{ formatNumberValue(selectedStage.completed) }} ({{ formatPercentage(selectedStage.completion_percentage) }})
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-skipped') }}</dt><dd class="font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                    {{ formatNumberValue(selectedStage.skipped) }} ({{ formatPercentage(selectedStage.started === 0 ? null : (selectedStage.skipped / selectedStage.started) * 100) }})
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-interrupted') }}</dt><dd class="font-semibold tabular-nums text-error">
                    {{ formatNumberValue(selectedStage.interrupted) }} ({{ formatPercentage(selectedStage.started === 0 ? null : (selectedStage.interrupted / selectedStage.started) * 100) }})
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-replays') }}</dt><dd class="flex items-center gap-1.5 font-semibold tabular-nums">
                    <IconArrowPath class="size-4 text-violet-500" />{{ formatNumberValue(selectedStage.replays) }}
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-median-watch') }}</dt><dd class="font-semibold tabular-nums">
                    {{ formatWatchTime(selectedStage.median_watch_ms) }}
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-median-skip') }}</dt><dd class="font-semibold tabular-nums">
                    {{ formatPercentage(selectedStage.median_skip_progress_percentage) }}
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt>{{ t('admin-ab-tests-channel-continued') }}</dt><dd class="font-semibold tabular-nums">
                    {{ formatNumberValue(selectedStage.continued) }} ({{ formatPercentage(selectedStage.continued_percentage) }})
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div v-if="selectedStage" class="mt-3 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table class="w-full min-w-[44rem] text-left text-sm">
              <caption class="border-b border-slate-200 px-4 py-3 text-left font-semibold text-slate-900 dark:border-slate-700 dark:text-white">
                {{ t('admin-ab-tests-channel-cohort-title', { stage: t(stageLabelKeys[selectedStage.stage]) }) }}
              </caption>
              <thead class="bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <th class="px-4 py-2.5">
                    {{ t('admin-ab-tests-channel-cohort') }}
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    {{ t('admin-ab-tests-channel-users') }}
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    {{ t('admin-ab-tests-channel-completion') }}
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    {{ t('admin-ab-tests-channel-median-watch') }}
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    {{ t('admin-ab-tests-channel-continued-short') }}
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200 dark:divide-slate-700">
                <tr v-for="cohort in selectedStage.cohorts" :key="cohort.cohort">
                  <th class="px-4 py-2.5 font-medium text-slate-700 dark:text-slate-200">
                    {{ t(cohortLabelKeys[cohort.cohort]) }}
                  </th>
                  <td class="px-4 py-2.5 text-right tabular-nums">
                    {{ formatNumberValue(cohort.users) }}
                  </td>
                  <td class="px-4 py-2.5 text-right tabular-nums">
                    {{ cohort.completed === null ? '—' : `${formatNumberValue(cohort.completed)} (${formatPercentage(cohort.completion_percentage)})` }}
                  </td>
                  <td class="px-4 py-2.5 text-right tabular-nums">
                    {{ formatWatchTime(cohort.median_watch_ms) }}
                  </td>
                  <td class="px-4 py-2.5 text-right tabular-nums">
                    {{ formatNumberValue(cohort.continued) }} ({{ formatPercentage(cohort.continued_percentage) }})
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p class="mt-3 flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
            <IconInformationCircle class="mt-0.5 size-4 shrink-0" />
            <span>{{ t('admin-ab-tests-channel-small-sample') }}</span>
          </p>
        </template>
      </div>
    </section>
  </div>
</template>
