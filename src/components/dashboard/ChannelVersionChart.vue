<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { TooltipClickHandler } from '~/services/chartTooltip'
import { CategoryScale, Chart, Filler, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { computed, ref, watch } from 'vue'
import { Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { createTooltipConfig } from '~/services/chartTooltip'
import { formatLocalDateShort } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'

// Bundle version mix of one channel, the channel-scoped counterpart of the
// app-wide "Active bundle" chart on the Live release page.
const props = defineProps<{
  appId: string
  channelId: number
  days: number
}>()

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

interface ChannelStatsResponse {
  labels: string[]
  datasets: Array<{ label: string, data: number[], metaCounts?: number[] }>
  currentVersion: string
  totals: {
    total_devices: number
    devices_on_current: number
    percent_on_current: number
  }
}

const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()
const stats = ref<ChannelStatsResponse | null>(null)
const loading = ref(false)
const failed = ref(false)
const bundleIdCache = new Map<string, number>()
let latestRequest = 0

async function fetchStats() {
  const requestId = ++latestRequest
  loading.value = true
  failed.value = false
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session)
      return
    const response = await fetch(`${defaultApiHost}/private/channel_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${sessionData.session.access_token}`,
      },
      body: JSON.stringify({ channel_id: props.channelId, app_id: props.appId, days: props.days }),
    })
    if (requestId !== latestRequest)
      return
    if (!response.ok) {
      failed.value = true
      return
    }
    const payload = await response.json() as ChannelStatsResponse
    // A slower, older request must not overwrite the current period.
    if (requestId !== latestRequest)
      return
    stats.value = payload
  }
  catch (error) {
    console.error('Error fetching channel stats:', error)
    if (requestId === latestRequest)
      failed.value = true
  }
  finally {
    if (requestId === latestRequest)
      loading.value = false
  }
}

watch(() => [props.appId, props.channelId, props.days] as const, () => {
  void fetchStats()
}, { immediate: true })

async function navigateToBundle(versionName: string) {
  const cached = bundleIdCache.get(versionName)
  if (cached) {
    router.push(`/app/${encodeURIComponent(props.appId)}/bundle/${cached}`)
    return
  }
  const { data } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', props.appId)
    .eq('name', versionName)
    .limit(1)
    .single()
  if (data?.id) {
    bundleIdCache.set(versionName, data.id)
    router.push(`/app/${encodeURIComponent(props.appId)}/bundle/${data.id}`)
  }
}

const hasData = computed(() => (stats.value?.totals.total_devices ?? 0) > 0)

const tooltipClickHandler = computed<TooltipClickHandler | undefined>(() => {
  const datasets = stats.value?.datasets ?? []
  if (!datasets.length)
    return undefined
  return {
    onAppClick: navigateToBundle,
    appIdByLabel: Object.fromEntries(datasets.map(dataset => [dataset.label, dataset.label])),
  }
})

const palette = [
  { border: 'rgb(34, 197, 94)', background: 'rgba(34, 197, 94, 0.3)' },
  { border: 'rgb(251, 146, 60)', background: 'rgba(251, 146, 60, 0.3)' },
  { border: 'rgb(244, 63, 94)', background: 'rgba(244, 63, 94, 0.3)' },
  { border: 'rgb(59, 130, 246)', background: 'rgba(59, 130, 246, 0.3)' },
  { border: 'rgb(168, 85, 247)', background: 'rgba(168, 85, 247, 0.3)' },
  { border: 'rgb(16, 185, 129)', background: 'rgba(16, 185, 129, 0.3)' },
] as const

const chartData = computed<ChartData<'line'>>(() => ({
  labels: (stats.value?.labels ?? []).map(label => formatLocalDateShort(label) || label),
  datasets: (stats.value?.datasets ?? []).map((dataset, index) => {
    const color = palette[index % palette.length]
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
      pointRadius: 2,
      pointHoverRadius: 4,
    }
  }),
}))

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { display: false },
    tooltip: createTooltipConfig(true, false, undefined, tooltipClickHandler.value),
  },
  scales: {
    x: { grid: { display: false }, ticks: { font: { size: 11 } } },
    y: {
      beginAtZero: true,
      max: 100,
      grid: { color: 'rgba(0, 0, 0, 0.05)' },
      ticks: { font: { size: 11 }, callback: (value: string | number) => `${value}%` },
    },
  },
} as unknown as ChartOptions<'line'>))

const percentLabel = computed(() => `${formatNumberValue(stats.value?.totals.percent_on_current ?? 0, { maximumFractionDigits: 1 })}%`)
</script>

<template>
  <ChartCard
    :title="t('active_users_by_version')"
    :is-loading="loading && !stats"
    :has-data="hasData"
    :error-message="failed ? t('failed-to-fetch-statistics') : undefined"
    :no-data-message="t('devices-will-appear-here')"
  >
    <template #header>
      <div class="flex items-start justify-between w-full gap-3">
        <h2 class="min-w-0 text-base font-semibold leading-tight text-slate-900 dark:text-white">
          {{ t('active_users_by_version') }}
        </h2>
        <div v-if="hasData && stats" class="flex flex-col items-end text-right shrink-0">
          <span class="inline-flex items-center justify-center px-2 py-1 text-xs font-bold text-white rounded-full shadow-lg bg-cyan-500">
            {{ percentLabel }}
          </span>
          <span class="text-lg font-bold leading-tight text-slate-600 dark:text-white">{{ stats.currentVersion }}</span>
          <span class="text-xs text-slate-500 dark:text-slate-400">
            {{ formatNumberValue(stats.totals.devices_on_current) }} / {{ formatNumberValue(stats.totals.total_devices) }} {{ t('devices') }}
          </span>
        </div>
      </div>
    </template>
    <Line class="w-full h-full" :data="chartData" :options="chartOptions" />
  </ChartCard>
</template>
