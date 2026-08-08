import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue } from 'vue'
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
    const today = normalizeToUtcStartOfDay()
    const rawEnd = toValue(subscriptionEnd)
    if (!rawEnd)
      return today

    const end = normalizeToUtcStartOfDay(new Date(rawEnd))
    if (Number.isNaN(end.getTime()))
      return today

    // Active cycle: stop at today so future empty days are not rendered.
    // Expired cycle: keep subscription_end so the period does not stretch to today.
    return end.getTime() > today.getTime() ? today : end
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

/** Reactive current-org cycle bounds plus today/transform helpers. */
export function useDashboardDailyChartCycle(useBillingPeriod: MaybeRefOrGetter<boolean>) {
  const chartCycle = useCurrentOrgBillingCycleChart(useBillingPeriod)
  const cycleStart = computed(() => chartCycle.resolveCycleStart())
  const cycleEnd = computed(() => chartCycle.resolveCycleEnd())
  return {
    cycleStart,
    cycleEnd,
    todayLimit: chartCycle.todayLimit,
    transformDailySeries: chartCycle.transformDailySeries,
  }
}
