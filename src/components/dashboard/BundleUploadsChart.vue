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
import { createLegendConfig, createStackedChartScales } from '~/services/chartConfig'
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
const cycleStart = new Date(organizationStore.currentOrganization?.subscription_start ?? new Date())
const cycleEnd = new Date(organizationStore.currentOrganization?.subscription_end ?? new Date())
// Reset to start of day for consistent date handling
cycleStart.setHours(0, 0, 0, 0)
cycleEnd.setHours(0, 0, 0, 0)

const DAY_IN_MS = 1000 * 60 * 60 * 24

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

// Check if a hue is in the red or green range (reserved for UpdateStats)
function isReservedHue(hue: number): boolean {
  // Red range: 0-30 and 330-360
  // Green range: 90-160
  return (hue >= 0 && hue <= 30) || (hue >= 330 && hue <= 360) || (hue >= 90 && hue <= 160)
}

// Get the nth safe hue that skips red/green colors
function getSafeHue(targetIndex: number): number {
  let i = 0
  let safeCount = 0

  while (safeCount <= targetIndex && i < targetIndex * 3 + 10) {
    const hue = (210 + i * 137.508) % 360
    i++

    if (!isReservedHue(hue)) {
      if (safeCount === targetIndex)
        return hue
      safeCount++
    }
  }

  // Fallback to blue if we somehow can't find enough safe hues
  return 210
}

// Generate infinite distinct pastel colors starting with blue, skipping red/green
function generateAppColors(appCount: number) {
  const colors = []

  for (let colorIndex = 0; colorIndex < appCount; colorIndex++) {
    const hue = getSafeHue(colorIndex)

    // Use pastel-friendly saturation and lightness values
    const saturation = 50 + (colorIndex % 3) * 8 // 50%, 58%, 66% - softer colors
    const lightness = 60 + (colorIndex % 4) * 5 // 60%, 65%, 70%, 75% - lighter, more pastel

    const backgroundColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.8)`

    colors.push(backgroundColor)
  }

  return colors
}

function getTodayLimit(labelCount: number) {
  if (!props.useBillingPeriod)
    return labelCount - 1

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // If cycle end is today or in the past, show all data
  if (cycleEnd <= today)
    return labelCount - 1

  // If cycle end is in the future, only show data up to today
  const diff = Math.floor((today.getTime() - cycleStart.getTime()) / DAY_IN_MS)

  if (Number.isNaN(diff) || diff < 0)
    return -1

  return Math.min(diff, labelCount - 1)
}

function transformSeries(source: number[], accumulated: boolean, labelCount: number) {
  const display: Array<number | null> = Array.from({ length: labelCount }).fill(null) as Array<number | null>
  const base: Array<number | null> = Array.from({ length: labelCount }).fill(null) as Array<number | null>
  const limitIndex = getTodayLimit(labelCount)

  if (limitIndex < 0)
    return { display, base }

  let runningTotal = 0
  for (let index = 0; index <= limitIndex; index++) {
    const hasValue = index < source.length && typeof source[index] === 'number' && Number.isFinite(source[index])
    const numericValue = hasValue ? source[index] as number : 0

    base[index] = numericValue
    if (accumulated) {
      runningTotal += numericValue
      display[index] = runningTotal
    }
    else {
      display[index] = numericValue
    }
  }

  return { display, base }
}

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
      processed = transformSeries(props.data as number[], true, labelCount)
      // Use LineChartStats color scheme for line mode
      borderColor = `hsl(210, 65%, 45%)`
      backgroundColor = `hsla(210, 50%, 60%, 0.6)`
    }
    else {
      processed = transformSeries(props.data as number[], false, labelCount)
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
  const appColors = generateAppColors(appIds.length)
  const datasets = appIds.map((appId, index) => {
    const appData = props.dataByApp[appId] as number[]

    let backgroundColor: string
    let borderColor: string
    let processed: { display: Array<number | null>, base: Array<number | null> }

    // Process data for cumulative mode
    if (props.accumulated) {
      processed = transformSeries(appData, true, labelCount)
      // Use safe hue that skips red/green (reserved for UpdateStats)
      const hue = getSafeHue(index)
      const saturation = 50 + (index % 3) * 8
      const lightness = 60 + (index % 4) * 5
      borderColor = `hsl(${hue}, ${saturation + 15}%, ${lightness - 15}%)`
      backgroundColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.6)`
    }
    else {
      processed = transformSeries(appData, false, labelCount)
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
