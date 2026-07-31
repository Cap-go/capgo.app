import type { SupabaseClient } from '@supabase/supabase-js'
import colors from 'tailwindcss/colors'
import { ref } from 'vue'
import { invokeCapgoApi } from '~/services/capgoApi'

const SKIP_COLOR = 10
const colorKeys = Object.keys(colors)
const chartDataCache = ref<Map<string, any>>(new Map())

function formatDateParam(date: Date) {
  const normalized = new Date(date)
  normalized.setUTCHours(0, 0, 0, 0)
  return normalized.toISOString().slice(0, 10)
}

function clampToToday(date: Date): Date {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  return date > today ? today : date
}

type VersionUsageKind = 'bundle' | 'native'

function buildCacheKey(appId: string, from: Date, to: Date, kind: VersionUsageKind) {
  return `${appId}|${kind}|${formatDateParam(from)}|${formatDateParam(to)}`
}

export async function useChartData(supabase: SupabaseClient, appId: string, from: Date, to: Date, kind: VersionUsageKind = 'bundle') {
  const cacheKey = buildCacheKey(appId, from, to, kind)

  if (chartDataCache.value.has(cacheKey))
    return chartDataCache.value.get(cacheKey)

  // Clamp the 'to' date to today - we can't fetch data for future dates
  const clampedTo = clampToToday(to)
  const fromParam = formatDateParam(from)
  const toParam = formatDateParam(clampedTo)
  const usagePath = kind === 'native' ? 'native_usage' : 'bundle_usage'
  const { error, data } = await invokeCapgoApi(`statistics/app/${appId}/${usagePath}?from=${fromParam}&to=${toParam}`, {
    client: supabase,
    method: 'GET',
  })
  if (error)
    return null

  interface ChartDataset {
    label: string
    data: number[]
    metaCounts?: number[]
  }

  interface ChartData {
    labels: string[]
    datasets: ChartDataset[]
    latestVersion: {
      name: string
      percentage: string
    }
  }

  const chartDataFromApi = data as ChartData
  const finalData = {
    labels: chartDataFromApi.labels,
    datasets: chartDataFromApi.datasets.map((dataset, i) => {
      const color = colorKeys[(i + SKIP_COLOR) % colorKeys.length]
      const metaCounts = Array.isArray(dataset.metaCounts)
        ? dataset.metaCounts.map(value => Math.max(0, Math.round(Number(value) || 0)))
        : undefined

      return {
        borderColor: colors[color as keyof typeof colors][400],
        backgroundColor: colors[color as keyof typeof colors][200],
        tension: 0.3,
        pointRadius: 2,
        pointBorderWidth: 0,
        ...dataset,
        ...(metaCounts ? { metaCountValues: metaCounts } : {}),
      }
    }),
    latestVersion: chartDataFromApi.latestVersion,
  }
  chartDataCache.value.set(cacheKey, finalData)
  return finalData
}
