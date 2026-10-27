<script setup lang="ts">
import type { ChartData, ChartOptions, Plugin } from 'chart.js'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Line } from '~/components/dashboard/lazyCharts'
import { useBuildChartConfig } from '~/composables/useBuildChartConfig'
import { transformSeries } from '~/services/buildCharts'
import { todayLinePlugin, verticalLinePlugin } from '~/services/chartTooltip'

const props = defineProps({
  // Real build minutes per day.
  data: { type: Array, default: () => [] },
  useBillingPeriod: { type: Boolean, default: true },
  accumulated: { type: Boolean, default: false },
  appId: { type: String, default: '' },
})

const { t } = useI18n()

const { monthdays, todayLimit, chartOptions } = useBuildChartConfig(props, { stacked: false, hasLegend: false })

// Build time is always rendered as a line (daily values or cumulative).
const chartData = computed<ChartData<'line'>>(() => {
  const labels = monthdays()
  const labelCount = labels.length
  const limitIndex = todayLimit(labelCount)
  const processed = transformSeries(props.data as number[], props.accumulated, labelCount, limitIndex)

  return {
    labels,
    datasets: [
      {
        label: t('build-time'),
        data: processed.display as number[],
        backgroundColor: 'hsla(265, 60%, 60%, 0.22)',
        borderColor: 'hsl(265, 60%, 52%)',
        borderWidth: 2,
        fill: 'origin',
        tension: 0.3,
        pointRadius: 0,
        pointBorderWidth: 0,
        metaBaseValues: processed.base,
      } as any,
    ],
  }
})

const lineChartOptions = computed(() => chartOptions.value as unknown as ChartOptions<'line'>)
const linePlugins = [verticalLinePlugin, todayLinePlugin] as unknown as Plugin<'line'>[]
</script>

<template>
  <div class="w-full h-full">
    <Line :data="chartData" :options="lineChartOptions" :plugins="linePlugins" />
  </div>
</template>
