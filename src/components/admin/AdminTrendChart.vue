<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import { useDark } from '@vueuse/core'
import {
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
import { Line } from 'vue-chartjs'
import { createChartColorWithOpacity, resolveAccessibleChartColor } from '~/services/chartConfig'
import { formatLocalDate } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

const props = defineProps({
  data: {
    type: Array as () => Array<{ date: string, value: number }>,
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
  color: {
    type: String,
    default: '#6366f1', // indigo-500
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
})

const isDark = useDark()

function formatChartDate(date: string) {
  return formatLocalDate(date) || date
}

Chart.register(
  Tooltip,
  LineController,
  PointElement,
  CategoryScale,
  LinearScale,
  LineElement,
  Filler,
)

const chartData = computed<ChartData<'line'>>(() => {
  const labels = props.data.map(item => item.date)
    .map(item => formatChartDate(item))
  const values = props.data.map(item => item.value)
  const lineColor = resolveAccessibleChartColor(props.color, isDark.value)

  return {
    labels,
    datasets: [
      {
        label: props.label,
        data: values,
        borderColor: lineColor,
        backgroundColor: createChartColorWithOpacity(lineColor, 0.2),
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: lineColor,
        pointBorderColor: isDark.value ? '#0f172a' : '#ffffff',
        pointBorderWidth: 1,
        borderWidth: 2,
      },
    ],
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
      display: false,
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
          const value = formatNumberValue(context.parsed.y ?? 0)
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
      beginAtZero: true,
      grid: {
        color: isDark.value ? 'rgba(75, 85, 99, 0.3)' : 'rgba(229, 231, 235, 0.8)',
      },
      ticks: {
        color: isDark.value ? '#9ca3af' : '#6b7280',
        callback: (value) => {
          if (typeof value === 'number')
            return formatNumberValue(value)
          return value
        },
      },
    },
  },
}))
</script>

<template>
  <div class="relative overflow-hidden w-full h-full">
    <div v-if="isLoading" class="flex justify-center items-center h-full">
      <span class="loading loading-spinner loading-lg text-primary" />
    </div>
    <div v-else class="w-full h-full">
      <Line class="h-full w-full" :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>
