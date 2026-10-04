<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { NativeReleasePlatform, NativeReleasePlatformFilter, NativeReleaseSeriesInput } from '~/services/nativeReleaseStats'
import { useDark } from '@vueuse/core'
import { BarElement, CategoryScale, Chart, Legend, LinearScale, Tooltip } from 'chart.js'
import { computed, ref } from 'vue'
import { Bar } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import IconAlertCircle from '~icons/lucide/alert-circle'
import Spinner from '~/components/Spinner.vue'
import { usePeriodDaysQuery } from '~/composables/usePeriodDaysQuery'
import { createChartScales, createLegendConfig } from '~/services/chartConfig'
import { chartLabelCountForPeriodDays, formatLocalDateShort, formatUtcDateParam, getLastNUtcDaysRange } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import {
  buildDemoNativeReleaseData,
  buildNativeReleaseColorMap,
  buildNativeReleaseRows,
  filterNativeReleaseSeries,
  groupNativeReleaseChartSeries,
  parseNativeReleaseSeries,
} from '~/services/nativeReleaseStats'

// The native version chart (DevicesStats) already loads native_usage for the
// same period, so this panel renders that data instead of fetching it again.
const props = withDefaults(defineProps<{
  usageData: { labels: string[], datasets: NativeReleaseSeriesInput[] } | null
  isLoading?: boolean
  forceDemo?: boolean
}>(), {
  isLoading: false,
  forceDemo: false,
})

const emit = defineEmits<{
  retry: []
}>()

Chart.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend)

const { t } = useI18n()
const isDark = useDark()
const { days } = usePeriodDaysQuery()

const platform = ref<NativeReleasePlatformFilter>('all')
const platformOptions: Array<{ value: NativeReleasePlatformFilter, label: string }> = [
  { value: 'all', label: 'native-release-platform-all' },
  { value: 'ios', label: 'iOS' },
  { value: 'android', label: 'Android' },
]

const otherColor = '#94a3b8'
// A finished load with no payload means the native_usage request failed;
// an empty period still returns labels and an empty datasets array.
const hasError = computed(() => !props.forceDemo && !props.isLoading && props.usageData === null)

const effectiveData = computed(() => {
  if (props.forceDemo) {
    const { startDate } = getLastNUtcDaysRange(days.value)
    const demoLabels = Array.from({ length: chartLabelCountForPeriodDays(days.value) }, (_value, index) => {
      const day = new Date(startDate)
      day.setUTCDate(day.getUTCDate() + index)
      return formatUtcDateParam(day)
    })
    return buildDemoNativeReleaseData(demoLabels)
  }
  return props.usageData
})

const labels = computed(() => effectiveData.value?.labels ?? [])
const allSeries = computed(() => parseNativeReleaseSeries(labels.value, effectiveData.value?.datasets ?? []))
const filteredSeries = computed(() => filterNativeReleaseSeries(allSeries.value, platform.value))
const rows = computed(() => buildNativeReleaseRows(labels.value, filteredSeries.value))
const hasData = computed(() => rows.value.length > 0)
const seriesColorByKey = computed(() => buildNativeReleaseColorMap(buildNativeReleaseRows(labels.value, allSeries.value)))

const periodLabel = computed(() => {
  if (days.value === 1)
    return t('last-one-day')
  return t('last-n-days', { days: days.value })
})

const periodRangeLabel = computed(() => {
  const first = labels.value[0]
  const last = labels.value[labels.value.length - 1]
  if (!first || !last)
    return '-'
  return `${formatLocalDateShort(first) || first} - ${formatLocalDateShort(last) || last}`
})

const chartData = computed<ChartData<'bar'>>(() => {
  const { top, other } = groupNativeReleaseChartSeries(rows.value, filteredSeries.value)
  const showPlatformPrefix = platform.value === 'all'
  const datasets: ChartData<'bar'>['datasets'] = top.map((series) => {
    const color = seriesColorByKey.value.get(series.key) ?? otherColor
    return {
      label: showPlatformPrefix ? series.key : series.version,
      data: series.counts,
      backgroundColor: `${color}cc`,
      borderColor: color,
      borderWidth: 1,
      stack: 'devices',
    }
  })
  if (other) {
    datasets.push({
      label: t('native-release-other-versions'),
      data: other,
      backgroundColor: `${otherColor}99`,
      borderColor: otherColor,
      borderWidth: 1,
      stack: 'devices',
    })
  }
  return {
    labels: labels.value.map(label => formatLocalDateShort(label) || label),
    datasets,
  }
})

const chartOptions = computed<ChartOptions<'bar'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: createLegendConfig(isDark.value, true, { position: 'bottom' }) as NonNullable<ChartOptions<'bar'>['plugins']>['legend'],
    tooltip: {
      enabled: true,
      callbacks: {
        label: context => `${context.dataset.label}: ${formatNumberValue(Number(context.parsed.y) || 0)} ${t('devices').toLowerCase()}`,
      },
    },
  },
  scales: createChartScales(isDark.value, {
    xStacked: true,
    yStacked: true,
    yTickCallback: (value) => {
      const numeric = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(numeric) ? formatNumberValue(numeric) : String(value)
    },
  }) as ChartOptions<'bar'>['scales'],
}))

function platformLabel(value: NativeReleasePlatform) {
  if (value === 'ios')
    return 'iOS'
  if (value === 'android')
    return 'Android'
  if (value === 'electron')
    return 'Electron'
  return t('unknown')
}

function platformBadgeClass(value: NativeReleasePlatform) {
  if (value === 'ios')
    return 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200'
  if (value === 'android')
    return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200'
  return 'border-slate-300 bg-slate-100 text-slate-600 dark:border-white/15 dark:bg-white/5 dark:text-slate-300'
}

function formatCount(value: number | null | undefined) {
  return formatNumberValue(value ?? 0)
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '-'
  return `${formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatDay(value: string | null) {
  if (!value)
    return '-'
  return formatLocalDateShort(value) || value
}
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="native-release-stats">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
            {{ t('native-release-stats-title') }}
          </h2>
          <span
            v-if="forceDemo"
            class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            {{ t('demo') }}
          </span>
        </div>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('native-release-stats-help') }}
        </p>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ periodLabel }} · {{ periodRangeLabel }}
        </p>
      </div>
      <fieldset
        class="flex items-center p-1 space-x-1 shrink-0 bg-gray-200 rounded-lg dark:bg-gray-800"
        data-testid="native-release-platform-selector"
      >
        <legend class="sr-only">
          {{ t('platform') }}
        </legend>
        <button
          v-for="option in platformOptions"
          :key="option.value"
          type="button"
          :aria-pressed="platform === option.value"
          class="flex justify-center items-center h-9 min-h-9 min-w-[2.75rem] px-2.5 sm:px-3 py-1.5 text-xs font-medium text-center whitespace-nowrap rounded-md transition-colors duration-150 cursor-pointer"
          :class="platform === option.value
            ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
            : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'"
          @click="platform = option.value"
        >
          {{ option.value === 'all' ? t(option.label) : option.label }}
        </button>
      </fieldset>
    </div>

    <div v-if="props.isLoading && !forceDemo" class="flex items-center justify-center h-48 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
      <Spinner size="w-10 h-10" />
    </div>

    <div
      v-else-if="hasError"
      class="flex flex-col items-center justify-center h-48 gap-3 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400"
    >
      <IconAlertCircle class="w-10 h-10" />
      <p class="text-sm">
        {{ t('native-release-stats-fetch-error') }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-primary" @click="emit('retry')">
        {{ t('update-delivery-retry') }}
      </button>
    </div>

    <div
      v-else-if="!hasData"
      class="flex flex-col items-center justify-center h-48 gap-2 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400"
    >
      <IconAlertCircle class="w-10 h-10" />
      <p>{{ t('native-release-stats-no-data') }}</p>
      <p class="text-sm text-center max-w-lg">
        {{ t('native-release-stats-no-data-help') }}
      </p>
    </div>

    <template v-else>
      <div class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
        <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {{ t('native-release-chart-title') }}
        </h3>
        <div class="h-72 mt-3" data-testid="native-release-chart">
          <Bar :data="chartData" :options="chartOptions" />
        </div>
      </div>

      <div class="overflow-x-auto bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
        <table class="min-w-full text-sm" data-testid="native-release-table">
          <thead class="text-[11px] font-semibold tracking-wider uppercase border-y border-slate-200 text-slate-500 bg-slate-50 dark:border-white/10 dark:text-slate-400 dark:bg-white/[0.03]">
            <tr class="text-left">
              <th scope="col" class="px-4 py-3 font-semibold">
                {{ t('native-release-version') }}
              </th>
              <th scope="col" class="px-4 py-3 font-semibold">
                {{ t('platform') }}
              </th>
              <th scope="col" class="px-4 py-3 font-semibold">
                {{ t('native-release-latest-devices') }}
              </th>
              <th scope="col" class="px-4 py-3 font-semibold">
                {{ t('native-release-platform-share') }}
              </th>
              <th scope="col" class="px-4 py-3 font-semibold">
                {{ t('native-release-peak-devices') }}
              </th>
              <th scope="col" class="px-4 py-3 font-semibold">
                {{ t('native-release-first-seen') }}
              </th>
              <th scope="col" class="px-4 py-3 font-semibold">
                {{ t('last-seen') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.key"
              class="border-b border-slate-100 dark:border-slate-700/70 last:border-b-0"
            >
              <td class="px-4 py-3 font-medium text-slate-900 dark:text-white">
                {{ row.version }}
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex px-2 py-0.5 text-xs font-medium border rounded" :class="platformBadgeClass(row.platform)">
                  {{ platformLabel(row.platform) }}
                </span>
              </td>
              <td class="px-4 py-3 font-semibold text-slate-900 dark:text-white">
                {{ formatCount(row.latest_devices) }}
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
                <div class="flex items-center gap-2">
                  <div class="w-20 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                    <div
                      class="h-full rounded-full"
                      :class="row.platform === 'android' ? 'bg-emerald-500' : 'bg-[#119eff]'"
                      :style="{ width: `${Math.min(100, row.latest_share ?? 0)}%` }"
                    />
                  </div>
                  {{ formatPercent(row.latest_share) }}
                </div>
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
                {{ formatCount(row.peak_devices) }}
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
                {{ formatDay(row.first_seen) }}
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
                {{ formatDay(row.last_seen) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
