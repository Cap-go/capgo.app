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
  generateDemoDeploymentData,
  getDemoDayCount,
} from '~/services/demoChartData'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useOrganizationStore } from '~/stores/organization'
import { filterDailySeriesToBillingPeriod, resolveDashboardDailySeriesWindow } from '~/utils/chartOptimizations'
import { shouldShowDashboardDemoData } from '~/utils/dashboardDemoMode'
import ChartCard from './ChartCard.vue'
import DeploymentStatsChart from './DeploymentStatsChart.vue'

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
const dashboardAppsStore = useDashboardAppsStore()
const capgo = useConsole()

const totalDeployments = ref(0)
const lastDayEvolution = ref(0)
const deploymentData = ref<number[]>([])
// For single app view: breakdown by channel
const deploymentDataByChannel = ref<{ [channelId: string]: number[] }>({})
const channelNames = ref<{ [channelId: string]: string }>({})
const channelAppIds = ref<{ [channelId: string]: string }>({})
// For dashboard view: breakdown by app
const deploymentDataByApp = ref<{ [appId: string]: number[] }>({})
const appNames = ref<{ [appId: string]: string }>({})
const dataScope = computed(() => `${organizationStore.currentOrganization?.gid}:${props.appId}:${props.useBillingPeriod}:${props.forceDemo}`)
const loading = useDashboardRequestState(dataScope)
const { isLoading, isRefreshing, error: loadError } = loading

// Generate consistent demo data where total is derived from per-app breakdown
const consistentDemoData = computed(() => {
  const days = getDemoDayCount(props.useBillingPeriod, deploymentData.value.length)
  return generateConsistentDemoData(days, generateDemoDeploymentData)
})

const demoDeploymentData = computed(() => consistentDemoData.value.total)
const demoDataByApp = computed(() => consistentDemoData.value.byApp)

const isDemoMode = computed(() => shouldShowDashboardDemoData({
  forceDemo: props.forceDemo,
  appId: props.appId,
  appsCount: dashboardAppsStore.apps.length,
  appsLoaded: dashboardAppsStore.isLoaded,
}))

// Effective values for display
const effectiveDeploymentData = computed(() => isDemoMode.value ? demoDeploymentData.value : deploymentData.value)
const effectiveDeploymentDataByApp = computed(() => isDemoMode.value ? demoDataByApp.value : deploymentDataByApp.value)
const effectiveAppNames = computed(() => isDemoMode.value ? DEMO_APP_NAMES : appNames.value)
const effectiveTotalDeployments = computed(() => isDemoMode.value ? calculateDemoTotal(demoDeploymentData.value) : totalDeployments.value)
const effectiveLastDayEvolution = computed(() => isDemoMode.value ? calculateDemoEvolution(demoDeploymentData.value) : lastDayEvolution.value)

const hasData = computed(() => effectiveTotalDeployments.value > 0 || isDemoMode.value)

// Determine if we're in single app mode (show channels) or multi-app mode (show apps)
const isSingleAppMode = computed(() => !!props.appId)

// Per-org cache for raw API data: Map<orgId, {data, channelNames, channelAppIds}>
type DeployDailyCount = Database['public']['Functions']['get_deploy_daily_counts']['Returns'][number]

const cacheByOrg = new Map<string, { data: DeployDailyCount[], channelNames: { [channelId: string]: string }, channelAppIds: { [channelId: string]: string } }>()

async function calculateStats(forceRefetch = false) {
  const request = loading.start()
  if (request.isInitial) {
    totalDeployments.value = 0
    lastDayEvolution.value = 0
    deploymentDataByChannel.value = {}
    channelNames.value = {}
    channelAppIds.value = {}
    deploymentDataByApp.value = {}
    appNames.value = {}
    deploymentData.value = []
  }

  const fallbackData = Array.from({ length: 30 }).fill(0) as number[]

  const currentOrgId = organizationStore.currentOrganization?.gid ?? null

  try {
    if (props.forceDemo)
      return
    await organizationStore.dedupFetchOrganizations()
    if (props.appId)
      await organizationStore.awaitInitialLoad()
    if (!request.isCurrent())
      return

    const targetOrganization = props.appId
      ? organizationStore.getOrgByAppId(props.appId) ?? organizationStore.currentOrganization
      : organizationStore.currentOrganization

    if (!targetOrganization) {
      if (request.isCurrent())
        deploymentData.value = fallbackData
      return
    }

    // Get billing period dates for filtering
    const billingStart = normalizeToUtcStartOfDay(new Date(targetOrganization.subscription_start ?? new Date()))
    const { seriesStart: last30DaysStart, exclusiveEnd, dayCount } = resolveDashboardDailySeriesWindow(
      props.useBillingPeriod,
      billingStart,
    )
    const cacheKey = `${currentOrgId}:${props.appId}:${last30DaysStart.toISOString()}:${exclusiveEnd.toISOString()}`

    let targetAppIds: string[] = []

    if (props.appId) {
      targetAppIds = [props.appId]
    }
    else {
      await dashboardAppsStore.fetchApps()
      if (!request.isCurrent())
        return
      if (!dashboardAppsStore.isLoaded)
        throw new Error('App catalog unavailable')
      targetAppIds = [...dashboardAppsStore.appIds]
    }

    if (targetAppIds.length === 0) {
      if (request.isCurrent()) {
        totalDeployments.value = 0
        lastDayEvolution.value = 0
        deploymentData.value = fallbackData
        deploymentDataByChannel.value = {}
        channelNames.value = {}
        channelAppIds.value = {}
        deploymentDataByApp.value = {}
        appNames.value = {}
      }
      return
    }

    const dailyCounts30Days = Array.from({ length: dayCount }).fill(0) as number[]
    let totalDeploymentsCount = 0

    // Check per-org cache - only use if not forcing refetch
    let data: DeployDailyCount[] | null = null
    let localChannelNames: { [channelId: string]: string } = {}
    let localChannelAppIds: { [channelId: string]: string } = {}
    const cachedData = cacheByOrg.get(cacheKey)

    if (cachedData && !forceRefetch) {
      data = cachedData.data
      localChannelNames = cachedData.channelNames
      localChannelAppIds = cachedData.channelAppIds
    }
    else {
      // Per-day deploy counts per channel, aggregated in the database instead of
      // downloading every deployment of the window.
      const result = await readAllConsoleRows<DeployDailyCount>((from, to) => {
        if (!request.isCurrent())
          return Promise.resolve({ data: [], error: null })
        return capgo
          .rpc('get_deploy_daily_counts', {
            p_app_ids: targetAppIds,
            p_start: last30DaysStart.toISOString(),
            p_end: exclusiveEnd.toISOString(),
          })
          .range(from, to)
      })

      if (!request.isCurrent())
        return

      if (result.error)
        throw result.error

      data = result.data

      // Extract channel names and app IDs from the data
      if (data) {
        for (const row of data) {
          if (row.channel_id && row.channel_name) {
            localChannelNames[row.channel_id] = row.channel_name
            localChannelAppIds[row.channel_id] = row.app_id
          }
        }
      }

      // Store in per-org cache
      if (data && currentOrgId) {
        cacheByOrg.set(cacheKey, { data, channelNames: localChannelNames, channelAppIds: localChannelAppIds })
      }
    }

    // Create fresh arrays for processing per channel
    const perChannel: { [channelId: string]: number[] } = {}
    Object.keys(localChannelNames).forEach((channelId) => {
      perChannel[channelId] = Array.from({ length: dayCount }).fill(0) as number[]
    })

    // Create fresh arrays for processing per app (multi-app mode)
    const perApp: { [appId: string]: number[] } = {}
    const localAppNames: { [appId: string]: string } = {}

    for (const row of data ?? []) {
      if (!row.channel_id || row.day_index < 0 || row.day_index >= dayCount)
        continue
      const deploys = Number(row.deploys)

      dailyCounts30Days[row.day_index] += deploys
      totalDeploymentsCount += deploys

      // Initialize channel array if not already (for channels discovered during iteration)
      if (!perChannel[row.channel_id])
        perChannel[row.channel_id] = Array.from({ length: dayCount }).fill(0) as number[]
      perChannel[row.channel_id][row.day_index] += deploys

      // For multi-app mode: aggregate by app_id
      if (!isSingleAppMode.value && row.app_id) {
        if (!perApp[row.app_id]) {
          perApp[row.app_id] = Array.from({ length: dayCount }).fill(0) as number[]
          // Get app name from dashboardAppsStore
          localAppNames[row.app_id] = dashboardAppsStore.appNames[row.app_id] || row.app_id
        }
        perApp[row.app_id][row.day_index] += deploys
      }
    }

    let finalDeploymentData = dailyCounts30Days
    let finalPerChannel = perChannel
    let finalPerApp = perApp
    let finalTotal = totalDeploymentsCount

    if (props.useBillingPeriod) {
      const filteredData = filterDailySeriesToBillingPeriod(dailyCounts30Days, last30DaysStart, billingStart)
      finalDeploymentData = filteredData.data

      const filteredPerChannel: { [channelId: string]: number[] } = {}
      Object.keys(perChannel).forEach((channelId) => {
        const filteredChannelData = filterDailySeriesToBillingPeriod(perChannel[channelId], last30DaysStart, billingStart)
        filteredPerChannel[channelId] = filteredChannelData.data
      })
      finalPerChannel = filteredPerChannel

      const filteredPerApp: { [appId: string]: number[] } = {}
      Object.keys(perApp).forEach((appId) => {
        const filteredAppData = filterDailySeriesToBillingPeriod(perApp[appId], last30DaysStart, billingStart)
        filteredPerApp[appId] = filteredAppData.data
      })
      finalPerApp = filteredPerApp

      finalTotal = finalDeploymentData.reduce((sum, count) => sum + count, 0)
    }

    const evolution = computeLastDayEvolution(finalDeploymentData)

    if (!request.isCurrent())
      return

    deploymentData.value = finalDeploymentData
    deploymentDataByChannel.value = finalPerChannel
    channelNames.value = { ...localChannelNames }
    channelAppIds.value = { ...localChannelAppIds }
    deploymentDataByApp.value = finalPerApp
    appNames.value = { ...localAppNames }
    totalDeployments.value = finalTotal
    lastDayEvolution.value = evolution
  }
  catch (error) {
    if (request.isCurrent()) {
      request.fail()
      console.error('Error fetching deployment stats:', error)
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
    :title="t('deployment_statistics')"
    :total="effectiveTotalDeployments"
    :last-day-evolution="effectiveLastDayEvolution"
    :is-loading="isLoading"
    :is-refreshing="isRefreshing"
    :error-message="loadError ? t('error-loading-data') : undefined"
    :has-data="hasData"
    :is-demo-data="isDemoMode"
  >
    <DeploymentStatsChart
      :title="t('deployment_statistics')"
      :colors="colors.blue"
      :data="effectiveDeploymentData"
      :use-billing-period="useBillingPeriod"
      :accumulated="accumulated"
      :data-by-channel="isSingleAppMode && !isDemoMode ? deploymentDataByChannel : {}"
      :channel-names="isSingleAppMode && !isDemoMode ? channelNames : {}"
      :channel-app-ids="isSingleAppMode && !isDemoMode ? channelAppIds : {}"
      :data-by-app="!isSingleAppMode || isDemoMode ? effectiveDeploymentDataByApp : {}"
      :app-names="!isSingleAppMode || isDemoMode ? effectiveAppNames : {}"
    />
  </ChartCard>
</template>
