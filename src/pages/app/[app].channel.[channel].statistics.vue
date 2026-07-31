<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { TooltipClickHandler } from '~/services/chartTooltip'
import type { Database } from '~/types/supabase.types'
import { CategoryScale, Chart, Filler, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { computed, ref, watchEffect } from 'vue'
import { Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconAlertTriangle from '~icons/lucide/alert-triangle'
import IconCheckCircle from '~icons/lucide/check-circle'
import IconTrendingUp from '~icons/lucide/trending-up'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import { createTooltipConfig } from '~/services/chartTooltip'
import { formatDistanceToNow, formatLocalDate, formatLocalDateShort } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDisplayStore } from '~/stores/display'

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

interface Channel {
  version: Database['public']['Tables']['app_versions']['Row']
}

interface ChannelStatsResponse {
  labels: string[]
  datasets: Array<{ label: string, data: number[], metaCounts?: number[] }>
  dailyTotals: number[]
  latestVersion: {
    name: string
    percentage: string
  }
  currentVersion: string
  currentVersionReleasedAt: string | null
  period: {
    requested_days: number
    actual_days: number
    start: string
    end: string
    start_reason: 'requested_days' | 'current_version_release'
  }
  deploymentHistory: Array<{ version_name: string, deployed_at: string }>
  lastDeploymentAt: string | null
  totalDeployments: number
  totals: {
    total_devices: number
    devices_on_current: number
    devices_on_other: number
    percent_on_current: number
  }
}

type ChannelAdoptionStatus = 'loading' | 'no-devices' | 'ramping' | 'healthy' | 'warning' | 'critical'

function getHoursSinceRelease(releasedAt: string | null | undefined): number | null {
  if (!releasedAt)
    return null

  const releaseDate = new Date(releasedAt)
  if (Number.isNaN(releaseDate.getTime()))
    return null

  const elapsedMs = Date.now() - releaseDate.getTime()
  if (elapsedMs < 0)
    return 0

  return elapsedMs / (1000 * 60 * 60)
}

function getThresholdStatus(
  percentOnCurrent: number,
  healthyThreshold: number,
  warningThreshold: number,
  lowStatus: ChannelAdoptionStatus = 'critical',
): ChannelAdoptionStatus {
  if (percentOnCurrent >= healthyThreshold)
    return 'healthy'
  if (percentOnCurrent >= warningThreshold)
    return 'warning'
  return lowStatus
}

function getAdoptionStatus(percentOnCurrent: number, totalDevices: number, hoursSinceRelease: number | null): ChannelAdoptionStatus {
  if (totalDevices <= 0)
    return 'no-devices'

  if (hoursSinceRelease === null)
    return getThresholdStatus(percentOnCurrent, 90, 50)
  if (hoursSinceRelease < 24)
    return getThresholdStatus(percentOnCurrent, 50, 10, 'ramping')
  if (hoursSinceRelease < 72)
    return getThresholdStatus(percentOnCurrent, 75, 25)
  if (hoursSinceRelease < 168)
    return getThresholdStatus(percentOnCurrent, 85, 45)
  return getThresholdStatus(percentOnCurrent, 90, 60)
}

const route = useRoute('/app/[app].channel.[channel].statistics')
const router = useRouter()
const displayStore = useDisplayStore()
const appDetailStore = useAppDetailStore()
const { t } = useI18n()
const supabase = useSupabase()

const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const statsLoading = ref(true)
const channel = ref<Database['public']['Tables']['channels']['Row'] & Channel>()
type PeriodDayOption = 1 | 3 | 7 | 30
const days = ref<PeriodDayOption>(30)
const stats = ref<ChannelStatsResponse | null>(null)
const bundleIdCache = ref<Record<string, number>>({})
let latestStatsRequest = 0
const versionByLabel = computed(() => {
  const mapping: Record<string, string> = {}
  const datasets = stats.value?.datasets ?? []
  datasets.forEach((dataset) => {
    mapping[dataset.label] = dataset.label
  })
  return mapping
})

async function navigateToBundle(versionName: string) {
  if (!packageId.value)
    return
  if (bundleIdCache.value[versionName]) {
    router.push(`/app/${packageId.value}/bundle/${bundleIdCache.value[versionName]}`)
    return
  }
  const { data } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', packageId.value)
    .eq('name', versionName)
    .limit(1)
    .single()
  if (data?.id) {
    bundleIdCache.value[versionName] = data.id
    router.push(`/app/${packageId.value}/bundle/${data.id}`)
  }
}

const tooltipClickHandler = computed<TooltipClickHandler | undefined>(() => {
  if (!stats.value?.datasets?.length)
    return undefined
  return {
    onAppClick: navigateToBundle,
    appIdByLabel: versionByLabel.value,
  }
})

const percentOnCurrent = computed(() => stats.value?.totals.percent_on_current ?? 0)
const totalDevices = computed(() => stats.value?.totals.total_devices ?? 0)
const devicesOnCurrent = computed(() => stats.value?.totals.devices_on_current ?? 0)
const hoursSinceCurrentVersionRelease = computed(() => getHoursSinceRelease(stats.value?.currentVersionReleasedAt))

const statusType = computed<ChannelAdoptionStatus>(() => {
  if (!stats.value)
    return 'loading'
  return getAdoptionStatus(percentOnCurrent.value, totalDevices.value, hoursSinceCurrentVersionRelease.value)
})

const statusMessage = computed(() => {
  const percent = formatNumberValue(percentOnCurrent.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  switch (statusType.value) {
    case 'loading':
      return t('loading-statistics')
    case 'no-devices':
      return t('no-devices-on-channel')
    case 'ramping':
      return t('partial-adoption', { percent })
    case 'healthy':
      return t('updates-working-well', { percent })
    case 'warning':
      return t('partial-adoption', { percent })
    case 'critical':
      return t('low-adoption-warning', { percent })
    default:
      return ''
  }
})

const currentVersionDeployLabel = computed(() => {
  if (!stats.value?.currentVersionReleasedAt)
    return '-'
  const date = new Date(stats.value.currentVersionReleasedAt)
  if (Number.isNaN(date.getTime()))
    return '-'
  const diffMs = Date.now() - date.getTime()
  if (diffMs < 24 * 60 * 60 * 1000)
    return formatDistanceToNow(date)
  return formatLocalDate(date) || '-'
})

function formatPercent(value: number) {
  if (!Number.isFinite(value))
    return `${formatNumberValue(0, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

  return `${formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatPercentRange(start: number, end: number) {
  return `${formatPercent(start)} -> ${formatPercent(end)}`
}

function formatCount(value: number | null | undefined) {
  return formatNumberValue(Math.round(value ?? 0))
}

function formatShortDate(value: string | null | undefined) {
  if (!value)
    return '-'

  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return '-'

  return formatLocalDateShort(date) || '-'
}

const currentVersionDataset = computed(() => {
  if (!stats.value?.currentVersion)
    return null

  return stats.value.datasets.find(dataset => dataset.label === stats.value?.currentVersion) ?? null
})

const selectedPeriodLabel = computed(() => {
  if (days.value === 1)
    return t('last-one-day')

  const period = stats.value?.period
  if (period?.start_reason === 'current_version_release') {
    const key = period.actual_days === 1 ? 'since-current-release-one-day' : 'since-current-release-days'
    return t(key, { days: period.actual_days })
  }

  return t('last-n-days', { days: days.value })
})
const periodTimespanLabel = computed(() => {
  const labels = stats.value?.labels ?? []
  if (labels.length > 0)
    return `${formatShortDate(labels[0])} - ${formatShortDate(labels[labels.length - 1])}`

  const period = stats.value?.period
  if (period)
    return `${formatShortDate(period.start)} - ${formatShortDate(period.end)}`

  return '-'
})

async function selectPeriod(option: PeriodDayOption) {
  if (days.value === option)
    return

  days.value = option
  await fetchStats()
}

const periodSummary = computed(() => {
  const dataset = currentVersionDataset.value
  const labels = stats.value?.labels ?? []
  const datasets = stats.value?.datasets ?? []

  if (!dataset || labels.length === 0)
    return null

  const normalizedShares = labels.map((_, index) => {
    const rawValue = dataset.data?.[index]
    const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue)
    return Number.isFinite(numeric) ? numeric : 0
  })

  const normalizedCounts = labels.map((_, index) => {
    const rawValue = dataset.metaCounts?.[index]
    const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue)
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
  })

  if (normalizedShares.length === 0)
    return null

  const dailyTotalAt = (index: number) => {
    const rawTotal = stats.value?.dailyTotals?.[index]
    const backendTotal = typeof rawTotal === 'number' ? rawTotal : Number(rawTotal)
    if (Number.isFinite(backendTotal))
      return Math.max(0, Math.round(backendTotal))

    return datasets.reduce((sum, currentDataset) => {
      const rawValue = currentDataset.metaCounts?.[index]
      const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue)
      return sum + (Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0)
    }, 0)
  }

  const latestIndex = normalizedShares.length - 1
  const startShare = normalizedShares[0] ?? 0
  const latestShare = normalizedShares[latestIndex] ?? 0
  const changeShare = latestShare - startShare
  const periodTotal = labels.reduce((sum, _, index) => sum + dailyTotalAt(index), 0)

  return {
    startShare,
    startCount: normalizedCounts[0] ?? 0,
    startTotal: dailyTotalAt(0),
    latestShare,
    latestCount: normalizedCounts[latestIndex] ?? 0,
    latestTotal: dailyTotalAt(latestIndex),
    periodTotal,
    startDateLabel: formatShortDate(labels[0]),
    latestDateLabel: formatShortDate(labels[latestIndex]),
    changeShare,
  }
})

const statusDetail = computed(() => {
  if (!stats.value || totalDevices.value <= 0)
    return ''

  const base = t('current-version-check-ins-in-period', {
    current: formatCount(devicesOnCurrent.value),
    total: formatCount(totalDevices.value),
    period: selectedPeriodLabel.value,
    range: periodTimespanLabel.value,
  })
  if (statusType.value !== 'ramping')
    return base

  const releaseLabel = currentVersionDeployLabel.value
  if (!releaseLabel || releaseLabel === '-')
    return base

  return `${base} • ${t('released')}: ${releaseLabel}`
})

const adoptionRateColorClass = computed(() => {
  switch (statusType.value) {
    case 'healthy':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'warning':
      return 'text-amber-600 dark:text-amber-400'
    case 'critical':
      return 'text-rose-600 dark:text-rose-400'
    case 'ramping':
      return 'text-sky-600 dark:text-sky-400'
    default:
      return 'text-slate-600 dark:text-slate-300'
  }
})

const chartPalette = [
  { border: 'rgb(34, 197, 94)', background: 'rgba(34, 197, 94, 0.3)' },
  { border: 'rgb(251, 146, 60)', background: 'rgba(251, 146, 60, 0.3)' },
  { border: 'rgb(244, 63, 94)', background: 'rgba(244, 63, 94, 0.3)' },
  { border: 'rgb(59, 130, 246)', background: 'rgba(59, 130, 246, 0.3)' },
  { border: 'rgb(168, 85, 247)', background: 'rgba(168, 85, 247, 0.3)' },
  { border: 'rgb(16, 185, 129)', background: 'rgba(16, 185, 129, 0.3)' },
] as const

const chartData = computed<ChartData<'line'>>(() => {
  if (!stats.value) {
    return {
      labels: [],
      datasets: [],
    }
  }

  return {
    labels: stats.value.labels.map((d) => {
      return formatLocalDateShort(d) || d
    }),
    datasets: stats.value.datasets.map((dataset, index) => {
      const color = chartPalette[index % chartPalette.length]
      const metaCounts = Array.isArray(dataset.metaCounts)
        ? dataset.metaCounts.map(value => Math.max(0, Math.round(Number(value) || 0)))
        : undefined
      return {
        label: dataset.label,
        data: dataset.data,
        ...(metaCounts ? { metaCountValues: metaCounts } : {}),
        backgroundColor: color.background,
        borderColor: color.border,
        borderWidth: 2,
        fill: false,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 5,
      }
    }),
  }
})

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: {
      display: false,
    },
    tooltip: createTooltipConfig(true, false, undefined, tooltipClickHandler.value),
  },
  scales: {
    x: {
      grid: {
        display: false,
      },
      ticks: {
        font: {
          size: 11,
        },
      },
    },
    y: {
      beginAtZero: true,
      max: 100,
      grid: {
        color: 'rgba(0, 0, 0, 0.05)',
      },
      ticks: {
        font: {
          size: 11,
        },
        callback: (value: string | number) => `${value}%`,
      },
    },
  },
} as unknown as ChartOptions<'line'>))

async function getChannel() {
  if (!id.value)
    return

  if (appDetailStore.currentChannelId === id.value && appDetailStore.currentChannel) {
    channel.value = appDetailStore.currentChannel as any
    if (channel.value?.name)
      displayStore.setChannelName(String(channel.value.id), channel.value.name)
    displayStore.NavTitle = channel.value?.name ?? t('channel')
    return
  }

  try {
    const { data, error } = await supabase
      .from('channels')
      .select(`
          id,
          name,
          public,
          owner_org,
          version:app_versions!channels_version_fkey(
            id,
            name,
            app_id,
            created_at,
            min_update_version,
            storage_provider,
            link,
            comment
          ),
          created_at,
          app_id,
          allow_emulator,
          allow_device,
          allow_dev,
          allow_prod,
          allow_device_self_set,
          disable_auto_update_under_native,
          disable_auto_update,
          ios,
          android,
          updated_at
        `)
      .eq('id', id.value)
      .single()

    if (error) {
      console.error('no channel', error)
      return
    }

    channel.value = data as unknown as Database['public']['Tables']['channels']['Row'] & Channel
    appDetailStore.setChannel(id.value, channel.value)

    if (channel.value?.name)
      displayStore.setChannelName(String(channel.value.id), channel.value.name)
    displayStore.NavTitle = channel.value?.name ?? t('channel')
  }
  catch (error) {
    console.error(error)
  }
}

async function fetchStats() {
  if (!id.value || !channel.value)
    return

  const requestId = ++latestStatsRequest
  statsLoading.value = true
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session) {
      if (requestId === latestStatsRequest)
        toast.error(t('not-authenticated'))
      return
    }

    const response = await fetch(`${defaultApiHost}/private/channel_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${sessionData.session.access_token}`,
      },
      body: JSON.stringify({
        channel_id: id.value,
        app_id: packageId.value,
        days: days.value,
      }),
    })

    if (requestId !== latestStatsRequest)
      return

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error('Failed to fetch channel stats:', errorData)
      toast.error(t('failed-to-fetch-statistics'))
      return
    }

    const result: ChannelStatsResponse = await response.json()
    if (requestId !== latestStatsRequest)
      return
    stats.value = result
  }
  catch (error) {
    if (requestId !== latestStatsRequest)
      return
    console.error('Error fetching channel stats:', error)
    toast.error(t('failed-to-fetch-statistics'))
  }
  finally {
    if (requestId === latestStatsRequest)
      statsLoading.value = false
  }
}

watchEffect(async () => {
  if (route.path.includes('/channel/') && route.path.includes('/statistics')) {
    loading.value = true
    packageId.value = route.params.app as string
    id.value = Number(route.params.channel as string)
    await getChannel()
    await fetchStats()
    loading.value = false

    if (!channel.value?.name)
      displayStore.NavTitle = t('channel')
    displayStore.defaultBack = `/app/${route.params.app}/channels`
  }
})
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="channel" class="w-full h-full px-4 pt-0 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div class="min-w-0">
            <h3 class="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              {{ t('selected-period') }}
            </h3>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {{ selectedPeriodLabel }} · {{ periodTimespanLabel }}
            </p>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {{ t('selected-period-applies-to-stats') }}
            </p>
          </div>
          <PeriodDaySelector
            :model-value="days"
            :labels="{ 30: 'max-period' }"
            @update:model-value="selectPeriod"
          />
        </div>

        <!-- Selected Period Adoption Status -->
        <div
          class="p-4 border rounded-lg shadow-sm"
          :class="{
            'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800': statusType === 'healthy',
            'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800': statusType === 'warning',
            'bg-rose-50 border-rose-200 dark:bg-rose-900/20 dark:border-rose-800': statusType === 'critical',
            'bg-sky-50 border-sky-200 dark:bg-sky-900/20 dark:border-sky-800': statusType === 'ramping',
            'bg-slate-50 border-slate-200 dark:bg-slate-800 dark:border-slate-700': statusType === 'no-devices' || statusType === 'loading',
          }"
        >
          <div class="flex items-center gap-3">
            <IconCheckCircle
              v-if="statusType === 'healthy'"
              class="w-6 h-6 text-emerald-600 dark:text-emerald-400"
            />
            <IconAlertTriangle
              v-else-if="statusType === 'warning'"
              class="w-6 h-6 text-amber-600 dark:text-amber-400"
            />
            <IconTrendingUp
              v-else-if="statusType === 'ramping'"
              class="w-6 h-6 text-sky-600 dark:text-sky-400"
            />
            <IconAlertCircle
              v-else-if="statusType === 'critical'"
              class="w-6 h-6 text-rose-600 dark:text-rose-400"
            />
            <IconAlertCircle
              v-else-if="statusType === 'no-devices'"
              class="w-6 h-6 text-slate-500 dark:text-slate-300"
            />
            <div
              v-else
              class="w-6 h-6 border-2 rounded-full border-slate-300 dark:border-slate-600 border-t-transparent animate-spin"
            />
            <div>
              <h3
                class="font-semibold"
                :class="{
                  'text-emerald-800 dark:text-emerald-200': statusType === 'healthy',
                  'text-amber-800 dark:text-amber-200': statusType === 'warning',
                  'text-rose-800 dark:text-rose-200': statusType === 'critical',
                  'text-sky-800 dark:text-sky-200': statusType === 'ramping',
                  'text-slate-800 dark:text-slate-200': statusType === 'no-devices' || statusType === 'loading',
                }"
              >
                {{ statusMessage }}
              </h3>
              <p
                v-if="stats && stats.totals.total_devices > 0"
                class="mt-1 text-sm"
                :class="{
                  'text-emerald-700 dark:text-emerald-300': statusType === 'healthy',
                  'text-amber-700 dark:text-amber-300': statusType === 'warning',
                  'text-rose-700 dark:text-rose-300': statusType === 'critical',
                  'text-sky-700 dark:text-sky-300': statusType === 'ramping',
                }"
              >
                {{ statusDetail }}
              </p>
            </div>
          </div>
        </div>

        <!-- Selected Period Overview Cards -->
        <div>
          <div class="mb-3">
            <h3 class="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              {{ t('selected-period-overview') }}
            </h3>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {{ t('selected-period-overview-help', { period: selectedPeriodLabel, range: periodTimespanLabel, version: stats?.currentVersion || '-' }) }}
            </p>
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconAlertCircle class="w-4 h-4" />
                {{ t('period-check-ins') }}
              </div>
              <div class="mt-2 text-lg font-semibold text-slate-900 dark:text-white">
                {{ formatCount(periodSummary?.periodTotal) }}
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ t('period-check-ins-help', { count: formatCount(periodSummary?.periodTotal), period: selectedPeriodLabel }) }}
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconCheckCircle class="w-4 h-4" />
                {{ t('start-of-selected-period') }}
              </div>
              <div class="mt-2 text-lg font-semibold text-slate-900 dark:text-white">
                {{ formatPercent(periodSummary?.startShare ?? 0) }}
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ t('start-of-selected-period-help', { date: periodSummary?.startDateLabel ?? '-', count: formatCount(periodSummary?.startCount), total: formatCount(periodSummary?.startTotal), version: stats?.currentVersion || '-' }) }}
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconCheckCircle class="w-4 h-4" />
                {{ t('latest-day-in-selected-period') }}
              </div>
              <div class="mt-2 text-lg font-semibold" :class="adoptionRateColorClass">
                {{ formatPercent(periodSummary?.latestShare ?? 0) }}
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ t('latest-day-in-selected-period-help', { date: periodSummary?.latestDateLabel ?? '-', count: formatCount(periodSummary?.latestCount), total: formatCount(periodSummary?.latestTotal), version: stats?.currentVersion || '-' }) }}
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconTrendingUp class="w-4 h-4" />
                {{ t('period-change') }}
              </div>
              <div
                class="mt-2 text-lg font-semibold"
                :class="{
                  'text-emerald-600 dark:text-emerald-400': (periodSummary?.changeShare ?? 0) > 0,
                  'text-rose-600 dark:text-rose-400': (periodSummary?.changeShare ?? 0) < 0,
                  'text-slate-900 dark:text-white': (periodSummary?.changeShare ?? 0) === 0,
                }"
              >
                {{ formatPercentRange(periodSummary?.startShare ?? 0, periodSummary?.latestShare ?? 0) }}
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ t('period-change-help', { start: periodSummary?.startDateLabel ?? '-', end: periodSummary?.latestDateLabel ?? '-', version: stats?.currentVersion || '-' }) }}
              </div>
            </div>
          </div>
        </div>

        <!-- Chart -->
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="mb-4">
            <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
              {{ t('device-version-adoption-over-time') }}
            </h3>
          </div>

          <p class="mb-4 text-sm text-slate-600 dark:text-slate-300">
            {{ t('channel-stats-help', { period: selectedPeriodLabel, range: periodTimespanLabel }) }}
          </p>

          <div v-if="statsLoading" class="flex items-center justify-center h-64">
            <Spinner size="w-12 h-12" />
          </div>

          <div v-else-if="!stats || stats.totals.total_devices === 0" class="flex flex-col items-center justify-center h-64 text-slate-500 dark:text-slate-400">
            <IconAlertCircle class="w-12 h-12 mb-2" />
            <p>{{ t('no-data-available') }}</p>
            <p class="mt-1 text-sm">
              {{ t('devices-will-appear-here') }}
            </p>
          </div>

          <div v-else class="relative h-64">
            <Line :data="chartData" :options="chartOptions" />
          </div>

          <!-- Legend -->
          <div v-if="stats && stats.totals.total_devices > 0" class="flex flex-wrap items-center justify-center gap-4 mt-4 text-sm">
            <div
              v-for="(dataset, index) in stats.datasets"
              :key="dataset.label"
              class="flex items-center gap-2"
            >
              <div
                class="w-3 h-3 rounded-full"
                :class="[
                  index === 0 ? 'bg-emerald-500'
                  : index === 1 ? 'bg-orange-400'
                    : index === 2 ? 'bg-rose-400'
                      : index === 3 ? 'bg-blue-500'
                        : index === 4 ? 'bg-purple-500'
                          : 'bg-teal-500',
                ]"
              />
              <span class="text-slate-700 dark:text-slate-300">
                {{ dataset.label }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('channel-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('channel-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/channels`)">
        {{ t('back-to-channels') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
