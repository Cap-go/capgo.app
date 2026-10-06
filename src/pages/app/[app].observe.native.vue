<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { VersionGroupOption } from '~/components/dashboard/VersionGroupSelector.vue'
import type { NativeReleaseSeriesInput } from '~/services/nativeReleaseStats'
import type { ObserveSignalCategory } from '~/services/statsActions'
import type { PeriodDayOption } from '~/utils/periodDays'
import { BarElement, CategoryScale, Chart, Legend, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { Bar, Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconActivity from '~icons/lucide/activity'
import IconExternalLink from '~icons/lucide/external-link'
import IconTimer from '~icons/lucide/timer'
import { provideChartCardCompact } from '~/components/dashboard/chartCardDensity'
import DevicesStats from '~/components/dashboard/DevicesStats.vue'
import NativeReleaseStatsPanel from '~/components/dashboard/NativeReleaseStatsPanel.vue'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import VersionGroupSelector from '~/components/dashboard/VersionGroupSelector.vue'
import InfoPopover from '~/components/InfoPopover.vue'
import { useNativeObserveStats } from '~/composables/useNativeObserveStats'
import { usePeriodDaysQuery } from '~/composables/usePeriodDaysQuery'
import { formatLocalDateShort } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { actionToFilter, observeSignalCategory, observeSignalHelpKey } from '~/services/statsActions'
import { useDisplayStore } from '~/stores/display'

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend)

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
    issue_free_rate: number | null
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
  version_group: VersionGroupOption
  versions: Array<{
    version_name: string
    platform: string | null
    channel_name: string | null
    events: number
    devices: number
    issue_count: number
    affected_devices: number
    issue_free_rate: number | null
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
const { days } = usePeriodDaysQuery()
const versionGroup = ref<VersionGroupOption>('version')
const { stats, statsLoading, fetchStats } = useNativeObserveStats<NativeObserveStatsResponse>(
  packageId,
  () => ({ days: days.value, version_group: versionGroup.value }),
  'native observe stats',
)
provideChartCardCompact()

interface NativeUsageState {
  data: { labels: string[], datasets: NativeReleaseSeriesInput[] } | null
  isLoading: boolean
}
const nativeUsage = ref<NativeUsageState>({ data: null, isLoading: true })
const nativeDevicesStats = useTemplateRef<{ reload: () => Promise<void> }>('nativeDevicesStats')

type NativeDetailTab = 'versions' | 'actions' | 'releases'
const detailTab = ref<NativeDetailTab>('versions')

// Tables show their top rows so the page fits one screen; "show all" expands.
const PREVIEW_ROWS = 5
const showAllVersions = ref(false)
const showAllActions = ref(false)

const hasData = computed(() => (stats.value?.overview.total_events ?? 0) > 0)
const kpiTiles = computed(() => {
  const overview = stats.value?.overview
  const neutral = 'text-slate-950 dark:text-white'
  return [
    { label: t('native-observe-tracked-devices'), value: formatCount(overview?.total_devices), class: neutral, help: undefined as string | undefined },
    {
      label: t('native-observe-issue-free-rate'),
      value: formatPercent(overview?.issue_free_rate),
      // Informational, not a score: signals include noisy, often harmless events.
      class: neutral,
      help: t('native-observe-issue-free-rate-help'),
    },
    { label: t('native-observe-launch-p90'), value: formatDuration(overview?.launch_p90_ms), class: neutral },
    { label: t('native-observe-webview-p90'), value: formatDuration(overview?.webview_load_p90_ms), class: neutral },
    { label: t('native-observe-issues'), value: formatCount(overview?.issue_count), class: neutral },
  ]
})
const topActions = computed(() => stats.value?.actionBreakdown.slice(0, 10) ?? [])
const topVersions = computed(() => stats.value?.versions.slice(0, versionGroup.value === 'version' ? 8 : 24) ?? [])
const visibleVersions = computed(() => showAllVersions.value ? topVersions.value : topVersions.value.slice(0, PREVIEW_ROWS))
const visibleActions = computed(() => showAllActions.value ? topActions.value : topActions.value.slice(0, PREVIEW_ROWS))
const showPlatformColumn = computed(() => versionGroup.value !== 'version')
const showChannelColumn = computed(() => versionGroup.value === 'version_platform_channel')
const versionHealthHelp = computed(() => {
  if (versionGroup.value === 'version_platform_channel')
    return t('native-observe-version-health-help-platform-channel')
  if (versionGroup.value === 'version_platform')
    return t('native-observe-version-health-help-platform')
  return t('native-observe-version-health-help')
})
const detailTabs = computed(() => {
  const tabs: Array<{ key: NativeDetailTab, label: string, help: string }> = []
  if (hasData.value) {
    tabs.push({ key: 'versions', label: t('native-observe-version-health'), help: versionHealthHelp.value })
    tabs.push({ key: 'actions', label: t('native-observe-action-breakdown'), help: t('native-observe-action-breakdown-help') })
  }
  tabs.push({ key: 'releases', label: t('native-release-stats-title'), help: t('native-release-stats-help') })
  return tabs
})
// Without native observe events only the native release adoption tab exists.
const activeDetailTab = computed<NativeDetailTab>(() => detailTabs.value.some(tab => tab.key === detailTab.value) ? detailTab.value : 'releases')
const versionTableMinWidth = computed(() => {
  if (showChannelColumn.value)
    return 'min-w-[980px]'
  if (showPlatformColumn.value)
    return 'min-w-[860px]'
  return 'min-w-[760px]'
})

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
      backgroundColor: 'rgba(245, 158, 11, 0.6)',
      borderColor: 'rgb(245, 158, 11)',
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
    x: {
      grid: { display: false },
      offset: chartLabels.value.length <= 2,
    },
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
    x: {
      grid: { display: false },
      offset: chartLabels.value.length <= 2,
    },
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
  if (value === null || value === undefined)
    return '-'
  return `${formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
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

const signalBadgeClass: Record<ObserveSignalCategory, string> = {
  crash: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-200',
  web: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200',
  system: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-white/15 dark:bg-white/5 dark:text-slate-300',
  context: 'border-transparent bg-transparent text-slate-500 dark:text-slate-400',
}

function signalLabel(action: string) {
  const category = observeSignalCategory(action)
  if (category === 'crash')
    return t('native-observe-signal-crash')
  if (category === 'web')
    return t('native-observe-signal-web')
  if (category === 'system')
    return t('native-observe-signal-system')
  return t('native-observe-context')
}

function signalHelp(action: string) {
  const key = observeSignalHelpKey(action)
  return key ? t(key) : ''
}

function selectVersionGroup(option: VersionGroupOption) {
  if (versionGroup.value === option)
    return
  versionGroup.value = option
}

function versionRowKey(version: NativeObserveStatsResponse['versions'][number]) {
  return [version.version_name, version.platform ?? '', version.channel_name ?? ''].join('\0')
}

function openLogs(action: string) {
  if (!stats.value)
    return

  router.push({
    path: `/app/${appRouteSegment.value}/observe/logs`,
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

watch([packageId, days, versionGroup], async () => {
  await fetchStats()
}, { immediate: true })
</script>

<template>
  <div class="w-full h-full px-4 pt-4 mx-auto mb-8 sm:px-6 lg:px-8 max-w-9xl max-h-fit">
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center min-w-0 gap-1">
          <p
            class="text-sm truncate text-slate-500 dark:text-slate-400"
            data-testid="observe-period-labels"
            :data-count="stats?.labels.length ?? 0"
            :title="observeOverviewHelp"
          >
            {{ observeScopeLabel }}
          </p>
          <InfoPopover :label="t('native-observe-signals-note-title')">
            <div data-testid="observe-signals-note">
              <div class="font-semibold text-slate-900 dark:text-slate-100">
                {{ t('native-observe-signals-note-title') }}
              </div>
              <p class="mt-1 text-slate-600 dark:text-slate-300">
                {{ t('native-observe-subtitle') }} {{ t('native-observe-signals-note-body') }}
              </p>
              <ul class="flex flex-col gap-2 mt-3">
                <li class="flex items-center gap-2">
                  <span class="px-1.5 py-0.5 text-[11px] font-medium rounded border shrink-0" :class="signalBadgeClass.crash">{{ t('native-observe-signal-crash') }}</span>
                  <span class="text-xs text-slate-600 dark:text-slate-400">{{ t('native-observe-signals-note-crash') }}</span>
                </li>
                <li class="flex items-center gap-2">
                  <span class="px-1.5 py-0.5 text-[11px] font-medium rounded border shrink-0" :class="signalBadgeClass.web">{{ t('native-observe-signal-web') }}</span>
                  <span class="text-xs text-slate-600 dark:text-slate-400">{{ t('native-observe-signals-note-web') }}</span>
                </li>
                <li class="flex items-center gap-2">
                  <span class="px-1.5 py-0.5 text-[11px] font-medium rounded border shrink-0" :class="signalBadgeClass.system">{{ t('native-observe-signal-system') }}</span>
                  <span class="text-xs text-slate-600 dark:text-slate-400">{{ t('native-observe-signals-note-system') }}</span>
                </li>
              </ul>
            </div>
          </InfoPopover>
        </div>
        <PeriodDaySelector v-model="days" />
      </div>

      <div v-if="statsLoading && !stats" class="flex items-center justify-center h-80">
        <Spinner size="w-12 h-12" />
      </div>

      <template v-else>
        <div v-if="hasData" class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <div v-for="tile in kpiTiles" :key="tile.label" :title="tile.help" class="px-4 py-3 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
            <div class="text-xs truncate text-slate-600 dark:text-slate-400">
              {{ tile.label }}
            </div>
            <div class="mt-1 text-xl font-semibold" :class="tile.class">
              {{ tile.value }}
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <DevicesStats
            ref="nativeDevicesStats"
            :app-id="packageId"
            usage-kind="native"
            variant="chart"
            :use-billing-period="false"
            :accumulated="false"
            @native-usage="nativeUsage = $event"
          />
          <div v-if="hasData" class="flex flex-col h-[320px] p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
            <div class="flex items-center justify-between gap-3 mb-3">
              <h2 class="text-base font-semibold text-slate-950 dark:text-white" :title="t('native-observe-performance-help')">
                {{ t('native-observe-performance') }}
              </h2>
              <IconTimer class="w-5 h-5 text-sky-500" />
            </div>
            <div class="relative flex-1 min-h-0">
              <Line :data="performanceChartData" :options="performanceChartOptions" />
            </div>
          </div>
          <div v-if="hasData" class="flex flex-col h-[320px] p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
            <div class="flex items-center justify-between gap-3 mb-3">
              <h2 class="text-base font-semibold text-slate-950 dark:text-white" :title="t('native-observe-volume-help')">
                {{ t('native-observe-volume') }}
              </h2>
              <IconActivity class="w-5 h-5 text-emerald-500" />
            </div>
            <div class="relative flex-1 min-h-0">
              <Bar :data="eventChartData" :options="eventChartOptions" />
            </div>
          </div>
          <div v-if="!hasData && !statsLoading" class="flex flex-col items-center justify-center h-[320px] bg-white border rounded-xl shadow-sm xl:col-span-2 dark:bg-slate-800/60 border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400">
            <IconActivity class="w-12 h-12 mb-3" />
            <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-100">
              {{ t('native-observe-no-data') }}
            </h2>
            <p class="mt-1 text-sm text-center text-slate-500 dark:text-slate-400">
              {{ t('native-observe-no-data-help') }}
            </p>
          </div>
        </div>

        <!-- One detail table at a time keeps the page on one screen. -->
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" class="inline-flex p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800" data-testid="native-detail-tabs">
            <button
              v-for="tab in detailTabs"
              :key="tab.key"
              type="button"
              role="tab"
              :aria-selected="activeDetailTab === tab.key"
              :title="tab.help"
              class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors"
              :class="activeDetailTab === tab.key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'"
              @click="detailTab = tab.key"
            >
              {{ tab.label }}
            </button>
          </div>
          <VersionGroupSelector v-if="activeDetailTab === 'versions'" :model-value="versionGroup" @update:model-value="selectVersionGroup" />
        </div>

        <div v-if="activeDetailTab === 'versions'" class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
          <div class="overflow-x-auto">
            <table class="d-table d-table-sm w-full" :class="versionTableMinWidth">
              <thead class="text-[11px] font-semibold tracking-wider uppercase border-y border-slate-200 text-slate-500 bg-slate-50 dark:border-white/10 dark:text-slate-400 dark:bg-white/[0.03]">
                <tr>
                  <th class="whitespace-nowrap">
                    {{ t('native-observe-version') }}
                  </th>
                  <th v-if="showPlatformColumn" class="whitespace-nowrap">
                    {{ t('native-observe-platform') }}
                  </th>
                  <th v-if="showChannelColumn" class="whitespace-nowrap">
                    {{ t('native-observe-channel') }}
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
                <tr v-for="version in visibleVersions" :key="versionRowKey(version)">
                  <td class="font-medium text-slate-900 dark:text-slate-100">
                    {{ version.version_name }}
                  </td>
                  <td v-if="showPlatformColumn">
                    {{ version.platform || '-' }}
                  </td>
                  <td v-if="showChannelColumn">
                    {{ version.channel_name || '-' }}
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
          <button
            v-if="topVersions.length > PREVIEW_ROWS"
            type="button"
            class="mt-3 text-xs font-medium text-azure-600 hover:underline dark:text-azure-300"
            @click="showAllVersions = !showAllVersions"
          >
            {{ showAllVersions ? t('show-less') : t('show-all-count', { count: topVersions.length }) }}
          </button>
        </div>
        <div v-else-if="activeDetailTab === 'actions'" class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
          <div class="overflow-x-auto">
            <table class="d-table d-table-sm w-full min-w-[820px]">
              <thead class="text-[11px] font-semibold tracking-wider uppercase border-y border-slate-200 text-slate-500 bg-slate-50 dark:border-white/10 dark:text-slate-400 dark:bg-white/[0.03]">
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
                <tr v-for="action in visibleActions" :key="action.action">
                  <td class="min-w-[220px] max-w-[380px]">
                    <div class="font-medium text-slate-900 dark:text-slate-100">
                      {{ formatAction(action.action) }}
                    </div>
                    <div v-if="signalHelp(action.action)" class="mt-0.5 text-xs font-normal whitespace-normal text-slate-500 dark:text-slate-400">
                      {{ signalHelp(action.action) }}
                    </div>
                  </td>
                  <td>
                    <span class="inline-block px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border" :class="signalBadgeClass[observeSignalCategory(action.action)]">
                      {{ signalLabel(action.action) }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap">
                    {{ formatCount(action.events) }}
                  </td>
                  <td class="whitespace-nowrap">
                    {{ formatCount(action.devices) }}
                  </td>
                  <td class="whitespace-nowrap">
                    {{ formatDuration(action.p50_ms) }}
                  </td>
                  <td class="whitespace-nowrap">
                    {{ formatDuration(action.p90_ms) }}
                  </td>
                  <td class="whitespace-nowrap">
                    {{ formatDuration(action.p99_ms) }}
                  </td>
                  <td class="text-right">
                    <button type="button" class="d-btn d-btn-ghost d-btn-xs" :title="t('native-observe-open-logs')" @click="openLogs(action.action)">
                      <IconExternalLink class="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <button
            v-if="topActions.length > PREVIEW_ROWS"
            type="button"
            class="mt-3 text-xs font-medium text-azure-600 hover:underline dark:text-azure-300"
            @click="showAllActions = !showAllActions"
          >
            {{ showAllActions ? t('show-less') : t('show-all-count', { count: topActions.length }) }}
          </button>
        </div>
        <NativeReleaseStatsPanel
          v-else
          :usage-data="nativeUsage.data"
          :is-loading="nativeUsage.isLoading"
          @retry="nativeDevicesStats?.reload()"
        />
      </template>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
