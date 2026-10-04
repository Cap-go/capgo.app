<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { Component } from 'vue'
import { useDark } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { Bar } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import IconAlertTriangle from '~icons/lucide/alert-triangle'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheckCircle from '~icons/lucide/check-circle'
import IconPuzzle from '~icons/lucide/puzzle'
import IconRocket from '~icons/lucide/rocket'
import IconSmartphone from '~icons/lucide/smartphone'
import AttentionBar from '~/components/dashboard/AttentionBar.vue'
import { provideChartCardCompact } from '~/components/dashboard/chartCardDensity'
import DevicesStats from '~/components/dashboard/DevicesStats.vue'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import Spinner from '~/components/Spinner.vue'
import { useNativeObserveStats } from '~/composables/useNativeObserveStats'
import { usePeriodDaysQuery } from '~/composables/usePeriodDaysQuery'
import { buildDemoReleaseLive, useReleaseLive } from '~/composables/useReleaseLive'
import { groupCompatibilityEvents } from '~/services/compatibilityEvents'
import { registerDashboardCharts } from '~/services/dashboardChartRegister'
import { formatLocalDateShort, formatLocalTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { actionToFilter, updaterInsightActions } from '~/services/statsActions'
import { defaultApiHost, useSupabase } from '~/services/supabase'

// One-screen answer to "is my app healthy right now?". Every tile and issue
// links to the Observe tab that holds the detail.
const props = withDefaults(defineProps<{
  appId: string
  forceDemo?: boolean
}>(), {
  forceDemo: false,
})

const emit = defineEmits<{
  deployed: []
}>()

registerDashboardCharts()
provideChartCardCompact()

const { t } = useI18n()
const isDark = useDark()
const supabase = useSupabase()
const { days } = usePeriodDaysQuery()

const basePath = computed(() => `/app/${encodeURIComponent(props.appId)}`)
const periodQuery = computed(() => ({ days: String(days.value) }))

// Latest release on the default channel.
const { data: liveData, loading: liveLoading } = useReleaseLive(() => ({
  app_id: props.appId,
  enabled: !props.forceDemo && !!props.appId,
}))
const live = computed(() => props.forceDemo ? buildDemoReleaseLive() : liveData.value)
const release = computed(() => live.value?.release ?? null)
const adoption = computed(() => live.value?.adoption ?? null)
const totals = computed(() => live.value?.totals ?? null)

// Updater failures for the selected period.
interface InsightsResponse {
  summary: { total: number, device_count: number, action_count: number }
  actions: Array<{ action: string, total: number, device_count: number }>
}
const insights = ref<InsightsResponse | null>(null)
const insightsLoading = ref(false)
let insightsRequest = 0

async function fetchInsights() {
  const requestId = ++insightsRequest
  if (!props.appId || props.forceDemo) {
    insights.value = null
    return
  }
  insightsLoading.value = true
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session)
      return
    const response = await fetch(`${defaultApiHost}/private/stats/insights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${sessionData.session.access_token}`,
      },
      body: JSON.stringify({ appId: props.appId, days: days.value, actions: updaterInsightActions }),
    })
    if (requestId !== insightsRequest)
      return
    insights.value = response.ok ? await response.json() as InsightsResponse : null
  }
  catch (error) {
    console.error('Failed to fetch overview insights:', error)
    if (requestId === insightsRequest)
      insights.value = null
  }
  finally {
    if (requestId === insightsRequest)
      insightsLoading.value = false
  }
}

// Native health for the selected period.
interface NativeOverviewResponse {
  overview: { total_devices: number, issue_free_rate: number | null, issue_count: number }
  actionBreakdown: Array<{ action: string, events: number, devices: number, is_issue: boolean }>
}
const { stats: nativeStats, statsLoading: nativeLoading, fetchStats: fetchNativeStats } = useNativeObserveStats<NativeOverviewResponse>(
  () => props.appId,
  () => ({ days: days.value, version_group: 'version' }),
  'overview native stats',
)

// Unresolved compatibility occurrences, grouped like the Compatibility tab.
const compatibilityCount = ref<number | null>(null)
async function fetchCompatibility() {
  if (!props.appId || props.forceDemo) {
    compatibilityCount.value = null
    return
  }
  const requestedAppId = props.appId
  const { data, error } = await supabase
    .from('compatibility_events')
    .select('id, platform, channel_id, current_version_id, previous_version_id, source, change_occurred_at, created_at, resolved_at')
    .eq('app_id', requestedAppId)
    .is('resolved_at', null)
  if (requestedAppId !== props.appId)
    return
  compatibilityCount.value = error ? null : groupCompatibilityEvents(data ?? []).length
}

watch(() => props.appId, () => {
  void fetchCompatibility()
}, { immediate: true })

watch(() => [props.appId, days.value, props.forceDemo] as const, () => {
  void fetchInsights()
  if (props.appId && !props.forceDemo)
    void fetchNativeStats()
}, { immediate: true })

function formatCount(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : formatNumberValue(Math.round(value))
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '-'
  return `${formatNumberValue(value, { maximumFractionDigits: 1 })}%`
}

function formatAction(action: string) {
  const filterKey = actionToFilter[action]
  return filterKey ? t(filterKey) : action
}

function rateClass(rate: number | null | undefined, good = 95, watchFrom = 85) {
  if (rate === null || rate === undefined)
    return 'text-slate-900 dark:text-white'
  if (rate >= good)
    return 'text-emerald-600 dark:text-emerald-400'
  if (rate >= watchFrom)
    return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
}

interface KpiTile {
  key: string
  label: string
  value: string
  detail: string
  valueClass: string
  to: { path: string, query?: Record<string, string> }
  loading: boolean
}

const kpiTiles = computed<KpiTile[]>(() => {
  const neutral = 'text-slate-900 dark:text-white'
  const errorTotal = insights.value?.summary.total ?? null
  const issueFree = nativeStats.value?.overview.issue_free_rate ?? null
  return [
    {
      key: 'release',
      label: t('overview-kpi-latest-release'),
      value: release.value?.version_name ?? '-',
      detail: adoption.value?.percent != null
        ? t('overview-kpi-adoption', { percent: formatPercent(adoption.value.percent) })
        : (release.value?.channel_name ?? t('release-live-no-release')),
      valueClass: neutral,
      to: { path: `${basePath.value}/observe/releases` },
      loading: liveLoading.value && !live.value,
    },
    {
      key: 'install-success',
      label: t('bundle-install-success-rate'),
      value: formatPercent(totals.value?.success_rate),
      detail: t('overview-kpi-installs', { count: formatCount(totals.value?.install ?? 0) }),
      valueClass: rateClass(totals.value?.success_rate),
      to: { path: `${basePath.value}/observe/releases` },
      loading: liveLoading.value && !live.value,
    },
    {
      key: 'devices',
      label: t('overview-kpi-devices'),
      value: formatCount(adoption.value?.total_devices),
      detail: release.value?.channel_name ?? '',
      valueClass: neutral,
      to: { path: `${basePath.value}/devices` },
      loading: liveLoading.value && !live.value,
    },
    {
      key: 'errors',
      label: t('overview-kpi-update-errors'),
      value: formatCount(errorTotal),
      detail: t('affected-devices-count', { count: formatCount(insights.value?.summary.device_count ?? 0) }),
      valueClass: errorTotal ? 'text-amber-600 dark:text-amber-400' : (errorTotal === 0 ? 'text-emerald-600 dark:text-emerald-400' : neutral),
      to: { path: `${basePath.value}/observe/errors`, query: periodQuery.value },
      loading: insightsLoading.value && !insights.value,
    },
    {
      key: 'native',
      label: t('native-observe-issue-free-rate'),
      value: formatPercent(issueFree),
      detail: t('overview-kpi-native-issues', { count: formatCount(nativeStats.value?.overview.issue_count ?? 0) }),
      valueClass: rateClass(issueFree, 99, 95),
      to: { path: `${basePath.value}/observe/native`, query: periodQuery.value },
      loading: nativeLoading.value && !nativeStats.value,
    },
    {
      key: 'compatibility',
      label: t('compatibility'),
      value: compatibilityCount.value === null ? '-' : formatCount(compatibilityCount.value),
      detail: t('overview-kpi-unresolved'),
      valueClass: compatibilityCount.value ? 'text-amber-600 dark:text-amber-400' : (compatibilityCount.value === 0 ? 'text-emerald-600 dark:text-emerald-400' : neutral),
      to: { path: `${basePath.value}/observe/compatibility` },
      loading: false,
    },
  ]
})

interface TopIssue {
  key: string
  icon: Component
  title: string
  detail: string
  to: { path: string, query?: Record<string, string> }
}

const topIssues = computed<TopIssue[]>(() => {
  const issues: TopIssue[] = []
  const topError = insights.value?.actions[0]
  if (topError) {
    issues.push({
      key: 'updater',
      icon: IconAlertTriangle,
      title: formatAction(topError.action),
      detail: t('overview-issue-updater', { count: formatCount(topError.total), devices: formatCount(topError.device_count) }),
      to: { path: `${basePath.value}/observe/errors`, query: periodQuery.value },
    })
  }
  const topNative = nativeStats.value?.actionBreakdown.find(action => action.is_issue)
  if (topNative) {
    issues.push({
      key: 'native',
      icon: IconSmartphone,
      title: formatAction(topNative.action),
      detail: t('overview-issue-native', { count: formatCount(topNative.events), devices: formatCount(topNative.devices) }),
      to: { path: `${basePath.value}/observe/native`, query: periodQuery.value },
    })
  }
  if (compatibilityCount.value) {
    issues.push({
      key: 'compatibility',
      icon: IconPuzzle,
      title: t('compatibility-events'),
      detail: t('compatibility-unresolved-banner', { count: compatibilityCount.value }),
      to: { path: `${basePath.value}/observe/compatibility` },
    })
  }
  return issues
})

const issuesLoading = computed(() => (insightsLoading.value && !insights.value) || (nativeLoading.value && !nativeStats.value))

// Install/failure activity of the latest release, same series as Releases.
const series = computed(() => live.value?.series ?? [])
const hasActivity = computed(() => series.value.some(bucket => bucket.install + bucket.fail > 0))
const spansMultipleDays = computed(() => {
  const window = live.value?.window
  return !!window && Date.parse(window.end) - Date.parse(window.start) > 24 * 60 * 60 * 1000
})

const chartData = computed<ChartData<'bar'>>(() => ({
  labels: series.value.map(bucket => spansMultipleDays.value
    ? `${formatLocalDateShort(bucket.ts)} ${formatLocalTime(bucket.ts)}`
    : formatLocalTime(bucket.ts)),
  datasets: [
    {
      label: t('release-live-installs'),
      data: series.value.map(bucket => bucket.install),
      backgroundColor: '#10b981',
      borderRadius: 2,
      stack: 'activity',
    },
    {
      label: t('release-live-failures'),
      data: series.value.map(bucket => bucket.fail),
      backgroundColor: isDark.value ? 'rgba(251, 113, 133, 0.55)' : '#fda4af',
      borderRadius: 2,
      stack: 'activity',
    },
  ],
}))

const chartOptions = computed<ChartOptions<'bar'>>(() => {
  const tickColor = isDark.value ? '#94a3b8' : '#64748b'
  const gridColor = isDark.value ? 'rgba(148, 163, 184, 0.12)' : 'rgba(100, 116, 139, 0.12)'
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { color: tickColor, boxWidth: 12 } },
      tooltip: { enabled: true },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: tickColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { stacked: true, beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, precision: 0 } },
    },
  }
})
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="app-overview">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-start">
      <AttentionBar
        v-if="!forceDemo"
        class="flex-1"
        :app-id="appId"
        :release="release"
        :adoption-percent="adoption?.percent ?? null"
        @deployed="emit('deployed')"
      />
      <PeriodDaySelector v-model="days" class="self-end lg:ml-auto lg:self-start" />
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="overview-kpis">
      <RouterLink
        v-for="tile in kpiTiles"
        :key="tile.key"
        :to="tile.to"
        class="flex flex-col min-w-0 px-4 py-3 transition-colors bg-white border shadow-sm group rounded-xl border-slate-200 hover:border-azure-400 dark:bg-slate-800/60 dark:border-white/10 dark:hover:border-azure-500/60"
        :data-testid="`overview-kpi-${tile.key}`"
      >
        <span class="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span class="truncate">{{ tile.label }}</span>
          <IconArrowRight class="w-3.5 h-3.5 opacity-0 transition-opacity shrink-0 group-hover:opacity-100" />
        </span>
        <span v-if="tile.loading" class="flex items-center h-8 mt-1">
          <Spinner size="w-5 h-5" />
        </span>
        <span v-else class="mt-1 text-2xl font-semibold truncate" :class="tile.valueClass">{{ tile.value }}</span>
        <span class="text-xs truncate text-slate-500 dark:text-slate-400">{{ tile.detail || ' ' }}</span>
      </RouterLink>
    </div>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section class="flex flex-col p-4 bg-white border shadow-sm rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10 h-[320px]">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div class="flex items-center min-w-0 gap-2">
            <IconRocket class="w-4 h-4 text-azure-500 shrink-0" />
            <h2 class="text-base font-semibold truncate text-slate-900 dark:text-white">
              {{ t('release-live-chart-title') }}
            </h2>
            <span v-if="release" class="text-xs truncate text-slate-500 dark:text-slate-400">{{ release.version_name }}</span>
          </div>
          <RouterLink :to="`${basePath}/observe/releases`" class="text-xs font-medium text-azure-600 shrink-0 hover:underline dark:text-azure-300">
            {{ t('overview-open-releases') }}
          </RouterLink>
        </div>
        <div v-if="liveLoading && !live" class="flex items-center justify-center flex-1">
          <Spinner size="w-10 h-10" />
        </div>
        <div v-else-if="!release || !hasActivity" class="flex flex-col items-center justify-center flex-1 gap-1 text-sm text-center text-slate-500 dark:text-slate-400">
          <IconRocket class="w-8 h-8" />
          {{ release ? t('release-live-waiting') : t('release-live-no-release') }}
        </div>
        <div v-else class="relative flex-1 min-h-0">
          <Bar :data="chartData" :options="chartOptions" />
        </div>
      </section>

      <DevicesStats
        :app-id="appId"
        usage-kind="bundle"
        variant="chart"
        :use-billing-period="false"
        :accumulated="false"
        :force-demo="forceDemo"
      />
    </div>

    <section class="p-4 bg-white border shadow-sm rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10" data-testid="overview-top-issues">
      <h2 class="mb-3 text-base font-semibold text-slate-900 dark:text-white">
        {{ t('overview-top-issues') }}
      </h2>
      <div v-if="issuesLoading" class="flex items-center justify-center h-14">
        <Spinner size="w-6 h-6" />
      </div>
      <div v-else-if="!topIssues.length" class="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
        <IconCheckCircle class="w-5 h-5" />
        {{ t('overview-no-issues') }}
      </div>
      <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <RouterLink
          v-for="issue in topIssues"
          :key="issue.key"
          :to="issue.to"
          class="flex items-center gap-3 px-3 py-2 border rounded-lg border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700/40"
        >
          <component :is="issue.icon" class="w-5 h-5 text-amber-500 shrink-0" />
          <span class="min-w-0">
            <span class="block text-sm font-medium truncate text-slate-900 dark:text-white">{{ issue.title }}</span>
            <span class="block text-xs truncate text-slate-500 dark:text-slate-400">{{ issue.detail }}</span>
          </span>
          <IconArrowRight class="w-4 h-4 ml-auto text-slate-400 shrink-0" />
        </RouterLink>
      </div>
    </section>
  </div>
</template>
