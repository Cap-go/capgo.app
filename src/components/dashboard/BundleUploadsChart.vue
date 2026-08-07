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
import { computed } from 'vue'
import { Bar, Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useOrgBillingCycleChart } from '~/composables/useOrgBillingCycleChart'
import { createLegendConfig, createStackedChartScales } from '~/services/chartConfig'
import { createTodayLineOptions, generateAppChartColors, getSafeChartHue } from '~/services/chartTodayLine'
import { createTooltipConfig, todayLinePlugin, verticalLinePlugin } from '~/services/chartTooltip'
import { generateMonthDays, getDaysInCurrentMonth } from '~/services/date'
import { useOrganizationStore } from '~/stores/organization'
import { createChartLegendItems } from './chartLegend'
import ChartLegend from './ChartLegend.vue'

const props = defineProps({
  title: { type: String, default: '' },
  colors: { type: Object, default: () => ({}) },
  limits: { type: Object, default: () => ({}) },
  data: { type: Array, default: () => Array.from({ length: getDaysInCurrentMonth() }).fill(0) as number[] },
  dataByApp: { type: Object, default: () => ({}) },
  appNames: { type: Object, default: () => ({}) },
  useBillingPeriod: { type: Boolean, default: true },
  accumulated: { type: Boolean, default: false },
})

const isDark = useDark()
const { t } = useI18n()
const router = useRouter()
const organizationStore = useOrganizationStore()
const chartCycle = useOrgBillingCycleChart(
  () => props.useBillingPeriod,
  () => organizationStore.currentOrganization?.subscription_start,
  () => organizationStore.currentOrganization?.subscription_end,
)
const cycleStart = chartCycle.resolveCycleStart()
const cycleEnd = chartCycle.resolveCycleEnd()
const { todayLimit, transformDailySeries } = chartCycle

// Create a reverse mapping from app name to app ID for tooltip clicks
const appIdByLabel = computed(() => {
  const mapping: Record<string, string> = {}
  Object.entries(props.appNames as Record<string, string>).forEach(([appId, appName]) => {
    mapping[appName] = appId
  })
  return mapping
})

// Click handler for tooltip items - navigates to app detail page
const tooltipClickHandler = computed<TooltipClickHandler>(() => ({
  onAppClick: (appId: string) => {
    router.push(`/app/${appId}`)
  },
  appIdByLabel: appIdByLabel.value,
}))

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

function monthdays() {
  return generateMonthDays(props.useBillingPeriod, cycleStart, cycleEnd)
}
const hasAppData = computed(() => Object.keys(props.dataByApp).length > 0)

const chartData = computed<ChartData<any>>(() => {
  const appIds = Object.keys(props.dataByApp)
  const labels = monthdays()
  const labelCount = labels.length

  if (appIds.length === 0) {
    // Fallback to single dataset if no app data
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
      backgroundColor = props.colors[400]
      borderColor = props.colors[200]
    }

    const baseDataset: any = {
      label: props.title,
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
          fill: 'origin', // Fill from bottom for single dataset
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

  // Create stacked datasets for each app
  const appColors = generateAppChartColors(appIds.length)
  const datasets = appIds.map((appId, index) => {
    const appData = props.dataByApp[appId] as number[]

    let backgroundColor: string
    let borderColor: string
    let processed: { display: Array<number | null>, base: Array<number | null> }

    // Process data for cumulative mode
    if (props.accumulated) {
      processed = transformDailySeries(appData, true, labelCount)
      // Use safe hue that skips red/green (reserved for UpdateStats)
      const hue = getSafeChartHue(index)
      const saturation = 50 + (index % 3) * 8
      const lightness = 60 + (index % 4) * 5
      borderColor = `hsl(${hue}, ${saturation + 15}%, ${lightness - 15}%)`
      backgroundColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.6)`
    }
    else {
      processed = transformDailySeries(appData, false, labelCount)
      // Use existing bar chart colors for bar mode
      backgroundColor = appColors[index]
      borderColor = backgroundColor.replace('hsla', 'hsl').replace(', 0.8)', ')').replace(/(\d+)%\)/, (_, lightness) => {
        const newLightness = Math.max(Number(lightness) - 15, 30)
        return `${newLightness}%)`
      })
    }

    const baseDataset: any = {
      label: props.appNames[appId] || appId,
      appId,
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

const legendItems = computed(() => hasAppData.value ? createChartLegendItems(chartData.value.datasets, 'appId') : [])

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
    scales: createStackedChartScales(isDark.value, hasAppData.value),
    plugins: {
      legend: createLegendConfig(isDark.value, false),
      title: {
        display: false,
      },
      tooltip: createTooltipConfig(hasAppData.value, props.accumulated, props.useBillingPeriod ? cycleStart : false, hasAppData.value ? tooltipClickHandler.value : undefined),
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
