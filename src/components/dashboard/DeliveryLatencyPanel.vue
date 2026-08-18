<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { UpdateDeliveryScope, UpdateDeliveryStatsResponse } from '~/composables/useUpdateDeliveryStats'
import { CategoryScale, Chart, Legend, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { computed, ref, watch } from 'vue'
import { Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import IconTimer from '~icons/lucide/timer'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import Spinner from '~/components/Spinner.vue'
import { buildDemoUpdateDeliveryStats, useUpdateDeliveryStats } from '~/composables/useUpdateDeliveryStats'
import { formatLocalDateShort } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

type PeriodDayOption = 1 | 3 | 7 | 30

const props = withDefaults(defineProps<{
  scope: UpdateDeliveryScope
  appId?: string
  orgId?: string
  forceDemo?: boolean
  days?: number
  hidePeriodSelector?: boolean
}>(), {
  appId: '',
  orgId: '',
  forceDemo: false,
  hidePeriodSelector: false,
})

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

const { t } = useI18n()
const localDays = ref<PeriodDayOption>(7)
const days = computed(() => props.days ?? localDays.value)

const { stats, statsLoading, statsError, fetchStats } = useUpdateDeliveryStats(() => ({
  scope: props.scope,
  app_id: props.appId || undefined,
  org_id: props.orgId || undefined,
  days: days.value,
}))

const demoStats = computed(() => buildDemoUpdateDeliveryStats(days.value))
const effectiveStats = computed<UpdateDeliveryStatsResponse | null>(() => {
  if (props.forceDemo)
    return demoStats.value
  return stats.value
})

const hasData = computed(() => (effectiveStats.value?.overview.samples ?? 0) > 0)
const emptyHelpKey = computed(() => props.scope === 'platform'
  ? 'update-delivery-no-data-help-platform'
  : 'update-delivery-no-data-help')
const chartLabels = computed(() => (effectiveStats.value?.labels ?? []).map(label => formatLocalDateShort(label) || label))

const chartData = computed<ChartData<'line'>>(() => ({
  labels: chartLabels.value,
  datasets: [
    {
      label: t('update-delivery-p50'),
      data: effectiveStats.value?.daily.p50_ms ?? [],
      borderColor: 'rgb(14, 165, 233)',
      backgroundColor: 'rgba(14, 165, 233, 0.16)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      spanGaps: false,
    },
    {
      label: t('update-delivery-p75'),
      data: effectiveStats.value?.daily.p75_ms ?? [],
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'rgba(59, 130, 246, 0.14)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      spanGaps: false,
    },
    {
      label: t('update-delivery-p95'),
      data: effectiveStats.value?.daily.p95_ms ?? [],
      borderColor: 'rgb(245, 158, 11)',
      backgroundColor: 'rgba(245, 158, 11, 0.14)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      spanGaps: false,
    },
    {
      label: t('update-delivery-p99'),
      data: effectiveStats.value?.daily.p99_ms ?? [],
      borderColor: 'rgb(244, 63, 94)',
      backgroundColor: 'rgba(244, 63, 94, 0.14)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      spanGaps: false,
    },
  ],
}))

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      position: 'bottom',
      labels: {
        boxWidth: 12,
        usePointStyle: true,
      },
    },
    tooltip: {
      callbacks: {
        label(context) {
          const value = typeof context.parsed.y === 'number' ? context.parsed.y : null
          return `${context.dataset.label}: ${formatDuration(value)}`
        },
      },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      offset: chartLabels.value.length <= 2,
      ticks: { maxRotation: 0, autoSkipPadding: 12 },
    },
    y: {
      beginAtZero: true,
      ticks: {
        callback(value) {
          return formatDuration(typeof value === 'number' ? value : Number(value))
        },
      },
    },
  },
}))

const percentileCards = computed(() => [
  { key: 'p50', label: t('update-delivery-p50'), value: effectiveStats.value?.overview.p50_ms, color: 'text-sky-600 dark:text-sky-400' },
  { key: 'p75', label: t('update-delivery-p75'), value: effectiveStats.value?.overview.p75_ms, color: 'text-blue-600 dark:text-blue-400' },
  { key: 'p95', label: t('update-delivery-p95'), value: effectiveStats.value?.overview.p95_ms, color: 'text-amber-600 dark:text-amber-400' },
  { key: 'p99', label: t('update-delivery-p99'), value: effectiveStats.value?.overview.p99_ms, color: 'text-rose-600 dark:text-rose-400' },
])

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value))
    return '-'
  if (value >= 1000)
    return `${formatNumberValue(value / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  return `${formatNumberValue(value)} ms`
}

function formatCount(value: number | null | undefined) {
  return formatNumberValue(value ?? 0)
}

function selectPeriod(option: PeriodDayOption) {
  if (props.days !== undefined || localDays.value === option)
    return
  localDays.value = option
}

watch(
  () => [props.scope, props.appId, props.orgId, props.forceDemo, days.value] as const,
  async () => {
    if (props.forceDemo)
      return
    await fetchStats()
  },
  { immediate: true },
)
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="update-delivery-latency">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
            {{ t('update-delivery-latency') }}
          </h2>
          <span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t('beta') }}</span>
          <span
            v-if="forceDemo"
            class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            {{ t('demo') }}
          </span>
        </div>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('update-delivery-latency-help') }}
        </p>
      </div>
      <PeriodDaySelector
        v-if="!hidePeriodSelector && props.days === undefined"
        :model-value="localDays"
        @update:model-value="selectPeriod"
      />
    </div>

    <div v-if="statsLoading && !forceDemo && !stats && !statsError" class="flex items-center justify-center h-64 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
      <Spinner size="w-10 h-10" />
    </div>

    <div
      v-else-if="statsError && !forceDemo"
      class="flex flex-col items-center justify-center h-64 gap-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
    >
      <IconTimer class="w-12 h-12" />
      <h3 class="text-lg font-semibold text-slate-800 dark:text-slate-100">
        {{ t('update-delivery-fetch-error') }}
      </h3>
      <p class="text-sm text-center max-w-lg">
        {{ t('update-delivery-fetch-error-help') }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-primary" @click="fetchStats">
        {{ t('update-delivery-retry') }}
      </button>
    </div>

    <template v-else>
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-6">
        <div
          v-for="card in percentileCards"
          :key="card.key"
          class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700"
        >
          <div class="text-sm truncate text-slate-600 dark:text-slate-400">
            {{ card.label }}
          </div>
          <div class="mt-2 text-2xl font-semibold" :class="card.color">
            {{ formatDuration(card.value) }}
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm truncate text-slate-600 dark:text-slate-400">
            {{ t('update-delivery-samples') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
            {{ formatCount(effectiveStats?.overview.samples) }}
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm truncate text-slate-600 dark:text-slate-400">
            {{ t('update-delivery-devices') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
            {{ effectiveStats?.overview.devices == null ? '-' : formatCount(effectiveStats.overview.devices) }}
          </div>
        </div>
      </div>

      <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
        <div class="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 class="text-base font-semibold text-slate-950 dark:text-white">
              {{ t('update-delivery-trend') }}
            </h3>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {{ t('update-delivery-trend-help') }}
            </p>
          </div>
          <IconTimer class="w-5 h-5 text-sky-500" />
        </div>

        <div v-if="statsLoading && !forceDemo" class="flex items-center justify-center h-10 mb-3 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size="w-5 h-5" />
        </div>

        <div v-if="!hasData" class="flex flex-col items-center justify-center h-72 text-slate-500 dark:text-slate-400">
          <IconTimer class="w-12 h-12 mb-3" />
          <h3 class="text-lg font-semibold text-slate-800 dark:text-slate-100">
            {{ t('update-delivery-no-data') }}
          </h3>
          <p class="mt-1 text-sm text-center text-slate-500 dark:text-slate-400 max-w-lg">
            {{ t(emptyHelpKey) }}
          </p>
        </div>
        <div v-else class="relative h-80">
          <Line :data="chartData" :options="chartOptions" />
        </div>
      </div>
    </template>
  </section>
</template>
