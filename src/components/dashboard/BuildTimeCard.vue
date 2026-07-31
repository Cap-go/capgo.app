<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BuildTimeChart from '~/components/dashboard/BuildTimeChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { useBuildCardStats } from '~/composables/useBuildCardStats'
import { computeLastDayEvolution, dayIndexInWindow, fetchAllRows } from '~/services/buildCharts'
import { useSupabase } from '~/services/supabase'

const props = defineProps({
  appId: { type: String, default: '' },
  useBillingPeriod: { type: Boolean, default: false },
  accumulated: { type: Boolean, default: false },
  reloadTrigger: { type: Number, default: 0 },
})

const emit = defineEmits<{ 'update:loading': [value: boolean] }>()

const { t } = useI18n()
const supabase = useSupabase()

interface BuildLogRow { created_at: string | null, billable_seconds: number | null }
interface BuildTimeResult { minutesPerDay: number[], total: number, evolution: number }

const { isLoading, result } = useBuildCardStats<BuildTimeResult>(props, emit, {
  empty: () => ({ minutesPerDay: [], total: 0, evolution: 0 }),
  load: async (window) => {
    const rows = await fetchAllRows<BuildLogRow>((from, to) => supabase
      .from('build_logs')
      .select('created_at, billable_seconds')
      .eq('app_id', props.appId)
      .gte('created_at', window.startISO)
      .lte('created_at', window.endISO)
      .order('created_at')
      .range(from, to))

    // Accumulate real build seconds per day, then convert to minutes for display.
    const secondsPerDay = Array.from({ length: window.dayCount }).fill(0) as number[]
    for (const row of rows) {
      if (!row.created_at || row.billable_seconds == null)
        continue
      const dayIndex = dayIndexInWindow(new Date(row.created_at), window.windowStart)
      if (dayIndex < 0 || dayIndex >= window.dayCount)
        continue
      secondsPerDay[dayIndex] += row.billable_seconds
    }

    const minutesPerDay = secondsPerDay.map(seconds => Math.round((seconds / 60) * 10) / 10)
    return {
      minutesPerDay,
      total: Math.round(secondsPerDay.reduce((sum, seconds) => sum + seconds, 0) / 60),
      evolution: computeLastDayEvolution(minutesPerDay),
    }
  },
})

const minutesPerDay = computed(() => result.value.minutesPerDay)
const totalMinutes = computed(() => result.value.total)
const lastDayEvolution = computed(() => result.value.evolution)
const hasData = computed(() => totalMinutes.value > 0)
</script>

<template>
  <ChartCard
    :title="t('build-time')"
    :total="totalMinutes"
    :unit="t('minutes-unit')"
    :last-day-evolution="lastDayEvolution"
    :is-loading="isLoading"
    :has-data="hasData"
  >
    <BuildTimeChart
      :key="`${appId}:${JSON.stringify(minutesPerDay)}`"
      :data="minutesPerDay"
      :use-billing-period="useBillingPeriod"
      :accumulated="accumulated"
      :app-id="appId"
    />
  </ChartCard>
</template>
