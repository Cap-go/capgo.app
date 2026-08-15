<script setup lang="ts">
import type { AdminStackedBarDataset } from '~/components/admin/adminStackedBarChart'
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
import { applyAdminStackedBarAccessibleBorders, buildAdminStackedBarChartData, buildAdminStackedBarChartOptions } from '~/components/admin/adminStackedBarChart'
import { formatLocalDate } from '~/services/date'

interface DataSeries {
  label: string
  data: Array<{ date: string, value: number }>
  color: string
  stack?: string
  stackLabel?: string
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
  accessibleBorders: {
    type: Boolean,
    default: false,
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

const chartData = computed(() => {
  if (props.series.length === 0 || props.series[0].data.length === 0)
    return buildAdminStackedBarChartData([], [])

  const labels = props.series[0].data.map(item => formatLocalDate(item.date) || item.date)
  const datasets: AdminStackedBarDataset[] = props.series.map(item => ({
    label: item.label,
    data: item.data.map(point => point.value),
    color: item.color,
    stack: item.stack,
    stackLabel: item.stackLabel,
  }))

  return applyAdminStackedBarAccessibleBorders(
    buildAdminStackedBarChartData(labels, datasets),
    props.accessibleBorders,
    isDark.value,
  )
})

const hasGroupedStacks = computed(() => props.series.some(item => item.stack !== undefined))
const chartOptions = computed(() => buildAdminStackedBarChartOptions(isDark.value, hasGroupedStacks.value))
</script>

<template>
  <div class="relative w-full h-full overflow-hidden">
    <div v-if="isLoading" class="flex items-center justify-center h-full">
      <span class="d-loading d-loading-spinner d-loading-lg text-primary" />
    </div>
    <div v-else class="w-full h-full">
      <Bar class="h-full w-full" :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>
