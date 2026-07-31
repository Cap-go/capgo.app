<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import { BarElement, CategoryScale, Chart, Legend, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { computed, ref, watch } from 'vue'
import { Bar, Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconActivity from '~icons/lucide/activity'
import IconAlertTriangle from '~icons/lucide/alert-triangle'
import IconExternalLink from '~icons/lucide/external-link'
import IconRocket from '~icons/lucide/rocket'
import IconTimer from '~icons/lucide/timer'
import DeliveryLatencyPanel from '~/components/dashboard/DeliveryLatencyPanel.vue'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import { useNativeObserveStats } from '~/composables/useNativeObserveStats'
import { formatLocalDateShort } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { actionToFilter } from '~/services/statsActions'
import { useDisplayStore } from '~/stores/display'

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend)

type PeriodDayOption = 1 | 3 | 7 | 30

type NullableSeries = Array<number | null>

interface NativeObserveStatsResponse {
  labels: string[]
  period: {
    requested_days: PeriodDayOption
    actual_days: number
    start: string
    end: string
  }
  overview: {
    total_events: number
    total_devices: number
    issue_count: number
    affected_devices: number
    issue_free_rate: number
    launch_timeout_count: number
    launch_p50_ms: number | null
    launch_p90_ms: number | null
    webview_load_p50_ms: number | null
    webview_load_p90_ms: number | null
  }
  daily: {
    total_events: number[]
    issue_events: number[]
    launches: number[]
    webview_loads: number[]
    launch_p50_ms: NullableSeries
    launch_p90_ms: NullableSeries
    webview_load_p50_ms: NullableSeries
    webview_load_p90_ms: NullableSeries
  }
  actionBreakdown: Array<{
    action: string
    events: number
    devices: number
    p50_ms: number | null
    p90_ms: number | null
    p99_ms: number | null
    is_issue: boolean
  }>
  versions: Array<{
    version_name: string
    events: number
    devices: number
    issue_count: number
    affected_devices: number
    issue_free_rate: number
    launch_p90_ms: number | null
    webview_load_p90_ms: number | null
  }>
  releaseMarkers: Array<{
    version_name: string
    channel_name: string
    deployed_at: string
  }>
}

const route = useRoute()
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()

const packageId = computed(() => {
  const app = (route.params as Record<string, string | string[] | undefined>).app
  return Array.isArray(app) ? app[0] ?? '' : String(app ?? '')
})
const appRouteSegment = computed(() => route.path.match(/^\/app\/([^/]+)/)?.[1] ?? encodeURIComponent(packageId.value))
const days = ref<PeriodDayOption>(7)
const { stats, statsLoading, fetchStats } = useNativeObserveStats<NativeObserveStatsResponse>(
  packageId,
  () => ({ days: days.value }),
  'native observe stats',
)
const hasData = computed(() => (stats.value?.overview.total_events ?? 0) > 0)
const topActions = computed(() => stats.value?.actionBreakdown.slice(0, 10) ?? [])
const topVersions = computed(() => stats.value?.versions.slice(0, 8) ?? [])

const selectedPeriodLabel = computed(() => {
  if (days.value === 1)
    return t('last-one-day')
  return t('last-n-days', { days: days.value })
})
const periodTimespanLabel = computed(() => {
  const labels = stats.value?.labels ?? []
  if (labels.length > 0)
    return `${formatShortDate(labels[0])} - ${formatShortDate(labels[labels.length - 1])}`

  const period = stats.value?.period
  if (!period)
    return '-'
  return `${formatShortDate(period.start)} - ${formatShortDate(period.end)}`
})
const observeScopeLabel = computed(() => t('native-observe-scope-summary', {
  period: selectedPeriodLabel.value,
  range: periodTimespanLabel.value,
}))
const observeOverviewHelp = computed(() => t('native-observe-overview-help', {
  period: selectedPeriodLabel.value,
}))

const chartLabels = computed(() => (stats.value?.labels ?? []).map(label => formatLocalDateShort(label) || label))

const performanceChartData = computed<ChartData<'line'>>(() => ({
  labels: chartLabels.value,
  datasets: [
    {
      label: t('native-observe-launch-p50'),
      data: stats.value?.daily.launch_p50_ms ?? [],
      borderColor: 'rgb(14, 165, 233)',
      backgroundColor: 'rgba(14, 165, 233, 0.18)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      spanGaps: true,
    },
    {
      label: t('native-observe-launch-p90'),
      data: stats.value?.daily.launch_p90_ms ?? [],
      borderColor: 'rgb(244, 63, 94)',
      backgroundColor: 'rgba(244, 63, 94, 0.16)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      spanGaps: true,
    },
    {
      label: t('native-observe-webview-p90'),
      data: stats.value?.daily.webview_load_p90_ms ?? [],
      borderColor: 'rgb(16, 185, 129)',
      backgroundColor: 'rgba(16, 185, 129, 0.16)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      spanGaps: true,
    },
  ],
}))

const eventChartData = computed<ChartData<'bar'>>(() => ({
  labels: chartLabels.value,
  datasets: [
    {
      label: t('native-observe-issues'),
      data: stats.value?.daily.issue_events ?? [],
      backgroundColor: 'rgba(244, 63, 94, 0.72)',
      borderColor: 'rgb(244, 63, 94)',
      borderWidth: 1,
    },
    {
      label: t('native-observe-launches'),
      data: stats.value?.daily.launches ?? [],
      backgroundColor: 'rgba(14, 165, 233, 0.62)',
      borderColor: 'rgb(14, 165, 233)',
      borderWidth: 1,
    },
    {
      label: t('native-observe-webview-loads'),
      data: stats.value?.daily.webview_loads ?? [],
      backgroundColor: 'rgba(16, 185, 129, 0.62)',
      borderColor: 'rgb(16, 185, 129)',
      borderWidth: 1,
    },
  ],
}))

const performanceChartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'bottom' },
    tooltip: { enabled: true },
  },
  scales: {
    x: { grid: { display: false } },
    y: {
      beginAtZero: true,
      ticks: {
        callback: value => `${formatNumberValue(Number(value))} ms`,
      },
    },
  },
}))

const eventChartOptions = computed<ChartOptions<'bar'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'bottom' },
    tooltip: { enabled: true },
  },
  scales: {
    x: { grid: { display: false } },
    y: {
      beginAtZero: true,
      ticks: {
        precision: 0,
      },
    },
  },
}))

function formatShortDate(value: string | null | undefined) {
  if (!value)
    return '-'
  return formatLocalDateShort(value) || '-'
}

function formatCount(value: number | null | undefined) {
  return formatNumberValue(Math.round(value ?? 0))
}

function formatPercent(value: number | null | undefined) {
  return `${formatNumberValue(value ?? 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined)
    return '-'
  if (value >= 1000)
    return `${formatNumberValue(value / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  return `${formatNumberValue(value)} ms`
}

function formatAction(action: string) {
  const key = actionToFilter[action]
  return key ? t(key) : action
}

function selectPeriod(option: PeriodDayOption) {
  if (days.value === option)
    return
  days.value = option
}

function openLogs(action: string) {
  if (!stats.value)
    return

  router.push({
    path: `/app/${appRouteSegment.value}/logs`,
    query: {
      action,
      start: stats.value.period.start,
      end: stats.value.period.end,
    },
  })
}

watch(packageId, () => {
  displayStore.NavTitle = t('observe')
  displayStore.defaultBack = '/apps'
}, { immediate: true })

watch([packageId, days], async () => {
  await fetchStats()
}, { immediate: true })
</script>

<template>
  <div class="w-full h-full px-4 pt-0 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-xl font-semibold text-slate-950 dark:text-white">
              {{ t('observe') }}
            </h1>
            <span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t('beta') }}</span>
          </div>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {{ t('native-observe-subtitle') }}
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ observeScopeLabel }}
          </p>
        </div>
        <PeriodDaySelector :model-value="days" @update:model-value="selectPeriod" />
      </div>

      <div v-if="statsLoading && !stats" class="flex items-center justify-center h-80">
        <Spinner size="w-12 h-12" />
      </div>

      <template v-else>
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-semibold text-slate-950 dark:text-white">
            {{ t('native-observe-overview') }}
          </h2>
          <p class="text-sm text-slate-500 dark:text-slate-400">
            {{ observeOverviewHelp }}
          </p>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="text-sm truncate text-slate-600 dark:text-slate-400">
              {{ t('native-observe-tracked-devices') }}
            </div>
            <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
              {{ formatCount(stats?.overview.total_devices) }}
            </div>
          </div>

          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="text-sm truncate text-slate-600 dark:text-slate-400">
              {{ t('native-observe-issue-free-rate') }}
            </div>
            <div class="mt-2 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
              {{ formatPercent(stats?.overview.issue_free_rate) }}
            </div>
          </div>

          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="text-sm truncate text-slate-600 dark:text-slate-400">
              {{ t('native-observe-launch-p90') }}
            </div>
            <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
              {{ formatDuration(stats?.overview.launch_p90_ms) }}
            </div>
          </div>

          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="text-sm truncate text-slate-600 dark:text-slate-400">
              {{ t('native-observe-webview-p90') }}
            </div>
            <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
              {{ formatDuration(stats?.overview.webview_load_p90_ms) }}
            </div>
          </div>

          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="text-sm truncate text-slate-600 dark:text-slate-400">
              {{ t('native-observe-issues') }}
            </div>
            <div class="mt-2 text-2xl font-semibold text-rose-600 dark:text-rose-400">
              {{ formatCount(stats?.overview.issue_count) }}
            </div>
          </div>
        </div>
        <DeliveryLatencyPanel
          :key="packageId"
          scope="app"
          :app-id="packageId"
          :days="days"
          hide-period-selector
        />

        <div v-if="statsLoading" class="flex items-center justify-center h-10 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size="w-5 h-5" />
        </div>

        <div v-if="!hasData" class="flex flex-col items-center justify-center h-72 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400">
          <IconActivity class="w-12 h-12 mb-3" />
          <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-100">
            {{ t('native-observe-no-data') }}
          </h2>
          <p class="mt-1 text-sm text-center text-slate-500 dark:text-slate-400">
            {{ t('native-observe-no-data-help') }}
          </p>
        </div>

        <template v-else>
          <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                    {{ t('native-observe-performance') }}
                  </h2>
                  <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {{ t('native-observe-performance-help') }}
                  </p>
                </div>
                <IconTimer class="w-5 h-5 text-sky-500" />
              </div>
              <div class="relative h-80">
                <Line :data="performanceChartData" :options="performanceChartOptions" />
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                    {{ t('native-observe-volume') }}
                  </h2>
                  <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {{ t('native-observe-volume-help') }}
                  </p>
                </div>
                <IconActivity class="w-5 h-5 text-emerald-500" />
              </div>
              <div class="relative h-80">
                <Bar :data="eventChartData" :options="eventChartOptions" />
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.65fr)]">
            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                    {{ t('native-observe-version-health') }}
                  </h2>
                  <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {{ t('native-observe-version-health-help') }}
                  </p>
                </div>
                <IconRocket class="w-5 h-5 text-sky-500" />
              </div>
              <div class="overflow-x-auto">
                <table class="d-table d-table-sm w-full min-w-[760px]">
                  <thead>
                    <tr>
                      <th class="whitespace-nowrap">
                        {{ t('native-observe-version') }}
                      </th>
                      <th class="whitespace-nowrap">
                        {{ t('events') }}
                      </th>
                      <th class="whitespace-nowrap">
                        {{ t('devices') }}
                      </th>
                      <th class="whitespace-nowrap">
                        {{ t('native-observe-issue-free-rate') }}
                      </th>
                      <th class="whitespace-nowrap">
                        {{ t('native-observe-launch-p90') }}
                      </th>
                      <th class="whitespace-nowrap">
                        {{ t('native-observe-webview-p90') }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="version in topVersions" :key="version.version_name">
                      <td class="font-medium text-slate-900 dark:text-slate-100">
                        {{ version.version_name }}
                      </td>
                      <td>{{ formatCount(version.events) }}</td>
                      <td>{{ formatCount(version.devices) }}</td>
                      <td>{{ formatPercent(version.issue_free_rate) }}</td>
                      <td>{{ formatDuration(version.launch_p90_ms) }}</td>
                      <td>{{ formatDuration(version.webview_load_p90_ms) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                    {{ t('native-observe-releases') }}
                  </h2>
                  <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {{ t('native-observe-release-help') }}
                  </p>
                </div>
                <IconRocket class="w-5 h-5 text-emerald-500" />
              </div>
              <div v-if="stats?.releaseMarkers.length" class="flex flex-col gap-3">
                <div
                  v-for="release in stats.releaseMarkers"
                  :key="`${release.channel_name}-${release.version_name}-${release.deployed_at}`"
                  class="flex items-start justify-between gap-3 py-2 border-b last:border-b-0 border-slate-200 dark:border-slate-700"
                >
                  <div class="min-w-0">
                    <div class="font-medium truncate text-slate-900 dark:text-slate-100">
                      {{ release.version_name }}
                    </div>
                    <div class="text-sm truncate text-slate-500 dark:text-slate-400">
                      {{ release.channel_name }}
                    </div>
                  </div>
                  <div class="text-sm text-right whitespace-nowrap text-slate-500 dark:text-slate-400">
                    {{ formatShortDate(release.deployed_at) }}
                  </div>
                </div>
              </div>
              <div v-else class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('native-observe-no-releases') }}
              </div>
            </div>
          </div>

          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                  {{ t('native-observe-action-breakdown') }}
                </h2>
                <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {{ t('native-observe-action-breakdown-help') }}
                </p>
              </div>
              <IconAlertTriangle class="w-5 h-5 text-rose-500" />
            </div>
            <div class="overflow-x-auto">
              <table class="d-table d-table-sm w-full min-w-[820px]">
                <thead>
                  <tr>
                    <th class="whitespace-nowrap">
                      {{ t('action') }}
                    </th>
                    <th class="whitespace-nowrap">
                      {{ t('type') }}
                    </th>
                    <th class="whitespace-nowrap">
                      {{ t('events') }}
                    </th>
                    <th class="whitespace-nowrap">
                      {{ t('devices') }}
                    </th>
                    <th class="whitespace-nowrap">
                      {{ t('native-observe-p50') }}
                    </th>
                    <th class="whitespace-nowrap">
                      {{ t('native-observe-p90') }}
                    </th>
                    <th class="whitespace-nowrap">
                      {{ t('native-observe-p99') }}
                    </th>
                    <th class="text-right whitespace-nowrap">
                      {{ t('logs') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="action in topActions" :key="action.action">
                    <td class="font-medium text-slate-900 dark:text-slate-100">
                      {{ formatAction(action.action) }}
                    </td>
                    <td>
                      <span class="d-badge d-badge-sm" :class="action.is_issue ? 'd-badge-error' : 'd-badge-ghost'">
                        {{ action.is_issue ? t('native-observe-issue') : t('native-observe-context') }}
                      </span>
                    </td>
                    <td>{{ formatCount(action.events) }}</td>
                    <td>{{ formatCount(action.devices) }}</td>
                    <td>{{ formatDuration(action.p50_ms) }}</td>
                    <td>{{ formatDuration(action.p90_ms) }}</td>
                    <td>{{ formatDuration(action.p99_ms) }}</td>
                    <td class="text-right">
                      <button type="button" class="d-btn d-btn-ghost d-btn-xs" :title="t('native-observe-open-logs')" @click="openLogs(action.action)">
                        <IconExternalLink class="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
