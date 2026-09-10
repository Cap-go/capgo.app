import type { SupabaseClient } from '@supabase/supabase-js'
import colors from 'tailwindcss/colors'
import { ref } from 'vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { formatUtcDateParam, normalizeToUtcStartOfDay } from '~/services/date'

const SKIP_COLOR = 10
const colorKeys = Object.keys(colors)
const chartDataCache = ref<Map<string, any>>(new Map())

function clampToToday(date: Date): Date {
  const today = normalizeToUtcStartOfDay()
  return date > today ? today : date
}

type VersionUsageKind = 'bundle' | 'native'

export interface UseChartDataOptions {
  forceRefetch?: boolean
}

function buildCacheKey(sessionId: string, appId: string, from: Date, to: Date, kind: VersionUsageKind) {
  return `${sessionId}|${appId}|${kind}|${formatUtcDateParam(from)}|${formatUtcDateParam(to)}`
}

async function getChartCacheSessionKey(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.auth.getClaims()
  const sub = data?.claims?.sub
  return typeof sub === 'string' && sub.length > 0 ? sub : 'anonymous'
}

export async function useChartData(
  supabase: SupabaseClient,
  appId: string,
  from: Date,
  to: Date,
  kind: VersionUsageKind = 'bundle',
  options?: UseChartDataOptions,
) {
  const sessionKey = await getChartCacheSessionKey(supabase)
  const cacheKey = buildCacheKey(sessionKey, appId, from, to, kind)

  if (!options?.forceRefetch && chartDataCache.value.has(cacheKey))
    return chartDataCache.value.get(cacheKey)

  // Clamp the 'to' date to today - we can't fetch data for future dates
  const clampedTo = clampToToday(to)
  const fromParam = formatUtcDateParam(from)
  const toParam = formatUtcDateParam(clampedTo)
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
    activeDevices?: {
      android: number
      ios: number
      electron: number
      unknown: number
      total: number
    }
    previousPeriodActiveDevices?: {
      android: number
      ios: number
      electron: number
      unknown: number
      total: number
    }
    dailyPlatformActive?: {
      labels: string[]
      android: number[]
      ios: number[]
      electron: number[]
      unknown: number[]
      total: number[]
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
    activeDevices: chartDataFromApi.activeDevices,
    previousPeriodActiveDevices: chartDataFromApi.previousPeriodActiveDevices,
    dailyPlatformActive: chartDataFromApi.dailyPlatformActive,
  }
  chartDataCache.value.set(cacheKey, finalData)
  return finalData
}
