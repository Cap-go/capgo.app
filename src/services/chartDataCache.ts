// Lives apart from chartDataService.ts so the auth guard can clear it without loading the chart code.
// Values keep the loose typing the chart components already rely on.
const chartDataCache = new Map<string, any>()

export function getCachedChartData(key: string) {
  return chartDataCache.get(key)
}

export function setCachedChartData(key: string, data: any) {
  chartDataCache.set(key, data)
}

export function hasCachedChartData(key: string) {
  return chartDataCache.has(key)
}

export function clearChartDataCache() {
  chartDataCache.clear()
}
