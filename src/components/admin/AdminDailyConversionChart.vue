<script setup lang="ts">
import type { PropType } from 'vue'
import type { AdminDailyConversionPoint } from '~/components/admin/adminDailyConversionChart'
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
import {
  buildAdminDailyConversionChartData,
  buildAdminDailyConversionChartOptions,
} from '~/components/admin/adminDailyConversionChart'

const props = defineProps({
  points: {
    type: Array as PropType<AdminDailyConversionPoint[]>,
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
  attemptsLabel: {
    type: String,
    required: true,
  },
  color: {
    type: String,
    required: true,
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
})

const isDark = useDark()

Chart.register(Tooltip, BarController, BarElement, CategoryScale, LinearScale, Legend)

const chartData = computed(() => buildAdminDailyConversionChartData(props.points, props.label, props.color))
const chartOptions = computed(() => buildAdminDailyConversionChartOptions(props.points, isDark.value, props.attemptsLabel))
</script>

<template>
  <div class="relative w-full h-full overflow-hidden">
    <div v-if="isLoading" class="flex items-center justify-center h-full">
      <span class="d-loading d-loading-spinner d-loading-lg text-primary" />
    </div>
    <div v-else class="w-full h-full">
      <Bar class="w-full h-full" :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>
