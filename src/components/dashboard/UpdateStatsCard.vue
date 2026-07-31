<script setup lang="ts">
import colors from 'tailwindcss/colors'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ArrowDownOnSquareIcon from '~icons/heroicons/arrow-down-on-square'
import GlobeAltIcon from '~icons/heroicons/globe-alt'
import XCircleIcon from '~icons/heroicons/x-circle'
import UpdateStatsChart from '~/components/dashboard/UpdateStatsChart.vue'
import { calculateDemoEvolution, calculateDemoTotal, generateDemoUpdateStatsData } from '~/services/demoChartData'
import { formatNumberValue } from '~/services/formatLocale'
import { useSupabase } from '~/services/supabase'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useOrganizationStore } from '~/stores/organization'
import { createUndefinedArray, incrementArrayValue } from '~/utils/chartOptimizations'
import ChartCard from './ChartCard.vue'

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

// Removed filterToBillingPeriod - no longer needed as we work with correct date range from the start

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const effectiveOrganization = computed(() => {
  if (props.appId)
    return organizationStore.getOrgByAppId(props.appId) ?? organizationStore.currentOrganization
  return organizationStore.currentOrganization
})

const totalInstalled = ref(0)
const totalFailed = ref(0)
const totalRequested = ref(0)
const lastDayEvolution = ref(0)
const updateData = ref<(number | undefined)[]>([])
const updateDataByApp = ref<{ [appId: string]: (number | undefined)[] }>({})
const updateDataByAction = ref<{ [action: string]: (number | undefined)[] }>({})
const appNames = ref<{ [appId: string]: string }>({})
const isLoading = ref(true)

// Per-org cache for raw API data, keyed by "orgId:billingMode"
// Using shallowRef for Vue reactivity - cache invalidates properly on org changes
const cacheByOrgAndMode = shallowRef(new Map<string, any[]>())
// Track current org for change detection
const currentCacheOrgId = ref<string | null>(null)

const dashboardAppsStore = useDashboardAppsStore()

// Convert undefined values to 0 for chart consumption
function capitalize(text: string) {
  if (!text)
    return ''
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const chartUpdateData = computed(() => updateData.value.map(v => v ?? 0))
const chartUpdateDataByAction = computed(() => {
  const result: { [action: string]: number[] } = {}
  Object.keys(updateDataByAction.value).forEach((action) => {
    result[action] = updateDataByAction.value[action].map(v => v ?? 0)
  })
  return result
})
const actionDisplayNames = computed(() => ({
  requested: capitalize(t('get')),
  install: capitalize(t('installed')),
  fail: capitalize(t('failed')),
}))

// Generate demo data when forceDemo is true
const demoStats = computed(() => generateDemoUpdateStatsData(30))

// Demo mode: show demo data only when forceDemo is true OR user has no apps
// If user has apps, ALWAYS show real data (even if empty)
const isDemoMode = computed(() => {
  if (props.forceDemo)
    return true
  // If user has apps, never show demo data
  if (dashboardAppsStore.apps.length > 0)
    return false
  // No apps and store is loaded = show demo
  return dashboardAppsStore.isLoaded
})

// Effective values for display
const effectiveChartData = computed(() => isDemoMode.value ? demoStats.value.total : chartUpdateData.value)
const effectiveChartDataByAction = computed(() => {
  if (isDemoMode.value) {
    return {
      requested: demoStats.value.byAction.requested,
      install: demoStats.value.byAction.install,
      fail: demoStats.value.byAction.fail,
    }
  }
  return chartUpdateDataByAction.value
})
const effectiveTotalInstalled = computed(() => isDemoMode.value ? calculateDemoTotal(demoStats.value.byAction.install) : totalInstalled.value)
const effectiveTotalFailed = computed(() => isDemoMode.value ? calculateDemoTotal(demoStats.value.byAction.fail) : totalFailed.value)
const effectiveTotalRequested = computed(() => isDemoMode.value ? calculateDemoTotal(demoStats.value.byAction.requested) : totalRequested.value)
const effectiveTotalUpdates = computed(() => effectiveTotalInstalled.value + effectiveTotalFailed.value + effectiveTotalRequested.value)
const effectiveLastDayEvolution = computed(() => isDemoMode.value ? calculateDemoEvolution(demoStats.value.total) : lastDayEvolution.value)

const hasData = computed(() => effectiveTotalUpdates.value > 0 || isDemoMode.value)

const PAGE_SIZE = 1000

async function fetchDailyVersionStats(targetAppIds: string[], startDate: string, endDate: string) {
  const supabase = useSupabase()
  const allRows: any[] = []
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('daily_version')
      .select('date, app_id, install, fail, get')
      .in('app_id', targetAppIds)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error)
      throw error

    if (data && data.length > 0)
      allRows.push(...data)

    if (!data || data.length < PAGE_SIZE)
      break

    offset += PAGE_SIZE
  }

  return allRows
}

async function calculateStats(forceRefetch = false) {
  const startTime = Date.now()
  isLoading.value = true

  // Reset display data
  totalInstalled.value = 0
  totalFailed.value = 0
  totalRequested.value = 0
  lastDayEvolution.value = 0
  updateDataByApp.value = {}
  updateDataByAction.value = {}
  updateData.value = []

  const currentOrgId = effectiveOrganization.value?.gid ?? null
  const orgChanged = currentCacheOrgId.value !== currentOrgId
  currentCacheOrgId.value = currentOrgId

  const DAY_IN_MS = 1000 * 60 * 60 * 24

  // Always work with full billing period when enabled, otherwise last 30 days
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const last30DaysStart = new Date(today)
  last30DaysStart.setDate(last30DaysStart.getDate() - 29)

  const billingStart = new Date(effectiveOrganization.value?.subscription_start ?? today)
  billingStart.setHours(0, 0, 0, 0)
  const safeBillingStart = billingStart > today ? today : billingStart

  const rangeStart = props.useBillingPeriod ? safeBillingStart : last30DaysStart
  const dayCount = props.useBillingPeriod
    ? Math.max(0, Math.floor((today.getTime() - rangeStart.getTime()) / DAY_IN_MS) + 1)
    : 30

  const startDate = rangeStart.toISOString().split('T')[0]
  const endDate = today.toISOString().split('T')[0]

  // Cache key includes org, app, and range to avoid stale data between periods
  const cacheKey = `${currentOrgId ?? 'none'}:${props.appId || 'org'}:${startDate}:${endDate}`

  try {
    // Determine target apps
    const localAppNames: { [appId: string]: string } = {}
    let targetAppIds: string[] = []

    if (props.appId) {
      // Single app mode
      targetAppIds = [props.appId]
      try {
        const { data: appRow } = await useSupabase()
          .from('apps')
          .select('name')
          .eq('app_id', props.appId)
          .single()
        localAppNames[props.appId] = appRow?.name ?? props.appId
      }
      catch (error) {
        console.error('Error fetching app name for update stats:', error)
        localAppNames[props.appId] = props.appId
      }
      appNames.value = localAppNames
    }
    else {
      // Multiple apps mode - use store for shared apps data
      await dashboardAppsStore.fetchApps(orgChanged)

      targetAppIds = [...dashboardAppsStore.appIds]
      appNames.value = dashboardAppsStore.appNames
    }

    if (targetAppIds.length === 0) {
      updateData.value = createUndefinedArray(dayCount) as (number | undefined)[]
      updateDataByApp.value = {}
      return
    }

    // Check per-org cache - only use if not forcing refetch
    let data: any[] | null = null
    const cachedData = cacheByOrgAndMode.value.get(cacheKey)

    if (cachedData && !forceRefetch) {
      data = cachedData
    }
    else {
      // Get update stats from daily_version table (paginate to avoid PostgREST 1000-row limit)
      data = await fetchDailyVersionStats(targetAppIds, startDate, endDate)

      // Store in per-org cache (immutable update for reactivity)
      if (data) {
        cacheByOrgAndMode.value = new Map([...cacheByOrgAndMode.value, [cacheKey, data]])
      }
    }

    // Create fresh arrays for processing
    const dailyCounts = createUndefinedArray(dayCount) as (number | undefined)[]
    const actionData = {
      install: createUndefinedArray(dayCount) as (number | undefined)[],
      fail: createUndefinedArray(dayCount) as (number | undefined)[],
      requested: createUndefinedArray(dayCount) as (number | undefined)[],
    }
    const appData: { [appId: string]: (number | undefined)[] } = {}
    targetAppIds.forEach((appId) => {
      appData[appId] = createUndefinedArray(dayCount) as (number | undefined)[]
    })

    // Track totals separately
    let installedTotal = 0
    let failedTotal = 0
    let requestedTotal = 0

    if (data && data.length > 0) {
      // Process each stat entry
      data.forEach((stat: any) => {
        if (stat.date) {
          const statDate = new Date(stat.date)
          statDate.setHours(0, 0, 0, 0)

          // Calculate days since start of range
          const daysDiff = Math.floor((statDate.getTime() - rangeStart.getTime()) / DAY_IN_MS)

          if (daysDiff >= 0 && daysDiff < dayCount) {
            const installedCount = stat.install || 0
            const failedCount = stat.fail || 0
            const requestedCount = stat.get || 0
            const totalForDay = installedCount + failedCount + requestedCount

            // Increment arrays
            incrementArrayValue(dailyCounts, daysDiff, totalForDay)

            // Track by action type
            incrementArrayValue(actionData.install, daysDiff, installedCount)
            incrementArrayValue(actionData.fail, daysDiff, failedCount)
            incrementArrayValue(actionData.requested, daysDiff, requestedCount)

            // Track by app
            if (appData[stat.app_id]) {
              incrementArrayValue(appData[stat.app_id], daysDiff, totalForDay)
            }
          }
        }
      })
    }

    const finalDailyCounts = dailyCounts
    const finalActionData = actionData
    const finalAppData = appData

    const sumSeries = (series: (number | undefined)[]) =>
      series.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    installedTotal = sumSeries(finalActionData.install)
    failedTotal = sumSeries(finalActionData.fail)
    requestedTotal = sumSeries(finalActionData.requested)

    const nonZeroDays = finalDailyCounts.filter(count => (count || 0) > 0)
    if (nonZeroDays.length >= 2) {
      const lastDayCount = nonZeroDays[nonZeroDays.length - 1] || 0
      const previousDayCount = nonZeroDays[nonZeroDays.length - 2] || 0
      if (previousDayCount > 0) {
        lastDayEvolution.value = ((lastDayCount - previousDayCount) / previousDayCount) * 100
      }
    }

    // Set all display values at once
    updateData.value = finalDailyCounts
    updateDataByAction.value = finalActionData
    updateDataByApp.value = finalAppData
    totalInstalled.value = installedTotal
    totalFailed.value = failedTotal
    totalRequested.value = requestedTotal
  }
  catch (error) {
    console.error('Error fetching update stats:', error)
    updateData.value = createUndefinedArray(dayCount) as (number | undefined)[]
  }
  finally {
    // Ensure spinner shows for at least 300ms for better UX
    const elapsed = Date.now() - startTime
    if (elapsed < 300) {
      await new Promise(resolve => setTimeout(resolve, 300 - elapsed))
    }
    isLoading.value = false
  }
}

// Watch for organization changes - use per-org cache (no need to force refetch)
watch(() => effectiveOrganization.value?.gid, async (newOrgId, oldOrgId) => {
  if (newOrgId && oldOrgId !== undefined && newOrgId !== oldOrgId) {
    // Per-org cache will be checked in calculateStats
    await calculateStats(true)
  }
})

watch(() => props.appId, async (newAppId, oldAppId) => {
  if (newAppId !== oldAppId) {
    await calculateStats(true)
  }
})

// Watch for billing period mode changes - cache is keyed by mode, so no force needed
watch(() => props.useBillingPeriod, async () => {
  await calculateStats(false)
})

// Watch for accumulated mode changes - reprocess cached data
watch(() => props.accumulated, async () => {
  await calculateStats(false)
})

// Watch for reload trigger - force refetch from API
watch(() => props.reloadTrigger, async (newVal) => {
  if (newVal > 0) {
    await calculateStats(true)
  }
})

onMounted(async () => {
  await calculateStats(true) // Initial fetch
})
</script>

<template>
  <ChartCard
    :title="t('update_statistics')"
    :total="effectiveTotalUpdates"
    :last-day-evolution="effectiveLastDayEvolution"
    :is-loading="isLoading"
    :has-data="hasData"
    :is-demo-data="isDemoMode"
  >
    <template #header>
      <div class="flex flex-col gap-2 justify-between items-start">
        <h2 class="flex-1 min-w-0 text-2xl font-semibold leading-tight dark:text-white text text-slate-600">
          {{ t('update_statistics') }}
        </h2>
        <div class="flex flex-wrap gap-2 items-center text-xs sm:gap-3 sm:text-sm">
          <div class="flex gap-2 items-center">
            <div class="w-3 h-3 rounded-full" style="background-color: hsl(210, 65%, 55%)" />
            <div
              class="flex gap-1 items-center min-w-0 text-xs text-slate-600 dark:text-slate-300 sm:text-sm"
              :aria-label="`${actionDisplayNames.requested}: ${formatNumberValue(effectiveTotalRequested)}`"
            >
              <GlobeAltIcon class="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
              <span>{{ formatNumberValue(effectiveTotalRequested) }}</span>
            </div>
          </div>
          <div class="flex gap-2 items-center">
            <div class="w-3 h-3 rounded-full" style="background-color: hsl(135, 55%, 50%)" />
            <div
              class="flex gap-1 items-center min-w-0 text-xs text-slate-600 dark:text-slate-300 sm:text-sm"
              :aria-label="`${actionDisplayNames.install}: ${formatNumberValue(effectiveTotalInstalled)}`"
            >
              <ArrowDownOnSquareIcon class="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
              <span>{{ formatNumberValue(effectiveTotalInstalled) }}</span>
            </div>
          </div>
          <div class="flex gap-2 items-center">
            <div class="w-3 h-3 rounded-full" style="background-color: hsl(0, 50%, 60%)" />
            <div
              class="flex gap-1 items-center min-w-0 text-xs text-slate-600 dark:text-slate-300 sm:text-sm"
              :aria-label="`${actionDisplayNames.fail}: ${formatNumberValue(effectiveTotalFailed)}`"
            >
              <XCircleIcon class="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
              <span>{{ formatNumberValue(effectiveTotalFailed) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <UpdateStatsChart
      :key="JSON.stringify(effectiveChartDataByAction)"
      :title="t('update_statistics')"
      :colors="colors.blue"
      :data="effectiveChartData"
      :use-billing-period="useBillingPeriod"
      :accumulated="accumulated"
      :data-by-app="effectiveChartDataByAction"
      :app-names="actionDisplayNames"
      :app-id="appId"
    />
  </ChartCard>
</template>
