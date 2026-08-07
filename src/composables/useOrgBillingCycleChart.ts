import type { MaybeRefOrGetter } from 'vue'
import { toValue } from 'vue'
import { getTodayLimit, transformSeries } from '~/services/buildCharts'
import { normalizeToUtcStartOfDay } from '~/services/date'
import { useOrganizationStore } from '~/stores/organization'

/**
 * Shared UTC billing-cycle helpers for dashboard daily charts.
 * Keeps today-limit / series transform logic in one place for Sonar + consistency.
 */
export function useOrgBillingCycleChart(
  useBillingPeriod: MaybeRefOrGetter<boolean>,
  subscriptionStart?: MaybeRefOrGetter<string | Date | null | undefined>,
  subscriptionEnd?: MaybeRefOrGetter<string | Date | null | undefined>,
) {
  function resolveCycleStart() {
    return normalizeToUtcStartOfDay(new Date(toValue(subscriptionStart) ?? new Date()))
  }

  function resolveCycleEnd() {
    const end = normalizeToUtcStartOfDay(new Date(toValue(subscriptionEnd) ?? new Date()))
    const today = normalizeToUtcStartOfDay()
    return end < today ? today : end
  }

  function todayLimit(labelCount: number) {
    return getTodayLimit(labelCount, toValue(useBillingPeriod), resolveCycleStart(), resolveCycleEnd())
  }

  function transformDailySeries(source: number[], accumulated: boolean, labelCount: number) {
    return transformSeries(source, accumulated, labelCount, todayLimit(labelCount))
  }

  return {
    resolveCycleStart,
    resolveCycleEnd,
    todayLimit,
    transformDailySeries,
  }
}

/** Convenience wrapper for charts scoped to the current organization. */
export function useCurrentOrgBillingCycleChart(useBillingPeriod: MaybeRefOrGetter<boolean>) {
  const organizationStore = useOrganizationStore()
  return useOrgBillingCycleChart(
    useBillingPeriod,
    () => organizationStore.currentOrganization?.subscription_start,
    () => organizationStore.currentOrganization?.subscription_end,
  )
}

/** One-shot helper: current-org cycle bounds plus today/transform helpers. */
export function useDashboardDailyChartCycle(useBillingPeriod: MaybeRefOrGetter<boolean>) {
  const chartCycle = useCurrentOrgBillingCycleChart(useBillingPeriod)
  return {
    cycleStart: chartCycle.resolveCycleStart(),
    cycleEnd: chartCycle.resolveCycleEnd(),
    todayLimit: chartCycle.todayLimit,
    transformDailySeries: chartCycle.transformDailySeries,
  }
}
