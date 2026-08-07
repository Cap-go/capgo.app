import type { MaybeRefOrGetter } from 'vue'
import { toValue } from 'vue'
import { getTodayLimit, transformSeries } from '~/services/buildCharts'
import { normalizeToUtcStartOfDay } from '~/services/date'

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
