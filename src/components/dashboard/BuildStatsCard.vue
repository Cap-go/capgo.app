<script setup lang="ts">
import type { BuildSeriesData } from '~/services/buildCharts'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BuildStatsChart from '~/components/dashboard/BuildStatsChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { useBuildCardStats } from '~/composables/useBuildCardStats'
import {
  bucketBuildStatus,

  buildSeriesKey,
  computeLastDayEvolution,
  dayIndexInWindow,
  emptyBuildSeries,
  fetchAllRows,
} from '~/services/buildCharts'
import { useConsole } from '~/services/console'

const props = defineProps({
  appId: { type: String, default: '' },
  useBillingPeriod: { type: Boolean, default: false },
  accumulated: { type: Boolean, default: false },
  reloadTrigger: { type: Number, default: 0 },
})

const emit = defineEmits<{ 'update:loading': [value: boolean] }>()

const { t } = useI18n()
const supabase = useConsole()

interface BuildRow { created_at: string | null, platform: string | null, status: string | null }
interface BuildStatsResult { dataBySeries: BuildSeriesData, total: number, evolution: number }

const { isLoading, result } = useBuildCardStats<BuildStatsResult>(props, emit, {
  empty: () => ({ dataBySeries: emptyBuildSeries(), total: 0, evolution: 0 }),
  load: async (window) => {
    const rows = await fetchAllRows<BuildRow>((from, to) => supabase
      .from('build_requests')
      .select('created_at, platform, status')
      .eq('app_id', props.appId)
      .gte('created_at', window.startISO)
      .lte('created_at', window.endISO)
      .order('created_at')
      .range(from, to))

    const series = emptyBuildSeries(window.dayCount)
    const dailyTriggered = Array.from({ length: window.dayCount }).fill(0) as number[]

    for (const row of rows) {
      if (!row.created_at)
        continue
      const dayIndex = dayIndexInWindow(new Date(row.created_at), window.windowStart)
      if (dayIndex < 0 || dayIndex >= window.dayCount)
        continue

      dailyTriggered[dayIndex] += 1

      const outcome = bucketBuildStatus(row.status)
      if (!outcome)
        continue
      const key = buildSeriesKey(row.platform, outcome)
      if (key)
        series[key][dayIndex] += 1
    }

    return {
      dataBySeries: series,
      total: dailyTriggered.reduce((sum, count) => sum + count, 0),
      evolution: computeLastDayEvolution(dailyTriggered),
    }
  },
})

const dataBySeries = computed(() => result.value.dataBySeries)
const totalBuilds = computed(() => result.value.total)
const lastDayEvolution = computed(() => result.value.evolution)
const hasData = computed(() => totalBuilds.value > 0)
</script>

<template>
  <ChartCard
    :title="t('build-statistics')"
    :total="totalBuilds"
    :unit="t('builds')"
    :last-day-evolution="lastDayEvolution"
    :is-loading="isLoading"
    :has-data="hasData"
  >
    <BuildStatsChart
      :key="`${appId}:${JSON.stringify(dataBySeries)}`"
      :data-by-series="dataBySeries"
      :use-billing-period="useBillingPeriod"
      :accumulated="accumulated"
      :app-id="appId"
    />
  </ChartCard>
</template>
