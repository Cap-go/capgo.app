<script setup lang="ts">
import type { Database } from '~/types/database.types'
import colors from 'tailwindcss/colors'
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ArrowDownOnSquareIcon from '~icons/heroicons/arrow-down-on-square'
import GlobeAltIcon from '~icons/heroicons/globe-alt'
import XCircleIcon from '~icons/heroicons/x-circle'
import UpdateStatsChart from '~/components/dashboard/UpdateStatsChart.vue'
import { useDashboardRequestState } from '~/composables/useDashboardRequestState'
import { useConsole } from '~/services/console'
import { readAllConsoleRows } from '~/services/consoleRows'
import { addUtcDays, formatUtcDateParam, normalizeToUtcStartOfDay } from '~/services/date'
import { calculateDemoEvolution, calculateDemoTotal, generateDemoUpdateStatsData } from '~/services/demoChartData'
import { formatNumberValue } from '~/services/formatLocale'
import { splitUpdateStatsWindow, toDailyVersionStat } from '~/services/updateStats'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useOrganizationStore } from '~/stores/organization'
import { createUndefinedArray, incrementArrayValue } from '~/utils/chartOptimizations'
import { shouldShowDashboardDemoData } from '~/utils/dashboardDemoMode'
import ChartCard from './ChartCard.vue'
import { useChartCardCompact } from './chartCardDensity'

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
const compact = useChartCardCompact()
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
const dataScope = computed(() => `${effectiveOrganization.value?.gid}:${props.appId}:${props.useBillingPeriod}:${props.forceDemo}`)
const loading = useDashboardRequestState(dataScope)
const { isLoading, isRefreshing, error: loadError } = loading

type UpdateDailyCount = Database['public']['Functions']['get_update_daily_counts']['Returns'][number]

// Per-org cache for raw API data, keyed by "orgId:billingMode"
// Using shallowRef for Vue reactivity - cache invalidates properly on org changes
const cacheByOrgAndMode = shallowRef(new Map<string, any[]>())

const dashboardAppsStore = useDashboardAppsStore()
const singleAppNameCache = new Map<string, string>()

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

const isDemoMode = computed(() => shouldShowDashboardDemoData({
  forceDemo: props.forceDemo,
  appId: props.appId,
  appsCount: dashboardAppsStore.apps.length,
  appsLoaded: dashboardAppsStore.isLoaded,
}))

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

// Per app and day sums, aggregated in the database instead of downloading
// every daily_version row of the window (one per app, bundle and day).
async function fetchDailyVersionStats(targetAppIds: string[], startDate: string, endDate: string, isCurrent: () => boolean) {
  const capgo = useConsole()
  const windows = splitUpdateStatsWindow(startDate, endDate)
  const results = await Promise.all(windows.map(window => readAllConsoleRows<UpdateDailyCount>((from, to) => {
    if (!isCurrent())
      return Promise.resolve({ data: [], error: null })
    return capgo
      .rpc('get_update_daily_counts', {
        p_app_ids: targetAppIds,
        p_start: window.start,
        p_end: window.end,
      })
      .range(from, to)
  })))

  if (!isCurrent())
    return []
  const failed = results.find(result => result.error)
  if (failed)
    throw failed.error

  return results.flatMap(result => (result.data ?? []).map(toDailyVersionStat))
}

async function calculateStats(forceRefetch = false) {
  const request = loading.start()
  if (request.isInitial) {
    totalInstalled.value = 0
    totalFailed.value = 0
    totalRequested.value = 0
    lastDayEvolution.value = 0
    updateDataByApp.value = {}
    updateDataByAction.value = {}
    updateData.value = []
  }

  const currentOrgId = effectiveOrganization.value?.gid ?? null

  const DAY_IN_MS = 1000 * 60 * 60 * 24

  // Always work with full billing period when enabled, otherwise last 30 UTC days
  const today = normalizeToUtcStartOfDay()

  const last30DaysStart = addUtcDays(today, -29)

  const billingStart = normalizeToUtcStartOfDay(new Date(effectiveOrganization.value?.subscription_start ?? today))
  const safeBillingStart = billingStart > today ? today : billingStart

  const rangeStart = props.useBillingPeriod ? safeBillingStart : last30DaysStart
  const dayCount = props.useBillingPeriod
    ? Math.max(0, Math.floor((today.getTime() - rangeStart.getTime()) / DAY_IN_MS) + 1)
    : 30

  const startDate = formatUtcDateParam(rangeStart)
  const endDate = formatUtcDateParam(today)

  // Cache key includes org, app, and range to avoid stale data between periods
  const cacheKey = `${currentOrgId ?? 'none'}:${props.appId || 'org'}:${startDate}:${endDate}`

  try {
    if (props.forceDemo)
      return
    // Determine target apps
    const localAppNames: { [appId: string]: string } = {}
    let targetAppIds: string[] = []

    if (props.appId) {
      // Single app mode
      targetAppIds = [props.appId]
      // The name only labels the series: resolve it once per app, not per load.
      let cachedName = singleAppNameCache.get(props.appId) ?? dashboardAppsStore.appNames[props.appId] ?? ''
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
          console.error('Error fetching app name for update stats:', error)
          cachedName = props.appId
        }
        singleAppNameCache.set(props.appId, cachedName)
      }
      localAppNames[props.appId] = cachedName || props.appId
      if (!request.isCurrent())
        return
      appNames.value = localAppNames
    }
    else {
      // Multiple apps mode - use store for shared apps data
      await dashboardAppsStore.fetchApps()
      if (!request.isCurrent())
        return
      if (!dashboardAppsStore.isLoaded)
        throw new Error('App catalog unavailable')

      targetAppIds = [...dashboardAppsStore.appIds]
      appNames.value = dashboardAppsStore.appNames
    }

    if (targetAppIds.length === 0) {
      totalInstalled.value = 0
      totalFailed.value = 0
      totalRequested.value = 0
      lastDayEvolution.value = 0
      updateData.value = createUndefinedArray(dayCount) as (number | undefined)[]
      updateDataByApp.value = {}
      updateDataByAction.value = {}
      return
    }

    // Check per-org cache - only use if not forcing refetch
    let data: any[] | null = null
    const cachedData = cacheByOrgAndMode.value.get(cacheKey)

    if (cachedData && !forceRefetch) {
      data = cachedData
    }
    else {
      // Per app and day update sums from daily_version, aggregated in the database
      data = await fetchDailyVersionStats(targetAppIds, startDate, endDate, request.isCurrent)
      if (!request.isCurrent())
        return

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
          const statDate = normalizeToUtcStartOfDay(new Date(stat.date))

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
    lastDayEvolution.value = 0
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
    if (request.isCurrent()) {
      request.fail()
      console.error('Error fetching update stats:', error)
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
    :title="t('update_statistics')"
    :total="effectiveTotalUpdates"
    :last-day-evolution="effectiveLastDayEvolution"
    :is-loading="isLoading"
    :is-refreshing="isRefreshing"
    :error-message="loadError ? t('error-loading-data') : undefined"
    :has-data="hasData"
    :is-demo-data="isDemoMode"
  >
    <template #header>
      <div class="flex flex-col gap-2 justify-between items-start">
        <h2 class="flex-1 min-w-0 font-semibold leading-tight dark:text-white text text-slate-600" :class="compact ? 'text-base' : 'text-2xl'">
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
