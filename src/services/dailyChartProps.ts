import { getDaysInCurrentUtcMonth } from '~/services/date'

/** Shared prop definitions for dashboard daily bar/line charts. */
export function dailyChartBaseProps() {
  return {
    title: { type: String, default: '' },
    colors: { type: Object, default: () => ({}) },
    limits: { type: Object, default: () => ({}) },
    data: { type: Array, default: () => Array.from({ length: getDaysInCurrentUtcMonth() }).fill(0) as number[] },
    dataByApp: { type: Object, default: () => ({}) },
    appNames: { type: Object, default: () => ({}) },
    useBillingPeriod: { type: Boolean, default: true },
    accumulated: { type: Boolean, default: false },
  }
}
