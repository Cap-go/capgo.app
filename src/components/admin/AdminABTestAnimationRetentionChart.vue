<script setup lang="ts">
import type { ChartData, ChartOptions, TooltipItem } from 'chart.js'
import type { AdminChannelAnimationStage } from '~/services/adminABTestChannelCreation'
import { useDark } from '@vueuse/core'
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { createChartColorWithOpacity, resolveAccessibleChartColor } from '~/services/chartConfig'
import { formatNumberValue } from '~/services/formatLocale'
import '~/services/adminABTestAnimationChartRegister'

const props = defineProps<{
  stage: AdminChannelAnimationStage
}>()

const { t } = useI18n()
const isDark = useDark()

const chartData = computed<ChartData<'line'>>(() => {
  const treatmentColor = resolveAccessibleChartColor('#119eff', isDark.value)
  const skipColor = resolveAccessibleChartColor('#f59e0b', isDark.value)
  const viewers = props.stage.retention.map(point => point.viewers)
  const skipPoints = viewers.map((viewersAtProgress, index) => {
    if (index === 0)
      return null
    return (props.stage.skip_progress[index - 1]?.skipped ?? 0) > 0 ? viewersAtProgress : null
  })

  return {
    labels: props.stage.retention.map(point => `${point.progress_percentage}%`),
    datasets: [
      {
        label: t('admin-ab-tests-channel-viewers'),
        data: viewers,
        borderColor: treatmentColor,
        backgroundColor: createChartColorWithOpacity(treatmentColor, 0.16),
        borderWidth: 2,
        fill: true,
        pointBackgroundColor: treatmentColor,
        pointBorderColor: isDark.value ? '#1f2937' : '#ffffff',
        pointBorderWidth: 2,
        pointRadius: 4,
        stepped: true,
      },
      {
        label: t('admin-ab-tests-channel-skips'),
        data: skipPoints,
        borderColor: skipColor,
        backgroundColor: skipColor,
        borderWidth: 0,
        fill: false,
        pointRadius: 6,
        pointHoverRadius: 7,
        pointStyle: 'triangle',
        showLine: false,
        spanGaps: false,
      },
    ],
  }
})

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  layout: {
    padding: { bottom: 4, left: 0, right: 8, top: 8 },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: isDark.value ? 'rgba(15, 23, 42, 0.96)' : 'rgba(255, 255, 255, 0.98)',
      borderColor: isDark.value ? '#475569' : '#cbd5e1',
      borderWidth: 1,
      bodyColor: isDark.value ? '#cbd5e1' : '#475569',
      padding: 10,
      titleColor: isDark.value ? '#f8fafc' : '#0f172a',
      callbacks: {
        label(context: TooltipItem<'line'>) {
          if (context.datasetIndex === 1) {
            const bucket = props.stage.skip_progress[context.dataIndex - 1]
            return bucket
              ? t('admin-ab-tests-channel-skip-bucket', {
                  count: formatNumberValue(bucket.skipped),
                  from: bucket.from_percentage,
                  to: bucket.to_percentage,
                })
              : ''
          }
          return t('admin-ab-tests-channel-viewer-count', { count: formatNumberValue(context.parsed.y ?? 0) })
        },
      },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: isDark.value ? '#94a3b8' : '#64748b' },
      title: {
        color: isDark.value ? '#94a3b8' : '#64748b',
        display: true,
        text: t('admin-ab-tests-channel-animation-progress'),
      },
    },
    y: {
      beginAtZero: true,
      grid: { color: isDark.value ? 'rgba(71, 85, 105, 0.34)' : 'rgba(203, 213, 225, 0.6)' },
      ticks: {
        color: isDark.value ? '#94a3b8' : '#64748b',
        precision: 0,
      },
    },
  },
}))
</script>

<template>
  <figure class="h-64 w-full">
    <Line :data="chartData" :options="chartOptions" />
    <figcaption class="sr-only">
      {{ t('admin-ab-tests-channel-retention-aria') }}
    </figcaption>
  </figure>
</template>
