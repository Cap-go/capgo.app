<script setup lang="ts">
import colors from 'tailwindcss/colors'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { computeLastDayEvolution } from '~/services/buildCharts'
import { addUtcDays, formatUtcDateParam, normalizeToUtcStartOfDay } from '~/services/date'
import {
  calculateDemoEvolution,
  calculateDemoTotal,
  DEMO_APP_NAMES,
  generateConsistentDemoData,
  generateDemoDeploymentData,
  getDemoDayCount,
} from '~/services/demoChartData'
import { useSupabase } from '~/services/supabase'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useOrganizationStore } from '~/stores/organization'
import { filterDailySeriesToBillingPeriod } from '~/utils/chartOptimizations'
import { ensureMinDelay } from '~/utils/minDelay'
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
const supabase = useSupabase()
let latestRequestToken = 0

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
const isLoading = ref(true)

// Generate consistent demo data where total is derived from per-app breakdown
const consistentDemoData = computed(() => {
  const days = getDemoDayCount(props.useBillingPeriod, deploymentData.value.length)
  return generateConsistentDemoData(days, generateDemoDeploymentData)
})

const demoDeploymentData = computed(() => consistentDemoData.value.total)
const demoDataByApp = computed(() => consistentDemoData.value.byApp)

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
const effectiveDeploymentData = computed(() => isDemoMode.value ? demoDeploymentData.value : deploymentData.value)
const effectiveDeploymentDataByApp = computed(() => isDemoMode.value ? demoDataByApp.value : deploymentDataByApp.value)
const effectiveAppNames = computed(() => isDemoMode.value ? DEMO_APP_NAMES : appNames.value)
const effectiveTotalDeployments = computed(() => isDemoMode.value ? calculateDemoTotal(demoDeploymentData.value) : totalDeployments.value)
const effectiveLastDayEvolution = computed(() => isDemoMode.value ? calculateDemoEvolution(demoDeploymentData.value) : lastDayEvolution.value)

const hasData = computed(() => effectiveTotalDeployments.value > 0 || isDemoMode.value)

// Determine if we're in single app mode (show channels) or multi-app mode (show apps)
const isSingleAppMode = computed(() => !!props.appId)

// Per-org cache for raw API data: Map<orgId, {data, channelNames, channelAppIds}>
const cacheByOrg = new Map<string, { data: any[], channelNames: { [channelId: string]: string }, channelAppIds: { [channelId: string]: string } }>()
// Track current org for change detection
const currentCacheOrgId = ref<string | null>(null)

async function calculateStats(forceRefetch = false) {
  const startTime = Date.now()
  const requestToken = ++latestRequestToken

  isLoading.value = true

  // Reset display data
  totalDeployments.value = 0
  lastDayEvolution.value = 0
  deploymentDataByChannel.value = {}
  channelNames.value = {}
  channelAppIds.value = {}
  deploymentDataByApp.value = {}
  appNames.value = {}
  deploymentData.value = []

  const fallbackData = Array.from({ length: 30 }).fill(0) as number[]

  const currentOrgId = organizationStore.currentOrganization?.gid ?? null
  const orgChanged = currentCacheOrgId.value !== currentOrgId
  currentCacheOrgId.value = currentOrgId

  try {
    await organizationStore.dedupFetchOrganizations()
    await organizationStore.awaitInitialLoad()

    const targetOrganization = props.appId
      ? organizationStore.getOrgByAppId(props.appId) ?? organizationStore.currentOrganization
      : organizationStore.currentOrganization

    if (!targetOrganization) {
      if (requestToken === latestRequestToken)
        deploymentData.value = fallbackData
      return
    }

    // Always work with last 30 UTC days of data
    const last30DaysEnd = new Date()
    const last30DaysStart = addUtcDays(normalizeToUtcStartOfDay(), -29)

    // Get billing period dates for filtering
    const billingStart = normalizeToUtcStartOfDay(new Date(targetOrganization.subscription_start ?? new Date()))

    const startDate = formatUtcDateParam(last30DaysStart)
    const endDate = formatUtcDateParam(last30DaysEnd)

    let targetAppIds: string[] = []

    if (props.appId) {
      targetAppIds = [props.appId]
    }
    else {
      // Fetch apps if not loaded OR if org changed (to get fresh app list)
      await dashboardAppsStore.fetchApps(orgChanged)
      targetAppIds = [...dashboardAppsStore.appIds]
    }

    if (targetAppIds.length === 0) {
      if (requestToken === latestRequestToken) {
        deploymentData.value = fallbackData
        deploymentDataByChannel.value = {}
        channelNames.value = {}
        channelAppIds.value = {}
        deploymentDataByApp.value = {}
        appNames.value = {}
      }
      return
    }

    const dailyCounts30Days = Array.from({ length: 30 }).fill(0) as number[]
    let totalDeploymentsCount = 0

    // Check per-org cache - only use if not forcing refetch
    let data: any[] | null = null
    let localChannelNames: { [channelId: string]: string } = {}
    let localChannelAppIds: { [channelId: string]: string } = {}
    const cachedData = currentOrgId ? cacheByOrg.get(currentOrgId) : null

    if (cachedData && !forceRefetch) {
      data = cachedData.data
      localChannelNames = cachedData.channelNames
      localChannelAppIds = cachedData.channelAppIds
    }
    else {
      // Fetch deployment history with channel info for all channels
      const result = await supabase
        .from('deploy_history')
        .select(`
          deployed_at,
          app_id,
          channel_id,
          channels(
            id,
            name
          )
        `)
        .in('app_id', targetAppIds)
        .gte('deployed_at', startDate)
        .lte('deployed_at', endDate)
        .order('deployed_at')

      if (result.error)
        throw result.error

      data = result.data

      // Extract channel names and app IDs from the data
      if (data) {
        data.forEach((deployment: any) => {
          if (deployment.channel_id && deployment.channels?.name) {
            localChannelNames[deployment.channel_id] = deployment.channels.name
            localChannelAppIds[deployment.channel_id] = deployment.app_id
          }
        })
      }

      // Store in per-org cache
      if (data && currentOrgId) {
        cacheByOrg.set(currentOrgId, { data, channelNames: localChannelNames, channelAppIds: localChannelAppIds })
      }
    }

    // Create fresh arrays for processing per channel
    const perChannel: { [channelId: string]: number[] } = {}
    Object.keys(localChannelNames).forEach((channelId) => {
      perChannel[channelId] = Array.from({ length: 30 }).fill(0) as number[]
    })

    // Create fresh arrays for processing per app (multi-app mode)
    const perApp: { [appId: string]: number[] } = {}
    const localAppNames: { [appId: string]: string } = {}

    if (data && data.length > 0) {
      data.forEach((deployment: any) => {
        if (!deployment.deployed_at || !deployment.channel_id)
          return

        const deployDate = new Date(deployment.deployed_at)

        // Calculate days since start of 30-day period
        const daysDiff = Math.floor((deployDate.getTime() - last30DaysStart.getTime()) / (1000 * 60 * 60 * 24))

        if (daysDiff < 0 || daysDiff >= 30)
          return

        dailyCounts30Days[daysDiff] += 1
        totalDeploymentsCount += 1

        // Initialize channel array if not already (for channels discovered during iteration)
        if (!perChannel[deployment.channel_id]) {
          perChannel[deployment.channel_id] = Array.from({ length: 30 }).fill(0) as number[]
        }
        perChannel[deployment.channel_id][daysDiff] += 1

        // For multi-app mode: aggregate by app_id
        if (!isSingleAppMode.value && deployment.app_id) {
          if (!perApp[deployment.app_id]) {
            perApp[deployment.app_id] = Array.from({ length: 30 }).fill(0) as number[]
            // Get app name from dashboardAppsStore
            localAppNames[deployment.app_id] = dashboardAppsStore.appNames[deployment.app_id] || deployment.app_id
          }
          perApp[deployment.app_id][daysDiff] += 1
        }
      })
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

    if (requestToken !== latestRequestToken)
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
    console.error('Error fetching deployment stats:', error)
    if (requestToken === latestRequestToken) {
      deploymentData.value = fallbackData
      deploymentDataByChannel.value = {}
      channelNames.value = {}
      channelAppIds.value = {}
      deploymentDataByApp.value = {}
      appNames.value = {}
      totalDeployments.value = 0
      lastDayEvolution.value = 0
    }
  }
  finally {
    if (requestToken === latestRequestToken) {
      await ensureMinDelay(startTime)
      isLoading.value = false
    }
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

// Watch for app target changes - need to refetch
watch(() => props.appId, async () => {
  await calculateStats(true) // Force refetch for new app
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
    :title="t('deployment_statistics')"
    :total="effectiveTotalDeployments"
    :last-day-evolution="effectiveLastDayEvolution"
    :is-loading="isLoading"
    :has-data="hasData"
    :is-demo-data="isDemoMode"
  >
    <DeploymentStatsChart
      :key="isSingleAppMode ? JSON.stringify(deploymentDataByChannel) : JSON.stringify(effectiveDeploymentDataByApp)"
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
