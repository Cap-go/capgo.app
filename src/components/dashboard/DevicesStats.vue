<script setup lang="ts">
import type { ChartData, ChartOptions, Plugin } from 'chart.js'
import type { TooltipClickHandler } from '~/services/chartTooltip'
import type { Organization } from '~/stores/organization'
import { useDark } from '@vueuse/core'
import { CategoryScale, Chart, Filler, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { computed, ref, watch } from 'vue'
import { Line } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { createChartScales } from '~/services/chartConfig'
import { useChartData } from '~/services/chartDataService'
import { createTooltipConfig, todayLinePlugin, verticalLinePlugin } from '~/services/chartTooltip'
import { generateChartDayLabels, getChartDateRange, normalizeToStartOfDay } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { useSupabase } from '~/services/supabase'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useOrganizationStore } from '~/stores/organization'
import ChartCard from './ChartCard.vue'

const props = defineProps({
  appId: {
    type: String,
    default: '',
  },
  useBillingPeriod: {
    type: Boolean,
    default: true,
  },
  accumulated: {
    type: Boolean,
    default: true,
  },
  reloadTrigger: {
    type: Number,
    default: 0,
  },
  forceDemo: {
    type: Boolean,
    default: false,
  },
  usageKind: {
    type: String,
    default: 'bundle',
  },
})

// Demo data generator for devices stats when forceDemo is true
function generateDemoDevicesData(days: number, usageKind: string = 'bundle'): { labels: string[], datasets: { label: string, data: number[] }[] } {
  const labels: string[] = []
  const today = new Date()

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today)
    date.setDate(date.getDate() - i)
    labels.push(date.toISOString().split('T')[0])
  }

  // Generate realistic version adoption data
  // Simulate gradual migration from old version to new version
  const oldVersionData: number[] = []
  const newVersionData: number[] = []

  for (let i = 0; i < days; i++) {
    // Old version starts at ~85% and decreases
    const oldBase = 85 - (i * 2.5)
    const oldValue = Math.max(15, oldBase + (Math.random() * 5 - 2.5))

    // New version starts at ~15% and increases
    const newBase = 15 + (i * 2.5)
    const newValue = Math.min(85, newBase + (Math.random() * 5 - 2.5))

    // Normalize to ensure they roughly add up to 100%
    const total = oldValue + newValue
    oldVersionData.push(Math.round((oldValue / total) * 100 * 10) / 10)
    newVersionData.push(Math.round((newValue / total) * 100 * 10) / 10)
  }

  const labelsByKind = usageKind === 'native'
    ? ['iOS 1.0.0', 'Android 1.1.0']
    : ['2.0.5', '2.1.0']

  return {
    labels,
    datasets: [
      { label: labelsByKind[0], data: oldVersionData },
      { label: labelsByKind[1], data: newVersionData },
    ],
  }
}

interface ChartDataset {
  label: string
  data: Array<number | undefined>
  metaCountValues?: Array<number | undefined>
}

interface ChartApiData {
  labels: string[]
  datasets: ChartDataset[]
}

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

const isDark = useDark()
const { t } = useI18n()
const route = useRoute('/app/[app]')
const router = useRouter()
const organizationStore = useOrganizationStore()
const supabase = useSupabase()
const rawChartData = ref<ChartApiData | null>(null)

const detectedAppId = ref('')
const activeAppId = computed(() => props.appId || detectedAppId.value)
const isNativeUsage = computed(() => props.usageKind === 'native')
const titleKey = computed(() => isNativeUsage.value ? 'active_users_by_native_version' : 'active_users_by_version')

// Cache for bundle ID lookups (version name -> bundle ID)
const bundleIdCache = ref<Record<string, number>>({})

// Create a mapping from version label to itself for tooltip clicks
// Version names are the labels (e.g., "1.0.0")
const versionByLabel = computed(() => {
  const mapping: Record<string, string> = {}
  const datasets = rawChartData.value?.datasets ?? []
  datasets.forEach((dataset) => {
    // The label is the version name, we use it as both key and value
    mapping[dataset.label] = dataset.label
  })
  return mapping
})

// Look up bundle ID and navigate directly to bundle page
async function navigateToBundle(versionName: string) {
  // Check cache first
  if (bundleIdCache.value[versionName]) {
    router.push(`/app/${activeAppId.value}/bundle/${bundleIdCache.value[versionName]}`)
    return
  }

  // Query the database to get the bundle ID from version name
  const { data } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', activeAppId.value)
    .eq('name', versionName)
    .limit(1)
    .single()

  if (data?.id) {
    // Cache the result
    bundleIdCache.value[versionName] = data.id
    router.push(`/app/${activeAppId.value}/bundle/${data.id}`)
  }
}

// Click handler for tooltip items - navigates directly to bundle page
// Disabled in demo mode to prevent navigation to non-existent bundles
const tooltipClickHandler = computed<TooltipClickHandler | undefined>(() => {
  if (props.forceDemo || isNativeUsage.value)
    return undefined
  return {
    onAppClick: navigateToBundle,
    appIdByLabel: versionByLabel.value,
  }
})
const isLoading = ref(true)
const currentRange = ref<{ startDate: Date, endDate: Date } | null>(null)
let requestToken = 0

// Cache for both billing period and last 30 days data
const cachedBillingData = ref<{ data: ChartApiData, range: { startDate: Date, endDate: Date } } | null>(null)
const cached30DayData = ref<{ data: ChartApiData, range: { startDate: Date, endDate: Date } } | null>(null)

const latestVersion = computed(() => {
  const chartData = rawChartData.value
  const datasets = chartData?.datasets ?? []

  if (!datasets.length)
    return null

  const lastIndexWithData = datasets.reduce((maxIndex, dataset) => {
    const values = dataset.data ?? []

    for (let index = values.length - 1; index >= 0; index--) {
      const value = values[index]
      if (typeof value === 'number' && !Number.isNaN(value))
        return Math.max(maxIndex, index)
    }

    return maxIndex
  }, -1)

  if (lastIndexWithData < 0)
    return null

  const totalCountAtLastDay = datasets.reduce((sum, dataset) => {
    const countValues = (dataset as any)?.metaCountValues as Array<number | undefined> | undefined
    const countAtIndex = countValues?.[lastIndexWithData]
    const numericCount = typeof countAtIndex === 'number' && !Number.isNaN(countAtIndex) ? countAtIndex : 0
    return sum + Math.max(0, numericCount)
  }, 0)
  const hasCountMetadata = totalCountAtLastDay > 0

  const datasetAtLastDay = datasets.reduce<{ name: string, count: number, share: number } | null>((current, dataset) => {
    const value = dataset.data?.[lastIndexWithData]
    const numericValue = typeof value === 'number' && !Number.isNaN(value) ? value : null

    if (numericValue === null)
      return current

    const countValues = (dataset as any)?.metaCountValues as Array<number | undefined> | undefined
    const countAtIndex = countValues?.[lastIndexWithData]
    const count = typeof countAtIndex === 'number' && !Number.isNaN(countAtIndex)
      ? Math.max(0, countAtIndex)
      : 0
    const share = totalCountAtLastDay > 0
      ? (count / totalCountAtLastDay) * 100
      : Math.max(0, numericValue)
    if (!current)
      return { name: dataset.label, count, share }

    if (hasCountMetadata) {
      if (count > current.count || (count === current.count && share > current.share))
        return { name: dataset.label, count, share }
      return current
    }

    if (share > current.share)
      return { name: dataset.label, count, share }

    return current
  }, null)

  if (datasetAtLastDay)
    return datasetAtLastDay

  const fallbackDataset = datasets.reduce<{ label: string, value: number } | null>((current, dataset) => {
    const value = dataset.data?.[lastIndexWithData]
    const numericValue = typeof value === 'number' && !Number.isNaN(value) ? value : null
    if (numericValue === null)
      return current
    if (!current || numericValue > current.value)
      return { label: dataset.label, value: numericValue }
    return current
  }, null)
  if (fallbackDataset) {
    return {
      name: fallbackDataset.label,
      count: 0,
      share: Math.max(0, fallbackDataset.value),
    }
  }

  return null
})
const latestVersionPercentageDisplay = computed(() => {
  const rawPercentage = latestVersion.value?.share
  if (rawPercentage === null || rawPercentage === undefined)
    return ''

  const numeric = Number(rawPercentage)
  if (!Number.isFinite(numeric))
    return ''

  return `${formatNumberValue(numeric, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
})
const latestVersionCountDisplay = computed(() => {
  const count = latestVersion.value?.count ?? 0
  return formatNumberValue(count)
})

function resolveOrganizationForCurrentContext(): Organization | undefined {
  if (activeAppId.value) {
    const org = organizationStore.getOrgByAppId(activeAppId.value)
    if (org)
      return org
  }
  return organizationStore.currentOrganization
}

function getDateRange() {
  const activeOrganization = resolveOrganizationForCurrentContext()
  return getChartDateRange(
    props.useBillingPeriod,
    activeOrganization?.subscription_start,
    activeOrganization?.subscription_end,
  )
}

const totalDays = computed(() => {
  if (!currentRange.value) {
    return rawChartData.value?.labels.length ?? 0
  }

  // Both modes: show full date range (billing cycle or last 30 days)
  const { startDate, endDate } = currentRange.value
  return Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
})

function generateDayLabels(_totalLength: number) {
  if (!currentRange.value)
    return []

  // Both modes: generate labels for the full date range
  const { startDate, endDate } = currentRange.value
  return generateChartDayLabels(props.useBillingPeriod, startDate, endDate)
}

const processedChartData = computed<ChartData<'line'> | null>(() => {
  if (!rawChartData.value)
    return null

  const targetLength = totalDays.value

  // Calculate offset for padding in both modes
  // If API data starts later than our range start, we need padding
  let dataOffset = 0
  if (currentRange.value && rawChartData.value.labels.length > 0) {
    const firstApiDate = new Date(rawChartData.value.labels[0])
    const rangeStart = currentRange.value.startDate
    dataOffset = Math.floor((firstApiDate.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24))
    if (dataOffset < 0)
      dataOffset = 0
  }

  let globalLastDataIndex = -1
  const normalizedDatasets = rawChartData.value.datasets.map((dataset) => {
    const rawValues = dataset.data ?? []
    const rawCountValues = Array.isArray((dataset as any).metaCountValues)
      ? ((dataset as any).metaCountValues as Array<number | undefined>)
      : []
    const limitIndex = (() => {
      if (!props.useBillingPeriod)
        return rawValues.length - 1

      if (!currentRange.value)
        return rawValues.length - 1

      const today = normalizeToStartOfDay(new Date())
      const diff = Math.floor((today.getTime() - currentRange.value.startDate.getTime()) / (24 * 60 * 60 * 1000))

      if (Number.isNaN(diff))
        return -1

      if (diff < 0)
        return -1

      return Math.min(diff, rawValues.length - 1)
    })()
    const normalizedValues = rawValues.map((value) => {
      if (typeof value === 'number')
        return value
      if (value === null || value === undefined)
        return undefined
      const parsed = Number(value)
      return Number.isNaN(parsed) ? undefined : parsed
    }).map((value, index) => {
      if (limitIndex < 0)
        return undefined
      if (index > limitIndex)
        return undefined
      return value
    })
    const normalizedCountValues = rawCountValues.map((value) => {
      if (typeof value === 'number')
        return Math.max(0, Math.round(value))
      if (value === null || value === undefined)
        return undefined
      const parsed = Number(value)
      return Number.isNaN(parsed) ? undefined : Math.max(0, Math.round(parsed))
    }).map((value, index) => {
      if (limitIndex < 0)
        return undefined
      if (index > limitIndex)
        return undefined
      return value
    })

    for (let index = normalizedValues.length - 1; index >= 0; index--) {
      const candidate = normalizedValues[index]
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        // Account for offset when tracking last data index
        globalLastDataIndex = Math.max(globalLastDataIndex, index + dataOffset)
        break
      }
    }

    return { dataset, normalizedValues, normalizedCountValues }
  })
  const formattedLabels = generateDayLabels(targetLength)
  const datasets: ChartData<'line'>['datasets'] = []

  normalizedDatasets.forEach(({ dataset, normalizedValues, normalizedCountValues }, datasetIndex) => {
    // Pad with nulls at the start if needed (when billing period starts before API data)
    const paddedValues = Array.from({ length: targetLength }, (_val, index) => {
      const dataIndex = index - dataOffset
      return dataIndex >= 0 && dataIndex < normalizedValues.length ? normalizedValues[dataIndex] : undefined
    })
    const paddedCountValues = Array.from({ length: targetLength }, (_val, index) => {
      const dataIndex = index - dataOffset
      return dataIndex >= 0 && dataIndex < normalizedCountValues.length ? normalizedCountValues[dataIndex] : undefined
    })
    const previousDataset = datasetIndex > 0 ? datasets[datasetIndex - 1] : null
    const previousDatasetData = previousDataset && Array.isArray(previousDataset.data)
      ? previousDataset.data as Array<number | null | undefined>
      : undefined
    let lastKnownBaseValue = 0
    let hasSeenValue = false
    const tooltipBaseValues: Array<number | null> = []
    const processedData = props.accumulated
      ? paddedValues.map((value, pointIndex) => {
          if (globalLastDataIndex < 0) {
            tooltipBaseValues.push(null)
            return null
          }
          if (globalLastDataIndex >= 0 && pointIndex > globalLastDataIndex) {
            tooltipBaseValues.push(null)
            return null
          }
          if (typeof value === 'number' && Number.isFinite(value)) {
            lastKnownBaseValue = value
            hasSeenValue = true
          }

          const hasValidValue = typeof value === 'number' && Number.isFinite(value)
          const baseValue = hasValidValue
            ? value
            : hasSeenValue
              ? lastKnownBaseValue
              : null
          tooltipBaseValues.push(baseValue)
          const previousValueRaw = previousDatasetData?.[pointIndex]
          const hasPreviousValue = typeof previousValueRaw === 'number' && Number.isFinite(previousValueRaw)
          const previousValue = hasPreviousValue ? previousValueRaw : 0
          if (baseValue === null)
            return null

          const stackedValue = datasetIndex === 0 ? baseValue : baseValue + previousValue

          if (!Number.isFinite(stackedValue))
            return datasetIndex > 0 && hasPreviousValue ? previousValue : null

          return stackedValue
        })
      : paddedValues.map((val, pointIndex) => {
          if (globalLastDataIndex >= 0 && pointIndex > globalLastDataIndex) {
            tooltipBaseValues.push(null)
            paddedCountValues[pointIndex] = undefined
            return null
          }
          const numericValue = typeof val === 'number' && Number.isFinite(val) ? val : null
          tooltipBaseValues.push(numericValue)
          return numericValue
        })

    const chartDataset = {
      ...dataset,
      data: processedData,
      fill: props.accumulated ? (datasetIndex === 0 ? 'origin' : '-1') : false,
      tension: 0.3,
      pointRadius: props.accumulated ? 0 : 2,
      pointBorderWidth: 0,
      borderWidth: 2,
    } as ChartData<'line'>['datasets'][number]
    Object.assign(chartDataset, {
      metaBaseValues: tooltipBaseValues,
      metaCountValues: paddedCountValues,
    })
    datasets.push(chartDataset)
  })

  return {
    labels: formattedLabels,
    datasets,
  }
})

// Demo mode: show demo data only when forceDemo is true OR user has no apps
// If user has apps, ALWAYS show real data (even if empty)
const dashboardAppsStore = useDashboardAppsStore()
const isDemoMode = computed(() => {
  if (props.forceDemo)
    return true
  // If user has apps, never show demo data
  if (dashboardAppsStore.apps.length > 0)
    return false
  // No apps and store is loaded = show demo
  return dashboardAppsStore.isLoaded
})

const hasData = computed(() => !!(processedChartData.value && processedChartData.value.datasets.length > 0) || isDemoMode.value)

const todayLineOptions = computed(() => {
  if (!props.useBillingPeriod || !currentRange.value)
    return { enabled: false }

  const today = normalizeToStartOfDay(new Date())
  const { startDate, endDate } = currentRange.value

  if (today < startDate || today > endDate)
    return { enabled: false }

  const index = Math.floor((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000))
  const labels = Array.isArray(processedChartData.value?.labels) ? processedChartData.value!.labels : []

  if (index < 0 || index >= labels.length)
    return { enabled: false }

  const strokeColor = isDark.value ? 'rgba(165, 180, 252, 0.75)' : 'rgba(99, 102, 241, 0.7)'
  const glowColor = isDark.value ? 'rgba(129, 140, 248, 0.35)' : 'rgba(165, 180, 252, 0.35)'
  const badgeFill = isDark.value ? 'rgba(67, 56, 202, 0.45)' : 'rgba(199, 210, 254, 0.85)'
  const textColor = isDark.value ? '#e0e7ff' : '#312e81'

  return {
    enabled: true,
    xIndex: index,
    label: t('today'),
    color: strokeColor,
    glowColor,
    badgeFill,
    textColor,
  }
})

const chartOptions = computed<ChartOptions<'line'>>(() => {
  const hasMultipleDatasets = (processedChartData.value?.datasets.length ?? 0) > 1
  const tooltipOptions = createTooltipConfig(hasMultipleDatasets, props.accumulated, props.useBillingPeriod ? currentRange.value?.startDate : false, hasMultipleDatasets ? tooltipClickHandler.value : undefined)

  const pluginOptions = {
    legend: {
      display: false,
    },
    title: { display: false },
    tooltip: tooltipOptions,
    filler: {
      propagate: false,
    },
    todayLine: todayLineOptions.value,
  } as const

  return {
    maintainAspectRatio: false,
    scales: createChartScales(isDark.value, {
      max: props.accumulated ? 110 : 100,
      xStacked: props.accumulated,
      yStacked: props.accumulated,
      yTickCallback: (tickValue: string | number) => {
        const numericValue = typeof tickValue === 'number' ? tickValue : Number(tickValue)
        if (props.accumulated && numericValue > 100)
          return ''
        const display = Number.isFinite(numericValue)
          ? formatNumberValue(numericValue, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
          : tickValue
        return `${display}%`
      },
    }),
    plugins: pluginOptions as unknown as NonNullable<ChartOptions<'line'>['plugins']>,
  }
})

const chartPlugins = [verticalLinePlugin, todayLinePlugin] as unknown as Plugin<'line'>[]

async function loadData(forceRefetch = false) {
  if (!activeAppId.value) {
    rawChartData.value = null
    return
  }

  // If forceDemo is true (payment failed), use demo data instead of fetching
  if (props.forceDemo) {
    const { startDate, endDate } = getDateRange()
    const days = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
    const demoData = generateDemoDevicesData(days, props.usageKind)
    rawChartData.value = demoData
    currentRange.value = { startDate, endDate }
    isLoading.value = false
    return
  }

  try {
    await organizationStore.dedupFetchOrganizations()
    await organizationStore.awaitInitialLoad()
  }
  catch (error) {
    console.error('[DevicesStats] Error preparing organization data for mobile stats:', error)
  }

  const { startDate, endDate } = getDateRange()
  const isBillingMode = props.useBillingPeriod

  // Check if we have cached data for this mode that matches the current date range
  const cachedData = isBillingMode ? cachedBillingData.value : cached30DayData.value

  // Validate cache: dates must match (comparing timestamps to avoid reference issues)
  const cacheIsValid = cachedData
    && cachedData.range.startDate.getTime() === startDate.getTime()
    && cachedData.range.endDate.getTime() === endDate.getTime()

  if (cacheIsValid && !forceRefetch) {
    rawChartData.value = cachedData.data
    currentRange.value = cachedData.range
    return
  }

  // Clear invalid cache for this mode
  if (cachedData && !cacheIsValid) {
    if (isBillingMode) {
      cachedBillingData.value = null
    }
    else {
      cached30DayData.value = null
    }
  }

  const currentToken = ++requestToken
  isLoading.value = true
  rawChartData.value = null
  currentRange.value = { startDate, endDate }

  try {
    const data = await useChartData(supabase, activeAppId.value, startDate, endDate, props.usageKind === 'native' ? 'native' : 'bundle')

    if (currentToken !== requestToken)
      return

    rawChartData.value = data

    // Cache the data for this mode
    const cacheEntry = { data, range: { startDate, endDate } }
    if (isBillingMode) {
      cachedBillingData.value = cacheEntry
    }
    else {
      cached30DayData.value = cacheEntry
    }
  }
  catch (error) {
    console.error('[DevicesStats] Error fetching chart data:', error)
    if (currentToken !== requestToken)
      return
    rawChartData.value = null
  }
  finally {
    if (currentToken === requestToken) {
      isLoading.value = false
    }
  }
}

// Watch billing period changes - use cached data if available
watch(() => props.useBillingPeriod, async () => {
  if (activeAppId.value)
    await loadData(false) // Use cache if available
})

// Watch forceDemo changes - reload with demo data or real data
watch(() => props.forceDemo, async () => {
  if (activeAppId.value)
    await loadData(true) // Force reload to switch between demo/real data
})

// Watch for reload trigger - force refetch
watch(() => props.reloadTrigger, async () => {
  if (activeAppId.value)
    await loadData(true) // Force refetch
})

watch(
  () => [route.path, route.params.app as string | undefined] as const,
  async ([path, packageId], old) => {
    if (props.appId)
      return
    const oldPackageId = old?.[1]
    // Check for app route pattern
    if (path.includes('/app/') && packageId) {
      const packageChanged = packageId !== oldPackageId
      detectedAppId.value = packageId
      if (packageChanged) {
        // Clear cache when switching apps
        cachedBillingData.value = null
        cached30DayData.value = null
        await loadData(true) // Force refetch for new app
      }
      else if (!rawChartData.value) {
        // Initial load - no data yet
        await loadData(true)
      }
    }
    else {
      detectedAppId.value = ''
      requestToken++
      rawChartData.value = null
      isLoading.value = true
    }
  },
  { immediate: true },
)

watch(
  () => [props.appId, props.usageKind] as const,
  async ([packageId, usageKind], old) => {
    const oldPackageId = old?.[0]
    const oldUsageKind = old?.[1]
    const usageKindChanged = oldUsageKind !== undefined && usageKind !== oldUsageKind

    if (!packageId && !usageKindChanged)
      return

    if (packageId)
      detectedAppId.value = packageId

    if (!activeAppId.value)
      return

    const packageChanged = !!packageId && packageId !== oldPackageId

    if (packageChanged || usageKindChanged) {
      cachedBillingData.value = null
      cached30DayData.value = null
      await loadData(true)
    }
    else if (!rawChartData.value) {
      await loadData(true)
    }
  },
  { immediate: true },
)
</script>

<template>
  <ChartCard
    :title="t(titleKey)"
    :is-loading="isLoading"
    :has-data="hasData"
    :is-demo-data="isDemoMode"
  >
    <template #header>
      <div class="flex items-start justify-between flex-1 gap-2">
        <h2 class="flex-1 min-w-0 text-2xl font-semibold leading-tight dark:text-white text-slate-600">
          {{ t(titleKey) }}
        </h2>

        <div class="flex max-w-[11rem] flex-col items-end text-right shrink-0">
          <div
            class="inline-flex items-center justify-center px-2 py-1 text-xs font-bold text-white rounded-full shadow-lg whitespace-nowrap bg-cyan-500"
          >
            {{ latestVersionPercentageDisplay }}
          </div>
          <div
            v-if="latestVersion"
            class="font-bold leading-tight break-words dark:text-white text-slate-600"
            :class="isNativeUsage ? 'text-xl sm:text-2xl' : 'text-3xl'"
          >
            {{ latestVersion.name }}
          </div>
          <div v-if="latestVersion" class="text-xs text-slate-500 dark:text-slate-400">
            {{ latestVersionCountDisplay }} {{ t('devices') }}
          </div>
        </div>
      </div>
    </template>

    <Line class="h-full w-full" :data="processedChartData!" :options="chartOptions" :plugins="chartPlugins" />
  </ChartCard>
</template>
