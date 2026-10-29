<script setup lang="ts">
import type { Database } from '~/types/database.types'
import colors from 'tailwindcss/colors'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDashboardRequestState } from '~/composables/useDashboardRequestState'
import { computeLastDayEvolution } from '~/services/buildCharts'
import { useConsole } from '~/services/console'
import { readAllConsoleRows } from '~/services/consoleRows'
import { normalizeToUtcStartOfDay } from '~/services/date'
import {
  calculateDemoEvolution,
  calculateDemoTotal,
  DEMO_APP_NAMES,
  generateConsistentDemoData,
  generateDemoBundleUploadsData,
  getDemoDayCount,
} from '~/services/demoChartData'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useOrganizationStore } from '~/stores/organization'
import { filterDailySeriesToBillingPeriod, resolveDashboardDailySeriesWindow } from '~/utils/chartOptimizations'
import { shouldShowDashboardDemoData } from '~/utils/dashboardDemoMode'
import BundleUploadsChart from './BundleUploadsChart.vue'
import ChartCard from './ChartCard.vue'

type UploadDailyCount = Database['public']['Functions']['get_bundle_upload_daily_counts']['Returns'][number]

const props = defineProps({
  useBillingPeriod: {
    type: Boolean,
    default: true,
  },
  accumulated: {
    type: Boolean,
    default: false,
  },
  appId: {
    type: String,
    default: '',
  },
  reloadTrigger: {
    type: Number,
    default: 0,
  },
  forceDemo: {
    type: Boolean,
    default: false,
  },
})

const { t } = useI18n()
const organizationStore = useOrganizationStore()

const total = ref(0)
const lastDayEvolution = ref(0)
const bundleData = ref<number[]>([])
const bundleDataByApp = ref<{ [appId: string]: number[] }>({})
const appNames = ref<{ [appId: string]: string }>({})
const dataScope = computed(() => `${organizationStore.currentOrganization?.gid}:${props.appId}:${props.useBillingPeriod}:${props.forceDemo}`)
const loading = useDashboardRequestState(dataScope)
const { isLoading, isRefreshing, error: loadError } = loading

// Per-org cache for raw API data: Map<orgId, cachedData>
const cacheByOrg = new Map<string, UploadDailyCount[]>()
// Cache for single app name to avoid refetching
const singleAppNameCache = new Map<string, string>()

// Generate consistent demo data where total is derived from per-app breakdown
const consistentDemoData = computed(() => {
  const days = getDemoDayCount(props.useBillingPeriod, bundleData.value.length)
  return generateConsistentDemoData(days, generateDemoBundleUploadsData)
})

const demoBundleData = computed(() => consistentDemoData.value.total)
const demoDataByApp = computed(() => consistentDemoData.value.byApp)

const dashboardAppsStore = useDashboardAppsStore()
const isDemoMode = computed(() => shouldShowDashboardDemoData({
  forceDemo: props.forceDemo,
  appId: props.appId,
  appsCount: dashboardAppsStore.apps.length,
  appsLoaded: dashboardAppsStore.isLoaded,
}))

// Effective values for display
const effectiveBundleData = computed(() => isDemoMode.value ? demoBundleData.value : bundleData.value)
const effectiveBundleDataByApp = computed(() => isDemoMode.value ? demoDataByApp.value : bundleDataByApp.value)
const effectiveAppNames = computed(() => isDemoMode.value ? DEMO_APP_NAMES : appNames.value)
const effectiveTotal = computed(() => isDemoMode.value ? calculateDemoTotal(demoBundleData.value) : total.value)
const effectiveLastDayEvolution = computed(() => isDemoMode.value ? calculateDemoEvolution(demoBundleData.value) : lastDayEvolution.value)

const hasData = computed(() => effectiveTotal.value > 0 || isDemoMode.value)

async function calculateStats(forceRefetch = false) {
  const request = loading.start()
  try {
    if (request.isInitial) {
      total.value = 0
      lastDayEvolution.value = 0
      bundleDataByApp.value = {}
      appNames.value = {}
      bundleData.value = []
    }
    if (props.forceDemo)
      return

    const currentOrgId = organizationStore.currentOrganization?.gid ?? null

    // Get billing period dates for filtering
    const billingStart = normalizeToUtcStartOfDay(new Date(organizationStore.currentOrganization?.subscription_start ?? new Date()))
    const { seriesStart: last30DaysStart, exclusiveEnd: last30DaysEnd, dayCount } = resolveDashboardDailySeriesWindow(
      props.useBillingPeriod,
      billingStart,
    )
    const cacheKey = `${currentOrgId}:${props.appId}:${last30DaysStart.toISOString()}:${last30DaysEnd.toISOString()}`

    // Determine target apps
    const localAppNames: { [appId: string]: string } = {}
    let targetAppIds: string[] = []

    if (props.appId) {
      // Single app mode
      targetAppIds = [props.appId]
      let cachedName = singleAppNameCache.get(props.appId) ?? ''
      if (!cachedName) {
        try {
          const { data: appRow } = await useConsole()
            .from('apps')
            .select('name')
            .eq('app_id', props.appId)
            .single()
          cachedName = appRow?.name ?? props.appId
        }
        catch (error) {
          console.error('Error fetching app name for bundle stats:', error)
          cachedName = props.appId
        }
        singleAppNameCache.set(props.appId, cachedName)
      }
      if (!request.isCurrent())
        return
      localAppNames[props.appId] = cachedName || props.appId
      appNames.value = localAppNames
    }
    else {
      // Multiple apps mode - use store for shared apps data
      const dashboardAppsStore = useDashboardAppsStore()
      await dashboardAppsStore.fetchApps()
      if (!request.isCurrent())
        return
      if (!dashboardAppsStore.isLoaded)
        throw new Error('App catalog unavailable')

      targetAppIds = [...dashboardAppsStore.appIds]
      appNames.value = dashboardAppsStore.appNames
    }

    if (targetAppIds.length === 0) {
      total.value = 0
      lastDayEvolution.value = 0
      bundleData.value = Array.from({ length: dayCount }).fill(0) as number[]
      bundleDataByApp.value = {}
      return
    }

    // Check per-org cache - only use cache if not forcing refetch
    let data: UploadDailyCount[] | null = null
    let error = null
    const cachedData = cacheByOrg.get(cacheKey)

    if (cachedData && !forceRefetch) {
      data = cachedData
    }
    else {
      // Per-day upload counts for the series window (billing cycle or last 30 UTC
      // days), aggregated in the database instead of downloading every bundle.
      const result = await readAllConsoleRows<UploadDailyCount>((from, to) => {
        if (!request.isCurrent())
          return Promise.resolve({ data: [], error: null })
        return useConsole()
          .rpc('get_bundle_upload_daily_counts', {
            p_app_ids: targetAppIds,
            p_start: last30DaysStart.toISOString(),
            p_end: last30DaysEnd.toISOString(),
          })
          .range(from, to)
      })
      data = result.data
      error = result.error
      if (!request.isCurrent())
        return

      // Store in per-org cache
      if (!error && data && currentOrgId) {
        cacheByOrg.set(cacheKey, data)
      }
    }

    if (error)
      throw error

    if (data) {
      // Create fresh arrays for processing
      const dailyCounts30Days = Array.from({ length: dayCount }).fill(0) as number[]
      const bundleDataByApp30Days: { [appId: string]: number[] } = {}
      targetAppIds.forEach((appId) => {
        bundleDataByApp30Days[appId] = Array.from({ length: dayCount }).fill(0) as number[]
      })

      let totalCount = 0
      for (const row of data) {
        if (row.day_index < 0 || row.day_index >= dayCount)
          continue
        const uploads = Number(row.uploads)
        dailyCounts30Days[row.day_index] += uploads
        totalCount += uploads
        if (bundleDataByApp30Days[row.app_id])
          bundleDataByApp30Days[row.app_id][row.day_index] += uploads
      }

      // Filter data based on billing period mode
      if (props.useBillingPeriod) {
        // Show only data within billing period
        const filteredData = filterDailySeriesToBillingPeriod(dailyCounts30Days, last30DaysStart, billingStart)
        bundleData.value = filteredData.data

        // Filter by-app data too
        const filteredByApp: { [appId: string]: number[] } = {}
        Object.keys(bundleDataByApp30Days).forEach((appId) => {
          const filteredAppData = filterDailySeriesToBillingPeriod(bundleDataByApp30Days[appId], last30DaysStart, billingStart)
          filteredByApp[appId] = filteredAppData.data
        })
        bundleDataByApp.value = filteredByApp

        // Recalculate total for billing period only
        total.value = filteredData.data.reduce((sum, count) => sum + count, 0)
      }
      else {
        // Show all 30 days
        bundleData.value = dailyCounts30Days
        bundleDataByApp.value = bundleDataByApp30Days
        total.value = totalCount
      }

      // Calculate evolution (compare last two days with data)
      lastDayEvolution.value = computeLastDayEvolution(bundleData.value)
    }
  }
  catch (error) {
    if (request.isCurrent()) {
      request.fail()
      console.error('Error calculating bundle upload stats:', error)
    }
  }
  finally {
    request.finish()
  }
}

watch([dataScope, () => props.reloadTrigger], (_values, previous) => {
  void calculateStats(!previous || previous[1] !== props.reloadTrigger)
}, { immediate: true })
</script>

<template>
  <ChartCard
    :title="t('bundle_uploads')"
    :total="effectiveTotal"
    :last-day-evolution="effectiveLastDayEvolution"
    :is-loading="isLoading"
    :is-refreshing="isRefreshing"
    :error-message="loadError ? t('error-loading-data') : undefined"
    :has-data="hasData"
    :is-demo-data="isDemoMode"
  >
    <BundleUploadsChart
      :title="t('bundle_uploads')"
      :colors="colors.violet"
      :data="effectiveBundleData"
      :data-by-app="effectiveBundleDataByApp"
      :use-billing-period="useBillingPeriod"
      :accumulated="accumulated"
      :app-names="effectiveAppNames"
    />
  </ChartCard>
</template>
