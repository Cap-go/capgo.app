<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import { useDark } from '@vueuse/core'
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js'
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import { formatNumberValue } from '~/services/formatLocale'

const props = defineProps({
  labels: {
    type: Array as () => string[],
    required: true,
  },
  values: {
    type: Array as () => number[],
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
  total: {
    type: Number,
    default: undefined,
  },
  valueMode: {
    type: String as () => 'percent' | 'count',
    default: 'percent',
  },
  valueSuffix: {
    type: String,
    default: '',
  },
})

const isDark = useDark()

Chart.register(
  Tooltip,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Legend,
)

const palette = [
  '#119eff',
  '#22c55e',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#f97316',
  '#3b82f6',
  '#a855f7',
  '#84cc16',
]

function formatCountValue(value: number) {
  const formattedValue = formatNumberValue(value)
  return props.valueSuffix ? `${formattedValue} ${props.valueSuffix}` : formattedValue
}

const chartData = computed<ChartData<'bar'>>(() => ({
  labels: props.labels,
  datasets: [
    {
      label: props.label,
      data: props.values,
      backgroundColor: props.labels.map((_, index) => palette[index % palette.length]),
      borderRadius: 6,
      borderSkipped: false,
    },
  ],
}))

const chartOptions = computed<ChartOptions<'bar'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: 'y',
  layout: {
    padding: {
      left: 0,
      right: 10,
      top: 10,
      bottom: 10,
    },
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
      callbacks: {
        label: (context) => {
          const value = Number(context.parsed.x ?? 0)
          if (props.valueMode === 'count')
            return `${context.dataset.label || props.label}: ${formatCountValue(value)}`

          const percent = `${formatNumberValue(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
          if (props.total) {
            const devices = Math.round((value / 100) * props.total)
            return `${percent} (${formatNumberValue(devices)} devices)`
          }
          return percent
        },
      },
    },
  },
  scales: {
    x: {
      beginAtZero: true,
      suggestedMax: props.valueMode === 'percent' ? 100 : undefined,
      grid: {
        color: isDark.value ? 'rgba(75, 85, 99, 0.3)' : 'rgba(229, 231, 235, 0.8)',
      },
      ticks: {
        color: isDark.value ? '#9ca3af' : '#6b7280',
        callback: (value) => {
          if (props.valueMode === 'count')
            return formatCountValue(Number(value))
          return `${value}%`
        },
      },
    },
    y: {
      grid: {
        display: false,
      },
      ticks: {
        color: isDark.value ? '#9ca3af' : '#6b7280',
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
      <Bar class="h-full w-full" :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>
