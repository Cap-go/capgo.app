<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import { useDark } from '@vueuse/core'
import { CategoryScale, Chart, LinearScale, Tooltip } from 'chart.js'
import { FunnelController, TrapezoidElement } from 'chartjs-chart-funnel'
import { computed } from 'vue'
import { Chart as ChartComponent } from 'vue-chartjs'
import { formatNumberValue } from '~/services/formatLocale'

interface FunnelStage {
  label: string
  value: number
  color: string
}

const props = defineProps({
  stages: {
    type: Array as () => FunnelStage[],
    required: true,
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
})

const isDark = useDark()

Chart.register(FunnelController, TrapezoidElement, CategoryScale, LinearScale, Tooltip)

const chartData = computed<ChartData<'funnel'>>(() => {
  if (props.stages.length === 0) {
    return {
      labels: [],
      datasets: [],
    }
  }

  return {
    labels: props.stages.map(stage => stage.label),
    datasets: [
      {
        data: props.stages.map(stage => stage.value),
        backgroundColor: props.stages.map(stage => stage.color),
        borderWidth: 0,
        shrinkAnchor: 'top',
        shrinkFraction: 1,
      },
    ],
  }
})

const chartOptions = computed<ChartOptions<'funnel'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  align: 'left',
  layout: {
    padding: {
      left: 8,
      right: 16,
      top: 8,
      bottom: 8,
    },
  },
  plugins: {
    legend: {
      display: false,
    },
    tooltip: {
      backgroundColor: isDark.value ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      titleColor: isDark.value ? '#f3f4f6' : '#111827',
      bodyColor: isDark.value ? '#d1d5db' : '#4b5563',
      borderColor: isDark.value ? '#374151' : '#e5e7eb',
      borderWidth: 1,
      padding: 12,
      callbacks: {
        label: (context) => {
          const rawValue = typeof context.parsed.y === 'number' ? context.parsed.y : context.parsed.x
          const value = Number(rawValue || 0)
          const baseline = props.stages[0]?.value || 0
          const percent = baseline > 0 ? (value / baseline) * 100 : 0
          const label = context.label || ''
          return `${label}: ${formatNumberValue(value)} (${formatNumberValue(percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)`
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
        autoSkip: false,
      },
    },
    y: {
      display: false,
      grid: {
        display: false,
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
      <ChartComponent class="h-full w-full" type="funnel" :data="chartData" :options="(chartOptions as unknown as ChartOptions)" />
    </div>
  </div>
</template>
