<script setup lang="ts">
import type { ChartData, ChartOptions, Plugin } from 'chart.js'
import type { TooltipClickHandler } from '~/services/chartTooltip'
import { useDark } from '@vueuse/core'
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js'
import dayjs from 'dayjs'
import { computed } from 'vue'
import { Bar, Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { getTodayLimit as resolveTodayLimit, transformSeries as transformDailySeries } from '~/services/buildCharts'
import { createLegendConfig, createStackedChartScales } from '~/services/chartConfig'
import { generateMonthDays, getDaysInCurrentMonth, normalizeToUtcStartOfDay } from '~/services/date'
import { useOrganizationStore } from '~/stores/organization'
import { createTooltipConfig, todayLinePlugin, verticalLinePlugin } from '../../services/chartTooltip'

const props = defineProps({
  title: { type: String, default: '' },
  colors: { type: Object, default: () => ({}) },
  limits: { type: Object, default: () => ({}) },
  data: { type: Array, default: () => Array.from({ length: getDaysInCurrentMonth() }).fill(0) as number[] },
  dataByApp: { type: Object, default: () => ({}) },
  appNames: { type: Object, default: () => ({}) },
  useBillingPeriod: { type: Boolean, default: true },
  accumulated: { type: Boolean, default: false },
  appId: { type: String, default: '' },
})

const isDark = useDark()
const { t } = useI18n()
const router = useRouter()
const organizationStore = useOrganizationStore()
const effectiveOrganization = computed(() => {
  if (props.appId)
    return organizationStore.getOrgByAppId(props.appId) ?? organizationStore.currentOrganization
  return organizationStore.currentOrganization
})
const cycleStart = computed(() => {
  return normalizeToUtcStartOfDay(new Date(effectiveOrganization.value?.subscription_start ?? new Date()))
})
const cycleEnd = computed(() => {
  const end = normalizeToUtcStartOfDay(new Date(effectiveOrganization.value?.subscription_end ?? new Date()))
  const today = normalizeToUtcStartOfDay()
  return end < today ? today : end
})

function getTodayLimit(labelCount: number) {
  return resolveTodayLimit(labelCount, props.useBillingPeriod, cycleStart.value, cycleEnd.value)
}

function transformSeries(source: number[], accumulated: boolean, labelCount: number) {
  return transformDailySeries(source, accumulated, labelCount, getTodayLimit(labelCount))
}

const UPDATE_FAILURE_ACTIONS = [
  'set_fail',
  'update_fail',
  'download_fail',
  'windows_path_fail',
  'canonical_path_fail',
  'directory_path_fail',
  'unzip_fail',
  'low_mem_fail',
  'download_manifest_file_fail',
  'download_manifest_checksum_fail',
  'download_manifest_brotli_fail',
  'decrypt_fail',
  'checksum_fail',
] as const

// Map chart buckets back to the log actions they aggregate.
const actionToLogActions: Record<string, readonly string[]> = {
  requested: ['get'],
  install: ['set'],
  fail: UPDATE_FAILURE_ACTIONS,
}

// Click handler for tooltip items - navigates to logs page filtered by action type and date
const tooltipClickHandler = computed<TooltipClickHandler | undefined>(() => {
  if (!props.appId)
    return undefined

  // Create mapping from display names to action keys
  const actionIdByLabel: Record<string, string> = {}
  Object.entries(props.appNames as Record<string, string>).forEach(([actionKey, displayName]) => {
    actionIdByLabel[displayName] = actionKey
  })

  return {
    onAppClick: (actionKey: string, clickContext?: { date: Date, dataIndex: number }) => {
      // Navigate to logs page with action filter and date range
      // The actionKey here is the internal key like 'requested', 'install', 'fail'
      const filterActions = actionToLogActions[actionKey] ?? [actionKey]
      const params = new URLSearchParams()
      filterActions.forEach(action => params.append('action', action))

      // Add date range if provided (selected day)
      if (clickContext?.date) {
        const startOfDay = dayjs(clickContext.date).startOf('day')
        const endOfDay = dayjs(clickContext.date).endOf('day')
        params.set('start', startOfDay.toISOString())
        params.set('end', endOfDay.toISOString())
      }

      router.push(`/app/${props.appId}/observe/logs?${params.toString()}`)
    },
    appIdByLabel: actionIdByLabel,
  }
})

Chart.register(
  Tooltip,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
)

const ACTION_STYLES: Record<string, { barBackground: string, barBorder: string, lineBackground: string, lineBorder: string }> = {
  requested: {
    barBackground: 'hsla(210, 65%, 60%, 0.8)',
    barBorder: 'hsl(210, 65%, 45%)',
    lineBackground: 'hsla(210, 65%, 60%, 0.35)',
    lineBorder: 'hsl(210, 70%, 50%)',
  },
  install: {
    barBackground: 'hsla(135, 60%, 60%, 0.8)',
    barBorder: 'hsl(135, 60%, 45%)',
    lineBackground: 'hsla(135, 60%, 60%, 0.35)',
    lineBorder: 'hsl(135, 65%, 45%)',
  },
  fail: {
    barBackground: 'hsla(0, 65%, 65%, 0.8)',
    barBorder: 'hsl(0, 65%, 50%)',
    lineBackground: 'hsla(0, 65%, 65%, 0.35)',
    lineBorder: 'hsl(0, 70%, 50%)',
  },
}

function monthdays() {
  return generateMonthDays(props.useBillingPeriod, cycleStart.value, cycleEnd.value)
}

const chartData = computed<ChartData<'bar' | 'line'>>(() => {
  // Always show breakdown by action type (requested/install/fail)
  const labels = monthdays()
  const labelCount = labels.length
  const actionTypes: Array<'requested' | 'install' | 'fail'> = ['requested', 'install', 'fail']
  const datasets = actionTypes.map((action, index) => {
    const actionData = props.dataByApp[action] as number[] | undefined
    const actionName = props.appNames[action] || action
    const style = ACTION_STYLES[action] ?? ACTION_STYLES.requested
    const rawData = actionData && actionData.length ? actionData : Array.from({ length: labels.length }).fill(0) as Array<number>
    const processed = transformSeries(rawData, props.accumulated, labelCount)

    const backgroundColor = props.accumulated ? style.lineBackground : style.barBackground
    const borderColor = props.accumulated ? style.lineBorder : style.barBorder

    const baseDataset: any = {
      label: actionName,
      data: processed.display,
      backgroundColor,
      borderColor,
      borderWidth: 1,
      metaBaseValues: processed.base,
    } as ChartData<'bar' | 'line'>['datasets'][number]

    // Add line-specific properties for accumulated mode (match UsageCard styling)
    return props.accumulated
      ? {
          ...baseDataset,
          fill: index === 0 ? 'origin' : '-1', // First fills from bottom, others fill from previous dataset
          tension: 0.3,
          pointRadius: 0,
          pointBorderWidth: 0,
          borderWidth: 1,
        }
      : baseDataset
  })

  return {
    labels,
    datasets,
  }
})

const todayLineOptions = computed(() => {
  if (!props.useBillingPeriod)
    return { enabled: false }

  const labels = Array.isArray(chartData.value.labels) ? chartData.value.labels : []
  const index = getTodayLimit(labels.length)

  if (index < 0 || index >= labels.length)
    return { enabled: false }

  const strokeColor = isDark.value ? 'rgba(165, 180, 252, 0.75)' : 'rgba(99, 102, 241, 0.7)'
  const glowColor = isDark.value ? 'rgba(129, 140, 248, 0.35)' : 'rgba(165, 180, 252, 0.35)'
  const badgeFill = isDark.value ? 'rgba(67, 56, 202, 0.45)' : 'rgba(199, 210, 254, 0.85)'
  const textColor = isDark.value ? '#e0e7ff' : '#312e81'

  return {
    enabled: true,
    xIndex: index,
    label: t('today'),
    color: strokeColor,
    glowColor,
    badgeFill,
    textColor,
  }
})

const chartOptions = computed(() => {
  return {
    maintainAspectRatio: false,
    scales: createStackedChartScales(isDark.value, true),
    plugins: {
      legend: createLegendConfig(isDark.value, true),
      title: {
        display: false,
      },
      tooltip: createTooltipConfig(true, props.accumulated, props.useBillingPeriod ? cycleStart.value : false, tooltipClickHandler.value),
      todayLine: todayLineOptions.value,
    },
  }
})

const lineChartOptions = computed(() => chartOptions.value as unknown as ChartOptions<'line'>)
const barChartOptions = computed(() => chartOptions.value as unknown as ChartOptions<'bar'>)
const sharedPlugins = [verticalLinePlugin, todayLinePlugin]
const linePlugins = sharedPlugins as unknown as Plugin<'line'>[]
const barPlugins = sharedPlugins as unknown as Plugin<'bar'>[]
</script>

<template>
  <div class="w-full h-full">
    <Line
      v-if="accumulated"
      :data="chartData as any"
      :options="lineChartOptions as any"
      :plugins="linePlugins"
    />
    <Bar
      v-else
      :data="chartData as any"
      :options="barChartOptions as any"
      :plugins="barPlugins"
    />
  </div>
</template>
