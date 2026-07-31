<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import { useDark } from '@vueuse/core'
import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js'
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import { createChartColorWithOpacity, resolveAccessibleChartColor } from '~/services/chartConfig'
import { formatLocalDate, formatLocalMonthYear } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

interface DataSeries {
  label: string
  data: Array<{ date: string, value: number }>
  color: string
}

const props = defineProps({
  series: {
    type: Array as () => DataSeries[],
    required: true,
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
  dateGranularity: {
    type: String as () => 'day' | 'month',
    default: 'day',
  },
  valuePrefix: {
    type: String,
    default: '',
  },
  valueSuffix: {
    type: String,
    default: '',
  },
  beginAtZero: {
    type: Boolean,
    default: true,
  },
  suggestedMin: {
    type: Number,
    default: undefined,
  },
  suggestedMax: {
    type: Number,
    default: undefined,
  },
})

const isDark = useDark()

function formatChartDate(date: string) {
  if (props.dateGranularity === 'month') {
    const formattedMonth = formatLocalMonthYear(date)
    if (formattedMonth)
      return formattedMonth
  }
  return formatLocalDate(date) || date
}

function formatChartValue(value: number) {
  return `${props.valuePrefix}${formatNumberValue(value, { maximumFractionDigits: 2 })}${props.valueSuffix}`
}

Chart.register(
  Tooltip,
  LineController,
  PointElement,
  CategoryScale,
  LinearScale,
  LineElement,
  Filler,
  Legend,
)

const chartData = computed<ChartData<'line'>>(() => {
  if (props.series.length === 0 || props.series[0].data.length === 0) {
    return {
      labels: [],
      datasets: [],
    }
  }

  const labels = props.series[0].data.map(item => item.date)
    .map(item => formatChartDate(item))

  const datasets = props.series.map((series) => {
    const lineColor = resolveAccessibleChartColor(series.color, isDark.value)

    return {
      label: series.label,
      data: series.data.map(item => item.value),
      borderColor: lineColor,
      backgroundColor: createChartColorWithOpacity(lineColor, 0.2),
      fill: false,
      tension: 0.4,
      pointRadius: 3,
      pointBackgroundColor: lineColor,
      pointBorderColor: isDark.value ? '#0f172a' : '#ffffff',
      pointBorderWidth: 1,
      borderWidth: 2,
    }
  })

  return {
    labels,
    datasets,
  }
})

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  layout: {
    padding: {
      left: 0,
      right: 0,
      top: 10,
      bottom: 10,
    },
  },
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: {
      display: true,
      position: 'bottom',
      labels: {
        color: isDark.value ? '#d1d5db' : '#4b5563',
        boxHeight: 10,
        boxWidth: 10,
        font: {
          size: 12,
          weight: 500,
        },
        padding: 18,
        usePointStyle: true,
      },
    },
    tooltip: {
      backgroundColor: isDark.value ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      titleColor: isDark.value ? '#f3f4f6' : '#1f2937',
      bodyColor: isDark.value ? '#d1d5db' : '#4b5563',
      borderColor: isDark.value ? '#374151' : '#e5e7eb',
      borderWidth: 1,
      padding: 12,
      displayColors: true,
      callbacks: {
        label: (context) => {
          const label = context.dataset.label || ''
          const value = formatChartValue(Number(context.parsed.y ?? 0))
          return `${label}: ${value}`
        },
      },
    },
  },
  scales: {
    x: {
      grid: {
        display: false,
      },
      ticks: {
        color: isDark.value ? '#9ca3af' : '#6b7280',
        maxRotation: 0,
        minRotation: 0,
        autoSkip: true,
        maxTicksLimit: 10,
      },
    },
    y: {
      beginAtZero: props.beginAtZero,
      suggestedMin: props.suggestedMin,
      suggestedMax: props.suggestedMax,
      grid: {
        color: isDark.value ? 'rgba(75, 85, 99, 0.3)' : 'rgba(229, 231, 235, 0.8)',
      },
      ticks: {
        color: isDark.value ? '#9ca3af' : '#6b7280',
        callback: (value) => {
          if (typeof value === 'number')
            return formatChartValue(value)
          return value
        },
      },
    },
  },
}))
</script>

<template>
  <div class="relative w-full h-full overflow-hidden">
    <div v-if="isLoading" class="flex items-center justify-center h-full">
      <span class="loading loading-spinner loading-lg text-primary" />
    </div>
    <div v-else class="w-full h-full">
      <Line class="h-full w-full" :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>
