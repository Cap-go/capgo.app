// Lives apart from chartDataService.ts so the auth guard can clear it without loading the chart code.
export const chartDataCache = new Map<string, any>()

export function clearChartDataCache() {
  chartDataCache.clear()
}
