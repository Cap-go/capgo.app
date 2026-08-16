<script setup lang="ts">
import type { ChartData, ChartOptions, Plugin } from 'chart.js'
import type { TooltipClickHandler } from '~/services/chartTooltip'
import { useDark } from '@vueuse/core'
import { computed } from 'vue'
import { Bar, Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useDashboardDailyChartCycle } from '~/composables/useOrgBillingCycleChart'
import { createLegendConfig, createStackedChartScales } from '~/services/chartConfig'
import { createTodayLineOptions, generateAppChartColors, getSafeChartHue } from '~/services/chartTodayLine'
import { createTooltipConfig, todayLinePlugin, verticalLinePlugin } from '~/services/chartTooltip'
import { dailyChartBaseProps } from '~/services/dailyChartProps'
import { registerDashboardCharts } from '~/services/dashboardChartRegister'
import { generateMonthDays } from '~/services/date'
import { createChartLegendItems } from './chartLegend'
import ChartLegend from './ChartLegend.vue'

const props = defineProps({
  ...dailyChartBaseProps(),
  dataByChannel: { type: Object, default: () => ({}) },
  channelNames: { type: Object, default: () => ({}) },
  channelAppIds: { type: Object, default: () => ({}) },
})

registerDashboardCharts()

const isDark = useDark()
const { t } = useI18n()
const router = useRouter()
const { cycleStart, cycleEnd, todayLimit, transformDailySeries } = useDashboardDailyChartCycle(() => props.useBillingPeriod)

const isChannelMode = computed(() => Object.keys(props.dataByChannel).length > 0)
const isAppMode = computed(() => Object.keys(props.dataByApp).length > 0)
const hasBreakdownData = computed(() => isChannelMode.value || isAppMode.value)

const idByLabel = computed(() => {
  const mapping: Record<string, string> = {}
  if (isChannelMode.value) {
    for (const [channelId, channelName] of Object.entries(props.channelNames as Record<string, string>))
      mapping[channelName] = channelId
  }
  else if (isAppMode.value) {
    for (const [appId, appName] of Object.entries(props.appNames as Record<string, string>))
      mapping[appName] = appId
  }
  return mapping
})

const tooltipClickHandler = computed<TooltipClickHandler | undefined>(() => {
  if (isChannelMode.value) {
    return {
      onAppClick: (channelId: string) => {
        const appId = (props.channelAppIds as Record<string, string>)[channelId]
        if (appId)
          router.push(`/app/${appId}/channel/${channelId}`)
      },
      appIdByLabel: idByLabel.value,
    }
  }
  if (isAppMode.value) {
    return {
      onAppClick: (appId: string) => router.push(`/app/${appId}`),
      appIdByLabel: idByLabel.value,
    }
  }
  return undefined
})

function monthdays() {
  return generateMonthDays(props.useBillingPeriod, cycleStart.value, cycleEnd.value)
}

const chartData = computed<ChartData<any>>(() => {
  const labels = monthdays()
  const labelCount = labels.length

  // Determine which data to use based on mode
  let dataSource: Record<string, number[]> = {}
  let nameMapping: Record<string, string> = {}

  if (isChannelMode.value) {
    dataSource = props.dataByChannel as Record<string, number[]>
    nameMapping = props.channelNames as Record<string, string>
  }
  else if (isAppMode.value) {
    dataSource = props.dataByApp as Record<string, number[]>
    nameMapping = props.appNames as Record<string, string>
  }

  const itemIds = Object.keys(dataSource)

  if (itemIds.length === 0) {
    // No breakdown data - show total deployments
    let backgroundColor: string
    let borderColor: string
    let processed: { display: Array<number | null>, base: Array<number | null> }

    // Process data for cumulative mode
    if (props.accumulated) {
      processed = transformDailySeries(props.data as number[], true, labelCount)
      // Use LineChartStats color scheme for line mode
      borderColor = `hsl(210, 65%, 45%)`
      backgroundColor = `hsla(210, 50%, 60%, 0.6)`
    }
    else {
      processed = transformDailySeries(props.data as number[], false, labelCount)
      // Use existing bar chart colors for bar mode
      backgroundColor = 'hsla(210, 50%, 70%, 0.8)'
      borderColor = 'hsl(210, 50%, 55%)'
    }

    const baseDataset: any = {
      label: 'Deployments',
      data: processed.display,
      backgroundColor,
      borderColor,
      borderWidth: 1,
      metaBaseValues: processed.base,
    }

    // Add line-specific properties for accumulated mode (match UsageCard styling)
    const dataset = props.accumulated
      ? {
          ...baseDataset,
          fill: 'origin',
          tension: 0.3,
          pointRadius: 0,
          pointBorderWidth: 0,
          borderWidth: 1,
        }
      : baseDataset
    return {
      labels,
      datasets: [dataset],
    }
  }

  // Multiple items view - show breakdown by channel or app
  const itemColors = generateAppChartColors(itemIds.length)
  const datasets = itemIds.map((itemId, index) => {
    const itemData = dataSource[itemId] as number[]

    let backgroundColor: string
    let borderColor: string
    let processed: { display: Array<number | null>, base: Array<number | null> }

    // Process data for cumulative mode
    if (props.accumulated) {
      processed = transformDailySeries(itemData, true, labelCount)
      // Use safe hue that skips red/green (reserved for UpdateStats)
      const hue = getSafeChartHue(index)
      const saturation = 50 + (index % 3) * 8
      const lightness = 60 + (index % 4) * 5
      borderColor = `hsl(${hue}, ${saturation + 15}%, ${lightness - 15}%)`
      backgroundColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.6)`
    }
    else {
      processed = transformDailySeries(itemData, false, labelCount)
      // Use existing bar chart colors for bar mode
      backgroundColor = itemColors[index]
      borderColor = backgroundColor.replace('hsla', 'hsl').replace(', 0.8)', ')').replace(/(\d{1,3})%\)/, (_, lightness) => {
        const newLightness = Math.max(Number(lightness) - 15, 30)
        return `${newLightness}%)`
      })
    }

    const baseDataset: any = {
      label: nameMapping[itemId] || itemId,
      breakdownId: itemId,
      data: processed.display,
      backgroundColor,
      borderColor,
      borderWidth: 1,
      metaBaseValues: processed.base,
    }

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

const legendItems = computed(() => hasBreakdownData.value ? createChartLegendItems(chartData.value.datasets, 'breakdownId') : [])

const todayLineOptions = computed(() => {
  const labels = Array.isArray(chartData.value.labels) ? chartData.value.labels : []
  return createTodayLineOptions({
    useBillingPeriod: props.useBillingPeriod,
    index: todayLimit(labels.length),
    labelCount: labels.length,
    label: t('today'),
    isDark: isDark.value,
  })
})

const chartOptions = computed(() => {
  return {
    maintainAspectRatio: false,
    scales: createStackedChartScales(isDark.value, hasBreakdownData.value),
    plugins: {
      legend: createLegendConfig(isDark.value, false),
      title: {
        display: false,
      },
      tooltip: createTooltipConfig(hasBreakdownData.value, props.accumulated, props.useBillingPeriod ? cycleStart.value : false, tooltipClickHandler.value),
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
  <div class="flex min-h-full flex-col">
    <div class="min-h-[16rem] flex-1">
      <Line
        v-if="accumulated"
        :data="chartData"
        :options="lineChartOptions"
        height="auto"
        :plugins="linePlugins"
      />
      <Bar
        v-else
        :data="chartData"
        :options="barChartOptions"
        height="auto"
        :plugins="barPlugins"
      />
    </div>
    <ChartLegend :items="legendItems" />
  </div>
</template>
