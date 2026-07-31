<script setup lang="ts">
import type { ChartData, ChartOptions, Plugin } from 'chart.js'
import type { AnnotationOptions } from '../../services/chartAnnotations'
import type { TooltipClickHandler } from '../../services/chartTooltip'
import { useDark } from '@vueuse/core'
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
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
import { generateMonthDays, getCurrentDayMonth, getDaysInCurrentMonth } from '~/services/date'
import { useOrganizationStore } from '~/stores/organization'
import { inlineAnnotationPlugin } from '../../services/chartAnnotations'
import { createTooltipConfig, todayLinePlugin, verticalLinePlugin } from '../../services/chartTooltip'
import { createChartLegendItems } from './chartLegend'
import ChartLegend from './ChartLegend.vue'

const props = defineProps({
  accumulated: {
    type: Boolean,
    default: true,
  },
  useBillingPeriod: {
    type: Boolean,
    default: true,
  },
  title: { type: String, default: '' },
  colors: { type: Object, default: () => ({}) },
  limits: { type: Object, default: () => ({}) },
  data: { type: Array, default: Array.from({ length: getDaysInCurrentMonth() }).fill(undefined) as number[] },
  dataByApp: {
    type: Object,
    default: () => ({}),
  },
  appNames: {
    type: Object,
    default: () => ({}),
  },
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

// Create a reverse mapping from app name to app ID for tooltip clicks
const appIdByLabel = computed(() => {
  const mapping: Record<string, string> = {}
  // appNames prop is { appId: appName }, we need { appName: appId }
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

// View mode is now controlled by parent component
const viewMode = computed(() => props.accumulated ? 'cumulative' : 'daily')

Chart.register(
  Tooltip,
  BarController,
  BarElement,
  LineController,
  PointElement,
  CategoryScale,
  LinearScale,
  LineElement,
  Filler,
)

const accumulateData = computed(() => {
  const monthDay = getCurrentDayMonth()
  if (viewMode.value === 'daily')
    return props.data as number[]
  return (props.data as number[]).reduce((acc: number[], val: number, i: number) => {
    const last = acc[acc.length - 1] ?? 0
    let newVal
    if (val !== undefined)
      newVal = last + val
    else if (i < monthDay)
      newVal = last
    return acc.concat([newVal as number])
  }, [])
})

const evolution = computed(() => {
  if (accumulateData.value.length === 0)
    return [0, 0, 0]
  const arrWithoutUndefined = accumulateData.value.filter((val: any) => val !== undefined)
  // calculate evolution of all value except the first one
  const res = arrWithoutUndefined.map((val: number, i: number) => {
    const last = arrWithoutUndefined[i - 1] ?? 0
    return i > 0 ? val - last : 0
  })
  const median = res.reduce((a, b) => a + b, 0) / accumulateData.value.length
  const min = Math.min(...res)
  const max = Math.max(...res)
  return [min, max, median]
})

function getRandomArbitrary(min: number, max: number) {
  return Math.random() * (max - min) + min
}

const projectionData = computed(() => {
  if (accumulateData.value.length === 0)
    return []
  const monthDay = getCurrentDayMonth()
  const arrWithoutUndefined = accumulateData.value.filter((val: any) => val !== undefined)
  const lastDay = arrWithoutUndefined[arrWithoutUndefined.length - 1]
  // create a projection of the evolution, start after the last value of the array, put undefined for the beginning of the month
  // each value is the previous value + the evolution, the first value is the last value of the array
  let res = new Array(getDaysInCurrentMonth()).fill(undefined)
  res = res.reduce((acc: number[], val: number, i: number) => {
    let newVal
    const last = acc[acc.length - 1] ?? 0
    // randomize Evolution from (half evolutio) to full evolution
    const randomizedEvolution = getRandomArbitrary((evolution.value[0] + evolution.value[2]) / 2, (evolution.value[1] + evolution.value[2]) / 2)
    if (i === monthDay - 1)
      newVal = lastDay
    else if (i >= monthDay)
      newVal = last + randomizedEvolution
    return acc.concat([newVal as number])
  }, [])
  res = res.filter(Boolean)
  for (let i = 0; i < arrWithoutUndefined.length - 1; i++)
    res.unshift(undefined)

  return res
})

function monthdays() {
  return generateMonthDays(props.useBillingPeriod, cycleStart, cycleEnd)
}

function createAnnotation(id: string, y: number, title: string, lineColor: string, bgColor: string) {
  const obj: any = {}
  obj[`line_${id}`] = {
    type: 'line',
    yMin: y,
    yMax: y,
    borderColor: lineColor,
    borderWidth: 2,
    borderDash: [5, 5], // Make dashed line to distinguish from data lines
  }
  obj[`label_${id}`] = {
    type: 'label',
    xValue: getDaysInCurrentMonth() / 2,
    yValue: y,
    backgroundColor: bgColor,
    content: [title],
    font: {
      size: 12,
      weight: 'bold',
    },
    color: `${isDark.value ? '#fff' : '#1f2937'}`, // Better contrast
    borderColor: lineColor,
    borderWidth: 1,
    borderRadius: 4,
    padding: 6,
  }
  return obj
}

const generateAnnotations = computed(() => {
  // Don't show plan limits in daily mode - they only make sense for cumulative data
  if (!props.accumulated) {
    return {}
  }

  // find biggest value in data
  let annotations: any = {}
  const min = Math.min(...accumulateData.value.filter((val: any) => val !== undefined) as number[])
  const max = Math.max(...projectionData.value.filter((val: any) => val !== undefined) as number[])

  // Use consistent white color for all limit lines for simplicity
  const lineColor = isDark.value ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.9)'
  const bgColor = isDark.value ? 'rgba(31, 41, 55, 0.9)' : 'rgba(255, 255, 255, 0.95)'

  Object.entries(props.limits as { [key: string]: number }).forEach(([key, val]) => {
    if (val && val > min && val < (max * 1.2)) {
      annotations = {
        ...annotations,
        ...createAnnotation(key, val, key, lineColor, bgColor),
      }
    }
  })
  return annotations
})

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

    const borderColor = `hsl(${hue}, ${saturation + 15}%, ${lightness - 15}%)`
    const backgroundColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.6)`

    colors.push({
      border: borderColor,
      bg: backgroundColor,
    })
  }

  return colors
}

const chartData = computed<ChartData<'line' | 'bar'>>(() => {
  const appIds = Object.keys(props.dataByApp || {})
  const datasets = []

  if (appIds.length > 0) {
    // Create stacked area datasets for each app
    const appColors = generateAppColors(appIds.length)
    appIds.forEach((appId, index) => {
      const appData = props.dataByApp[appId]
      if (appData) {
        // Process app data with accumulation if needed
        let processedData = appData
        if (viewMode.value === 'cumulative') {
          processedData = appData.reduce((acc: number[], val: number, i: number) => {
            const last = acc[acc.length - 1] ?? 0
            let newVal
            if (val !== undefined)
              newVal = last + val
            else if (i < getCurrentDayMonth())
              newVal = last
            return acc.concat([newVal as number])
          }, [])
        }

        let backgroundColor: string
        let borderColor: string

        if (props.accumulated) {
          // Use existing line chart colors for line mode
          backgroundColor = appColors[index].bg
          borderColor = appColors[index].border
        }
        else {
          // Use safe hue that skips red/green (reserved for UpdateStats)
          const hue = getSafeHue(index)
          const saturation = 50 + (index % 3) * 8
          const lightness = 60 + (index % 4) * 5
          backgroundColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.8)`
          borderColor = backgroundColor.replace('hsla', 'hsl').replace(', 0.8)', ')').replace(/(\d+)%\)/, (_, lightness) => {
            const newLightness = Math.max(Number(lightness) - 15, 30)
            return `${newLightness}%)`
          })
        }

        const baseDataset = {
          label: props.appNames[appId] || appId,
          appId,
          data: processedData,
          borderColor,
          backgroundColor,
          borderWidth: 1,
        }

        // Add chart-type specific properties
        const dataset = props.accumulated
          ? {
              ...baseDataset,
              fill: index === 0 ? 'origin' : '-1', // First fills from bottom, others fill from previous dataset
              tension: 0.3,
              pointRadius: 0,
              pointBorderWidth: 0,
            }
          : {
              ...baseDataset,
              borderWidth: 1,
            }

        datasets.push(dataset)
      }
    })
  }
  else {
    // Fallback to single dataset if no app data
    const mainDataset = {
      label: props.title,
      data: accumulateData.value,
      borderColor: props.colors[400],
      backgroundColor: props.colors[200],
    }

    // Add chart-type specific properties for main dataset
    const dataset = props.accumulated
      ? {
          ...mainDataset,
          fill: false, // No fill for single app line
          tension: 0.3,
          pointRadius: 2,
          pointBorderWidth: 0,
        }
      : {
          ...mainDataset,
          borderWidth: 1,
        }

    datasets.push(dataset)

    // Only add prediction for line charts (accumulated mode)
    if (props.accumulated) {
      datasets.push({
        label: t('prediction'),
        data: projectionData.value,
        borderColor: 'transparent',
        backgroundColor: props.colors[200],
        fill: false, // No fill for prediction line either
        tension: 0.9,
        pointRadius: 2,
        pointBorderWidth: 0,
      })
    }
  }

  return {
    labels: monthdays(),
    datasets,
  }
})

const hasAppData = computed(() => Object.keys(props.dataByApp || {}).length > 0)

const legendItems = computed(() => hasAppData.value ? createChartLegendItems(chartData.value.datasets, 'appId') : [])

const todayLineOptions = computed(() => {
  if (!props.useBillingPeriod)
    return { enabled: false }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (today < cycleStart || today > cycleEnd)
    return { enabled: false }

  const diff = Math.floor((today.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24))
  const labels = Array.isArray(chartData.value.labels) ? chartData.value.labels : []

  if (diff < 0 || diff >= labels.length)
    return { enabled: false }

  const strokeColor = isDark.value ? 'rgba(165, 180, 252, 0.75)' : 'rgba(99, 102, 241, 0.7)'
  const glowColor = isDark.value ? 'rgba(129, 140, 248, 0.35)' : 'rgba(165, 180, 252, 0.35)'
  const badgeFill = isDark.value ? 'rgba(67, 56, 202, 0.45)' : 'rgba(199, 210, 254, 0.85)'
  const textColor = isDark.value ? '#e0e7ff' : '#312e81'

  return {
    enabled: true,
    xIndex: diff,
    label: t('today'),
    color: strokeColor,
    glowColor,
    badgeFill,
    textColor,
  }
})

// Calculate appropriate Y-axis max based on actual data values
const dataMax = computed(() => {
  const allValues: number[] = []

  // Collect values from main data
  const mainData = accumulateData.value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  allValues.push(...mainData)

  // Collect values from per-app data
  Object.values(props.dataByApp || {}).forEach((appData: any) => {
    if (Array.isArray(appData)) {
      const filtered = appData.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      allValues.push(...filtered)
    }
  })

  if (allValues.length === 0)
    return undefined

  const max = Math.max(...allValues)
  // Add 20% padding to the max so the line isn't at the very top
  // Also ensure a minimum visible range
  if (max <= 0)
    return undefined

  return max * 1.2
})

const chartOptions = computed<ChartOptions & { plugins: { inlineAnnotationPlugin: AnnotationOptions, todayLine?: any } }>(() => {
  const scales = createStackedChartScales(isDark.value, hasAppData.value)

  // If we have a calculated max, use it to ensure small values are visible
  if (dataMax.value !== undefined) {
    (scales.y as any).suggestedMax = dataMax.value
  }

  return {
    maintainAspectRatio: false,
    scales,
    plugins: {
      inlineAnnotationPlugin: generateAnnotations.value,
      legend: createLegendConfig(isDark.value, !hasAppData.value),
      title: {
        display: false,
      },
      tooltip: createTooltipConfig(hasAppData.value, props.accumulated, props.useBillingPeriod ? cycleStart : false, hasAppData.value ? tooltipClickHandler.value : undefined),
      filler: {
        propagate: false,
      },
      todayLine: todayLineOptions.value as any,
    },
  }
})

const sharedPlugins = [inlineAnnotationPlugin, verticalLinePlugin, todayLinePlugin]
const linePlugins = sharedPlugins as unknown as Plugin<'line'>[]
const barPlugins = sharedPlugins as unknown as Plugin<'bar'>[]
</script>

<template>
  <div class="flex min-h-full flex-col">
    <div class="min-h-[16rem] flex-1">
      <Line v-if="accumulated" :data="chartData as any" height="auto" :options="(chartOptions as any)" :plugins="linePlugins" />
      <Bar v-else :data="chartData as any" height="auto" :options="(chartOptions as any)" :plugins="barPlugins" />
    </div>
    <ChartLegend :items="legendItems" />
  </div>
</template>
