<script setup lang="ts">
import type { ChartData, ChartOptions, Plugin } from 'chart.js'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bar, Line } from '~/components/dashboard/lazyCharts'
import { useBuildChartConfig } from '~/composables/useBuildChartConfig'
import { BUILD_SERIES_KEYS, transformSeries } from '~/services/buildCharts'
import { todayLinePlugin, verticalLinePlugin } from '~/services/chartTooltip'

const props = defineProps({
  // { ios_succeeded: number[], android_succeeded: number[], ios_failed: number[], android_failed: number[] }
  dataBySeries: { type: Object, default: () => ({}) },
  useBillingPeriod: { type: Boolean, default: true },
  accumulated: { type: Boolean, default: false },
  appId: { type: String, default: '' },
})

const { t } = useI18n()

const { monthdays, todayLimit, chartOptions } = useBuildChartConfig(props, { stacked: true, hasLegend: true })

// Semantic, fixed colors: greens for succeeded (iOS deeper, Android lighter),
// red / orange for failed (iOS red, Android orange).
const SERIES_STYLE: Record<string, { labelKey: string, bar: string, line: string, border: string }> = {
  ios_succeeded: { labelKey: 'build-ios-succeeded', bar: 'hsla(145, 63%, 42%, 0.85)', line: 'hsla(145, 63%, 50%, 0.45)', border: 'hsl(145, 63%, 32%)' },
  android_succeeded: { labelKey: 'build-android-succeeded', bar: 'hsla(168, 55%, 55%, 0.85)', line: 'hsla(168, 55%, 58%, 0.4)', border: 'hsl(168, 55%, 38%)' },
  ios_failed: { labelKey: 'build-ios-failed', bar: 'hsla(0, 72%, 52%, 0.85)', line: 'hsla(0, 72%, 58%, 0.4)', border: 'hsl(0, 72%, 40%)' },
  android_failed: { labelKey: 'build-android-failed', bar: 'hsla(28, 85%, 58%, 0.85)', line: 'hsla(28, 85%, 60%, 0.4)', border: 'hsl(28, 80%, 46%)' },
}

const chartData = computed<ChartData<any>>(() => {
  const labels = monthdays()
  const labelCount = labels.length
  const limitIndex = todayLimit(labelCount)
  const source = props.dataBySeries as Record<string, number[]>

  const datasets = BUILD_SERIES_KEYS.map((key, index) => {
    const style = SERIES_STYLE[key]
    const processed = transformSeries(source[key] ?? [], props.accumulated, labelCount, limitIndex)

    const baseDataset: any = {
      label: t(style.labelKey),
      data: processed.display,
      backgroundColor: props.accumulated ? style.line : style.bar,
      borderColor: style.border,
      borderWidth: 1,
      metaBaseValues: processed.base,
    }

    return props.accumulated
      ? { ...baseDataset, fill: index === 0 ? 'origin' : '-1', tension: 0.3, pointRadius: 0, pointBorderWidth: 0 }
      : baseDataset
  })

  return { labels, datasets }
})

const lineChartOptions = computed(() => chartOptions.value as unknown as ChartOptions<'line'>)
const barChartOptions = computed(() => chartOptions.value as unknown as ChartOptions<'bar'>)
const sharedPlugins = [verticalLinePlugin, todayLinePlugin]
const linePlugins = sharedPlugins as unknown as Plugin<'line'>[]
const barPlugins = sharedPlugins as unknown as Plugin<'bar'>[]
</script>

<template>
  <div class="w-full h-full">
    <Line
      v-if="accumulated"
      :data="chartData"
      :options="lineChartOptions"
      :plugins="linePlugins"
    />
    <Bar
      v-else
      :data="chartData"
      :options="barChartOptions"
      :plugins="barPlugins"
    />
  </div>
</template>
