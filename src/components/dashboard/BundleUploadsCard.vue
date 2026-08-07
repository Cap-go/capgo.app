<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import colors from 'tailwindcss/colors'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { computeLastDayEvolution } from '~/services/buildCharts'
import { addUtcDays, normalizeToUtcStartOfDay } from '~/services/date'
import {
  calculateDemoEvolution,
  calculateDemoTotal,
  DEMO_APP_NAMES,
  generateConsistentDemoData,
  generateDemoBundleUploadsData,
  getDemoDayCount,
} from '~/services/demoChartData'
import { useSupabase } from '~/services/supabase'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useOrganizationStore } from '~/stores/organization'
import { filterDailySeriesToBillingPeriod } from '~/utils/chartOptimizations'
import { ensureMinDelay } from '~/utils/minDelay'
import BundleUploadsChart from './BundleUploadsChart.vue'
import ChartCard from './ChartCard.vue'

type BundleUploadRow = Pick<
  Database['public']['Tables']['app_versions']['Row'],
  'app_id' | 'created_at' | 'deleted' | 'external_url' | 'r2_path' | 'user_id'
>

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
const isLoading = ref(true)

// Per-org cache for raw API data: Map<orgId, cachedData>
const cacheByOrg = new Map<string, any[]>()
// Track current org for change detection
const currentCacheOrgId = ref<string | null>(null)
// Cache for single app name to avoid refetching
const singleAppNameCache = new Map<string, string>()

// Generate consistent demo data where total is derived from per-app breakdown
const consistentDemoData = computed(() => {
  const days = getDemoDayCount(props.useBillingPeriod, bundleData.value.length)
  return generateConsistentDemoData(days, generateDemoBundleUploadsData)
})

const demoBundleData = computed(() => consistentDemoData.value.total)
const demoDataByApp = computed(() => consistentDemoData.value.byApp)

// Demo mode: show demo data only when forceDemo is true OR user has no apps
// If user has apps, ALWAYS show real data (even if empty)
const isDemoMode = computed(() => {
  if (props.forceDemo)
    return true
  // If user has apps, never show demo data
  const dashboardAppsStore = useDashboardAppsStore()
  if (dashboardAppsStore.apps.length > 0)
    return false
  // No apps and store is loaded = show demo
  return dashboardAppsStore.isLoaded
})

// Effective values for display
const effectiveBundleData = computed(() => isDemoMode.value ? demoBundleData.value : bundleData.value)
const effectiveBundleDataByApp = computed(() => isDemoMode.value ? demoDataByApp.value : bundleDataByApp.value)
const effectiveAppNames = computed(() => isDemoMode.value ? DEMO_APP_NAMES : appNames.value)
const effectiveTotal = computed(() => isDemoMode.value ? calculateDemoTotal(demoBundleData.value) : total.value)
const effectiveLastDayEvolution = computed(() => isDemoMode.value ? calculateDemoEvolution(demoBundleData.value) : lastDayEvolution.value)

const hasData = computed(() => effectiveTotal.value > 0 || isDemoMode.value)

function isSyntheticDefaultVersion(bundle: BundleUploadRow) {
  return bundle.deleted
    && !bundle.r2_path
    && !bundle.external_url
    && !bundle.user_id
}

async function calculateStats(forceRefetch = false) {
  const startTime = Date.now()
  try {
    isLoading.value = true

    // Reset display data
    total.value = 0
    lastDayEvolution.value = 0
    bundleDataByApp.value = {}
    appNames.value = {}
    bundleData.value = []

    const currentOrgId = organizationStore.currentOrganization?.gid ?? null
    const orgChanged = currentCacheOrgId.value !== currentOrgId
    currentCacheOrgId.value = currentOrgId

    // Always work with last 30 UTC days of data
    const last30DaysEnd = new Date()
    const last30DaysStart = addUtcDays(normalizeToUtcStartOfDay(), -29)

    // Get billing period dates for filtering
    const billingStart = normalizeToUtcStartOfDay(new Date(organizationStore.currentOrganization?.subscription_start ?? new Date()))

    // Determine target apps
    const localAppNames: { [appId: string]: string } = {}
    let targetAppIds: string[] = []

    if (props.appId) {
      // Single app mode
      targetAppIds = [props.appId]
      let cachedName = singleAppNameCache.get(props.appId) ?? ''
      if (!cachedName) {
        try {
          const { data: appRow } = await useSupabase()
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
      localAppNames[props.appId] = cachedName || props.appId
      appNames.value = localAppNames
    }
    else {
      // Multiple apps mode - use store for shared apps data
      const dashboardAppsStore = useDashboardAppsStore()
      // Force fetch if org changed to ensure we get fresh data
      await dashboardAppsStore.fetchApps(orgChanged)

      targetAppIds = [...dashboardAppsStore.appIds]
      appNames.value = dashboardAppsStore.appNames
    }

    if (targetAppIds.length === 0) {
      bundleData.value = Array.from({ length: 30 }).fill(0) as number[]
      bundleDataByApp.value = {}
      return
    }

    // Check per-org cache - only use cache if not forcing refetch
    let data: any[] | null = null
    let error = null
    const cachedData = currentOrgId ? cacheByOrg.get(currentOrgId) : null

    if (cachedData && !forceRefetch) {
      data = cachedData
    }
    else {
      // Fetch last 30 days of data
      const query = useSupabase()
        .from('app_versions')
        .select('created_at, app_id, deleted, r2_path, external_url, user_id')
        .gte('created_at', last30DaysStart.toISOString())
        .lte('created_at', last30DaysEnd.toISOString())
        .in('app_id', targetAppIds)

      const result = await query
      data = result.data
      error = result.error

      // Store in per-org cache
      if (!error && data && currentOrgId) {
        cacheByOrg.set(currentOrgId, data)
      }
    }

    if (!error && data) {
      // Create fresh arrays for processing
      const dailyCounts30Days = Array.from({ length: 30 }).fill(0) as number[]
      const bundleDataByApp30Days: { [appId: string]: number[] } = {}
      targetAppIds.forEach((appId) => {
        bundleDataByApp30Days[appId] = Array.from({ length: 30 }).fill(0) as number[]
      })

      // Track total separately (don't use ref during loop)
      let totalCount = 0

      // Map each bundle to the correct day and app (30 days)
      data
        .filter((bundle: BundleUploadRow) => bundle.created_at !== null && bundle.app_id !== null && !isSyntheticDefaultVersion(bundle))
        .forEach((bundle: any) => {
          if (bundle.created_at && bundle.app_id) {
            const bundleDate = new Date(bundle.created_at)

            // Calculate days since start of 30-day period
            const daysDiff = Math.floor((bundleDate.getTime() - last30DaysStart.getTime()) / (1000 * 60 * 60 * 24))

            if (daysDiff >= 0 && daysDiff < 30) {
              dailyCounts30Days[daysDiff]++
              totalCount++

              // Also track by app
              if (bundleDataByApp30Days[bundle.app_id]) {
                bundleDataByApp30Days[bundle.app_id][daysDiff]++
              }
            }
          }
        })

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
    console.error('Error calculating bundle upload stats:', error)
  }
  finally {
    await ensureMinDelay(startTime)
    isLoading.value = false
  }
}

// Watch for organization changes - use per-org cache (no need to force refetch)
watch(() => organizationStore.currentOrganization?.gid, async (newOrgId, oldOrgId) => {
  if (newOrgId && oldOrgId && newOrgId !== oldOrgId) {
    // Per-org cache will be checked in calculateStats
    await calculateStats(false)
  }
})

// Watch for billing period mode changes - reprocess cached data
watch(() => props.useBillingPeriod, async () => {
  await calculateStats(false)
})

// Watch for accumulated mode changes - reprocess cached data
watch(() => props.accumulated, async () => {
  await calculateStats(false)
})

// Watch for reload trigger - force refetch from API
watch(() => props.reloadTrigger, async (newVal, oldVal) => {
  if (newVal !== oldVal && newVal > 0) {
    await calculateStats(true)
  }
})

onMounted(async () => {
  await calculateStats(true) // Initial fetch
})
</script>

<template>
  <ChartCard
    :title="t('bundle_uploads')"
    :total="effectiveTotal"
    :last-day-evolution="effectiveLastDayEvolution"
    :is-loading="isLoading"
    :has-data="hasData"
    :is-demo-data="isDemoMode"
  >
    <BundleUploadsChart
      :key="JSON.stringify(effectiveBundleDataByApp)"
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
