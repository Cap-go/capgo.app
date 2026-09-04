<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { NativeDailyPlatformActive } from '~/services/nativeDeviceStats'
import { useDark } from '@vueuse/core'
import { CategoryScale, Chart, Filler, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { createChartScales } from '~/services/chartConfig'
import { createTooltipConfig } from '~/services/chartTooltip'
import { formatNumberValue } from '~/services/formatLocale'
import ChartCard from './ChartCard.vue'

const props = defineProps({
  dailyPlatformActive: {
    type: Object as () => NativeDailyPlatformActive | null,
    default: null,
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
  hasData: {
    type: Boolean,
    default: false,
  },
  isDemoData: {
    type: Boolean,
    default: false,
  },
})

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

const { t } = useI18n()
const isDark = useDark()

const chartData = computed<ChartData<'line'> | null>(() => {
  if (!props.dailyPlatformActive)
    return null

  return {
    labels: props.dailyPlatformActive.labels,
    datasets: [
      {
        label: t('native-active-devices-android'),
        data: props.dailyPlatformActive.android,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.15)',
        tension: 0.3,
        pointRadius: 2,
        pointBorderWidth: 0,
        borderWidth: 2,
        fill: false,
      },
      {
        label: t('native-active-devices-ios'),
        data: props.dailyPlatformActive.ios,
        borderColor: '#119eff',
        backgroundColor: 'rgba(17, 158, 255, 0.15)',
        tension: 0.3,
        pointRadius: 2,
        pointBorderWidth: 0,
        borderWidth: 2,
        fill: false,
      },
    ],
  }
})

const chartOptions = computed<ChartOptions<'line'>>(() => {
  const pluginOptions = {
    legend: {
      display: true,
      position: 'bottom' as const,
    },
    title: { display: false },
    tooltip: createTooltipConfig(true, false, false),
  } as const

  return {
    maintainAspectRatio: false,
    scales: createChartScales(isDark.value, {
      yTickCallback: (tickValue: string | number) => {
        const numericValue = typeof tickValue === 'number' ? tickValue : Number(tickValue)
        if (!Number.isFinite(numericValue))
          return String(tickValue)
        return formatNumberValue(numericValue)
      },
    }),
    plugins: pluginOptions as unknown as NonNullable<ChartOptions<'line'>['plugins']>,
  }
})
</script>

<template>
  <ChartCard
    chart-id="native-platform-active-trend"
    :title="t('native-platform-active-trend')"
    :is-loading="isLoading"
    :has-data="hasData"
    :is-demo-data="isDemoData"
  >
    <Line
      v-if="chartData"
      class="h-full w-full"
      :data="chartData"
      :options="chartOptions"
    />
  </ChartCard>
</template>
