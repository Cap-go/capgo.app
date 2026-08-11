import type { DateRangePreset, DateRangeValue } from '~/services/dateRange'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  getDateRangeForPreset as getDateRangeForMode,
} from '~/services/dateRange'
import { defaultApiHost, useSupabase } from '~/services/supabase'

export type MetricCategory = 'uploads' | 'distribution' | 'failures' | 'success_rate' | 'platform_overview' | 'org_metrics' | 'mau_trend' | 'success_rate_trend' | 'apps_trend' | 'bundles_trend' | 'deployments_trend' | 'storage_trend' | 'bandwidth_trend' | 'global_stats_trend' | 'plugin_breakdown' | 'trial_organizations' | 'trial_plan_breakdown' | 'onboarding_funnel' | 'cancelled_users' | 'email_type_breakdown' | 'customer_country_breakdown' | 'organization_insights' | 'builder_analytics' | 'builder_capacity' | 'cli_usage' | 'frontend_onboarding_analytics' | 'plans_analytics'

export type DateRangeMode = DateRangePreset
export const DEFAULT_DATE_RANGE_MODE = '30day' as const satisfies DateRangeMode
export { getDateRangeForMode }
export { DATE_RANGE_DURATIONS_MS } from '~/services/dateRange'

type DateRange = DateRangeValue

interface CachedData {
  data: unknown
  timestamp: number
}

interface AdminStatsRequestBody {
  metric_category: MetricCategory
  start_date: string
  end_date: string
  app_id?: string
  org_id?: string
  limit?: number
}

interface AdminStatsResponse {
  success: boolean
  metric_category: MetricCategory
  data: unknown
  period: {
    start: string
    end: string
  }
}

export const useAdminDashboardStore = defineStore('adminDashboard', () => {
  // Filter state
  const selectedOrgId = ref<string | null>(null)
  const selectedAppId = ref<string | null>(null)
  const dateRangeMode = ref<DateRangeMode>(DEFAULT_DATE_RANGE_MODE)
  const customDateRange = ref<DateRange>(getDateRangeForMode(DEFAULT_DATE_RANGE_MODE))

  // Cache state (5-minute TTL)
  const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  const cache = ref<Map<string, CachedData>>(new Map())

  // Loading state — a counter (not a boolean) so concurrent fetchStats() calls (e.g. the
  // builder page loads two categories at once) don't clobber each other's flag.
  const loadingCount = ref(0)
  const isLoading = computed(() => loadingCount.value > 0)
  const loadingCategory = ref<MetricCategory | null>(null)

  // Refresh trigger - increment this to force all watchers to refetch
  const refreshTrigger = ref(0)

  function getRollingDateRange(now = new Date()): DateRange {
    return getDateRangeForMode(dateRangeMode.value, now, customDateRange.value)
  }

  const activeDateRange = computed<DateRange>(() => {
    void refreshTrigger.value
    return getRollingDateRange()
  })

  // Actions
  function setOrgFilter(orgId: string | null) {
    selectedOrgId.value = orgId
    // Clear app filter when org changes
    if (orgId === null)
      selectedAppId.value = null
  }

  function setAppFilter(appId: string | null) {
    selectedAppId.value = appId
  }

  function setDateRangeMode(mode: DateRangeMode) {
    dateRangeMode.value = mode
  }

  function setCustomDateRange(start: Date, end: Date) {
    customDateRange.value = { start, end }
    dateRangeMode.value = 'custom'
  }

  function clearFilters() {
    selectedOrgId.value = null
    selectedAppId.value = null
    dateRangeMode.value = DEFAULT_DATE_RANGE_MODE
  }

  function getCacheKey(category: MetricCategory, range = getRollingDateRange()): string {
    const { start, end } = range
    const orgPart = selectedOrgId.value || 'global'
    const appPart = selectedAppId.value || 'all'
    const isCustom = dateRangeMode.value === 'custom'
    const startBucket = isCustom ? start.toISOString() : start.toISOString().slice(0, 16)
    const endBucket = isCustom ? end.toISOString() : end.toISOString().slice(0, 16)
    return `${category}-${orgPart}-${appPart}-${startBucket}-${endBucket}`
  }

  function isCacheValid(cacheKey: string): boolean {
    const cached = cache.value.get(cacheKey)
    if (!cached)
      return false
    return Date.now() - cached.timestamp < CACHE_TTL
  }

  // Response shape varies by metric_category. Full per-metric runtime schemas are
  // out of scope here; keep the previous polymorphic return contract.
  async function fetchStats(category: MetricCategory, forceRefresh = false): Promise<any> {
    const requestDateRange = getRollingDateRange()
    const cacheKey = getCacheKey(category, requestDateRange)
    const skipCache = category === 'customer_country_breakdown'

    // Check cache
    if (!forceRefresh && !skipCache && isCacheValid(cacheKey)) {
      const cached = cache.value.get(cacheKey)
      return cached?.data
    }

    loadingCount.value++
    loadingCategory.value = category

    try {
      const { start, end } = requestDateRange
      const supabase = useSupabase()

      const body: AdminStatsRequestBody = {
        metric_category: category,
        start_date: start.toISOString(),
        end_date: end.toISOString(),
      }

      if (selectedAppId.value)
        body.app_id = selectedAppId.value

      if (selectedOrgId.value)
        body.org_id = selectedOrgId.value

      if (category === 'org_metrics')
        body.limit = 100

      // Get auth token
      const { data: { session } } = await supabase.auth.getSession()
      if (!session)
        throw new Error('Not authenticated')

      // Call Cloudflare Worker API directly
      const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
      }

      const data: AdminStatsResponse = await response.json()

      if (!data?.success)
        throw new Error('Failed to fetch admin stats')

      // Update cache
      cache.value.set(cacheKey, {
        data: data.data,
        timestamp: Date.now(),
      })

      return data.data
    }
    finally {
      loadingCount.value = Math.max(0, loadingCount.value - 1)
      if (loadingCount.value === 0)
        loadingCategory.value = null
    }
  }

  function invalidateCache() {
    cache.value.clear()
    refreshTrigger.value++
  }

  // Invalidate cache when filters change
  function $reset() {
    clearFilters()
    invalidateCache()
    loadingCount.value = 0
    loadingCategory.value = null
  }

  return {
    // State
    selectedOrgId,
    refreshTrigger,
    selectedAppId,
    dateRangeMode,
    customDateRange,
    isLoading,
    loadingCategory,

    // Computed
    activeDateRange,

    // Actions
    setOrgFilter,
    setAppFilter,
    setDateRangeMode,
    setCustomDateRange,
    clearFilters,
    fetchStats,
    invalidateCache,
    $reset,
  }
})

if (import.meta.hot)
  import.meta.hot.accept(acceptHMRUpdate(useAdminDashboardStore, import.meta.hot))
