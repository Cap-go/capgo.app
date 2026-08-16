<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import dayjs from 'dayjs'
import { storeToRefs } from 'pinia'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import CreditsCta from '~/components/CreditsCta.vue'
import PageLoader from '~/components/PageLoader.vue'
import { bytesToGb } from '~/services/conversion'
import { formatLocalDate, formatLocalDateTime, formatUtcDateTimeAsLocal } from '~/services/date'
import { formatNumber, formatNumberValue } from '~/services/formatLocale'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { calculateCreditCost, getCurrentPlanNameOrg, getPlans, getPlanUsagePercent, getTotalStorage, getUsageCreditDeductions } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { isCreditsOnlyOrg } from '~/utils/organizationBilling'

type PlanUsageDetailed = Database['public']['Functions']['get_plan_usage_percent_detailed']['Returns'][number]
// tabs handled by settings layout

const { t } = useI18n()
const plans = ref<Database['public']['Tables']['plans']['Row'][]>([])

const isLoading = ref(false)
const initialLoad = ref(true)
const route = useRoute()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const router = useRouter()
const dialogStore = useDialogV2Store()
const displayStore = useDisplayStore()
displayStore.NavTitle = t('usage')
const hideExternalPurchaseFlows = isNativeAppStoreContext()

const { currentOrganization } = storeToRefs(organizationStore)

watchEffect(async () => {
  if (route.path === '/settings/organization/plans') {
    // if success is in url params show modal success plan setup
    if (route.query.success) {
      toast.success(t('usage-success'))
    }
  }
})

async function getUsage(orgId: string) {
  const usage = main.dashboard

  const planCurrent = await getCurrentPlanNameOrg(orgId)
  const currentPlan = plans.value.find((p: Database['public']['Tables']['plans']['Row']) => p.name === planCurrent)

  // Get usage percentages
  let detailPlanUsage: PlanUsageDetailed = {
    total_percent: 0,
    mau_percent: 0,
    bandwidth_percent: 0,
    storage_percent: 0,
    build_time_percent: 0,
  }

  try {
    detailPlanUsage = await getPlanUsagePercent(orgId)
  }
  catch (err) {
    console.log('Error getting plan usage percent:', err)
  }
  detailPlanUsage = roundUsagePercents(detailPlanUsage)

  const creditDeductions = await getUsageCreditDeductions(orgId)

  const nowEndOfDay = dayjs().endOf('day')
  const billingStart = organizationStore.currentOrganization?.subscription_start
    ? dayjs(organizationStore.currentOrganization.subscription_start).startOf('day')
    : null
  const billingEndRaw = organizationStore.currentOrganization?.subscription_end
    ? dayjs(organizationStore.currentOrganization.subscription_end).endOf('day')
    : null
  const billingEnd = billingEndRaw && billingEndRaw.isBefore(nowEndOfDay) ? billingEndRaw : nowEndOfDay

  const usageInCycle = usage.filter((entry) => {
    const entryDate = dayjs(entry.date)
    if (billingStart && entryDate.isBefore(billingStart))
      return false
    if (entryDate.isAfter(billingEnd))
      return false
    return true
  })

  const relevantUsage = usageInCycle.length > 0 ? usageInCycle : usage

  const creditDeductionsInCycle = creditDeductions.filter((entry) => {
    if (entry.amount === null)
      return false

    const entryStart = entry.billing_cycle_start
      ? dayjs(entry.billing_cycle_start).startOf('day')
      : entry.occurred_at
        ? dayjs(entry.occurred_at).startOf('day')
        : null

    const entryEnd = entry.billing_cycle_end
      ? dayjs(entry.billing_cycle_end).endOf('day')
      : entry.occurred_at
        ? dayjs(entry.occurred_at).endOf('day')
        : null

    if (billingStart && entryEnd && entryEnd.isBefore(billingStart))
      return false

    if (billingEnd && entryStart && entryStart.isAfter(billingEnd))
      return false

    return true
  })
  const totalCreditDeductions = creditDeductionsInCycle.reduce((acc, entry) => acc + Math.abs(entry.amount ?? 0), 0)

  const totalMau = relevantUsage.reduce((acc, entry) => acc + (entry.mau ?? 0), 0)
  const totalBandwidthBytes = relevantUsage.reduce((acc, entry) => acc + (entry.bandwidth ?? 0), 0)
  const totalBandwidth = bytesToGb(totalBandwidthBytes)
  const totalStorageBytes = await getTotalStorage(orgId)
  const totalStorage = bytesToGb(totalStorageBytes)
  const totalBuildTime = relevantUsage.reduce((acc, entry) => acc + (entry.build_time_seconds ?? 0), 0)

  detailPlanUsage = maybeDeriveMissingUsagePercents({
    detailPlanUsage,
    currentPlan,
    totalBandwidth,
    totalBuildTime,
    totalMau,
    totalStorage,
  })

  const basePrice = currentPlan?.price_m ?? 0
  let estimatedUsagePrice: number | null = null

  if (currentPlan) {
    try {
      const overageCost = await calculateCreditCost({
        org_id: orgId,
        mau: Math.max(totalMau - currentPlan.mau, 0),
        bandwidth: Math.max(totalBandwidthBytes - Math.round(currentPlan.bandwidth * 1073741824), 0),
        storage: Math.max(totalStorageBytes - Math.round(currentPlan.storage * 1073741824), 0),
        build_time: Math.max(totalBuildTime - currentPlan.build_time_unit, 0),
      })
      estimatedUsagePrice = roundNumber(overageCost.total_cost)
    }
    catch (err) {
      console.error('Error estimating credit overage cost:', err)
    }
  }

  const totalUsagePrice = creditDeductionsInCycle.length > 0
    ? roundNumber(totalCreditDeductions)
    : estimatedUsagePrice
  const totalPrice = totalUsagePrice !== null && currentPlan
    ? roundNumber(basePrice + totalUsagePrice)
    : null

  return {
    currentPlan,
    totalPrice,
    totalUsagePrice,
    totalMau,
    totalBandwidth,
    totalStorage,
    totalBuildTime,
    detailPlanUsage,
    cycle: {
      subscription_anchor_start: formatLocalDate(organizationStore.currentOrganization?.subscription_start) || t('unknown'),
      subscription_anchor_end: formatLocalDate(organizationStore.currentOrganization?.subscription_end) || t('unknown'),
    },
  }
}

const planUsageMap = ref(new Map<string, Awaited<ReturnType<typeof getUsage>>>())
const planUsage = computed(() => planUsageMap.value?.get(currentOrganization.value?.gid ?? ''))

// Similar to Plans.vue - current plan and best plan computed properties
const currentPlan = computed(() => main.plans.find(plan => plan.name === planUsage.value?.currentPlan?.name))
const currentPlanSuggest = computed(() => main.plans.find(plan => plan.name === main.bestPlan))
const isCreditsOnly = computed(() => isCreditsOnlyOrg(currentOrganization.value))
const currentPlanLabel = computed(() => {
  if (isCreditsOnly.value)
    return t('credits')
  return currentPlan.value?.name || t('loading')
})

function roundNumber(number: number) {
  return Math.round(number * 100) / 100
}

function formatCurrency(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return t('unknown')

  return formatNumber(value, { style: 'currency', currency: 'USD' })
}

function formatMonthlyPrice(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return t('unknown')

  return `${formatCurrency(value)}/${t('mo')}`
}

function formatPercentValue(value?: number | null) {
  return formatNumberValue(value ?? 0, { maximumFractionDigits: 0 })
}

function percent(usage: number, limit: number) {
  if (!Number.isFinite(usage) || !Number.isFinite(limit) || limit <= 0)
    return 0
  return Math.round((usage / limit) * 100)
}

function roundUsagePercents(usage: PlanUsageDetailed) {
  return {
    ...usage,
    total_percent: Math.round(usage.total_percent ?? 0),
    mau_percent: Math.round(usage.mau_percent ?? 0),
    bandwidth_percent: Math.round(usage.bandwidth_percent ?? 0),
    storage_percent: Math.round(usage.storage_percent ?? 0),
    build_time_percent: Math.round(usage.build_time_percent ?? 0),
  }
}

function maybeDeriveMissingUsagePercents(params: {
  detailPlanUsage: PlanUsageDetailed
  currentPlan: Database['public']['Tables']['plans']['Row'] | undefined
  totalMau: number
  totalBandwidth: number
  totalStorage: number
  totalBuildTime: number
}) {
  const {
    detailPlanUsage,
    currentPlan,
    totalBandwidth,
    totalBuildTime,
    totalMau,
    totalStorage,
  } = params

  if (!currentPlan || (
    detailPlanUsage.mau_percent !== 0
    || detailPlanUsage.bandwidth_percent !== 0
    || detailPlanUsage.storage_percent !== 0
    || detailPlanUsage.build_time_percent !== 0
    || (totalMau <= 0 && totalBandwidth <= 0 && totalStorage <= 0 && totalBuildTime <= 0)
  )) {
    return detailPlanUsage
  }

  const fallback = {
    mau_percent: percent(totalMau, currentPlan.mau),
    bandwidth_percent: percent(totalBandwidth, currentPlan.bandwidth),
    storage_percent: percent(totalStorage, currentPlan.storage),
    build_time_percent: percent(totalBuildTime, currentPlan.build_time_unit),
  }

  return {
    ...detailPlanUsage,
    mau_percent: fallback.mau_percent,
    bandwidth_percent: fallback.bandwidth_percent,
    storage_percent: fallback.storage_percent,
    build_time_percent: fallback.build_time_percent,
    total_percent: Math.max(
      fallback.mau_percent,
      fallback.bandwidth_percent,
      fallback.storage_percent,
      fallback.build_time_percent,
    ),
  }
}

function formatBuildTime(seconds: number): string {
  if (seconds === 0)
    return '0m'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0)
    return `${formatNumberValue(hours)}h ${formatNumberValue(minutes)}m`
  return `${formatNumberValue(minutes)}m`
}

const shouldShowUpgrade = computed(() => {
  if (hideExternalPurchaseFlows)
    return false

  if (!currentPlanSuggest.value || !currentPlan.value) {
    return false
  }

  // Compare based on price - if suggested plan is better (higher features) and price makes sense
  return currentPlanSuggest.value.price_m > currentPlan.value.price_m
})

function goToPlans() {
  router.push('/settings/organization/plans')
}

onMounted(async () => {
  await loadData()
})

async function loadData() {
  await Promise.all([organizationStore.awaitInitialLoad(), main.awaitInitialLoad()])
  const gid = organizationStore?.currentOrganization?.gid ?? ''

  if (isLoading.value)
    return

  isLoading.value = true

  if (initialLoad.value) {
    const pls = await getPlans()
    plans.value.length = 0
    plans.value.push(...pls)
  }

  const usageDetails = await getUsage(gid)
  planUsageMap.value?.set(gid, usageDetails as any)
  isLoading.value = false
  initialLoad.value = false
}

function lastRunDate() {
  const source = currentOrganization.value?.stats_updated_at
  if (!source)
    return `${t('last-run')}: ${t('unknown')}`

  const lastRun = formatUtcDateTimeAsLocal(source) || t('unknown')
  return `${t('last-run')}: ${lastRun}`
}
function nextRunDate() {
  const source = currentOrganization.value?.next_stats_update_at
  if (!source)
    return `${t('next-run')}: ${t('unknown')}`

  const nextRun = formatLocalDateTime(source) || t('unknown')
  return `${t('next-run')}: ${nextRun}`
}
</script>

<template>
  <div class="flex flex-col pb-8 bg-white border shadow-lg md:p-8 md:pb-0 md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
    <div v-if="!isLoading" class="flex flex-col w-full">
      <!-- Header -->
      <div class="flex flex-col justify-between gap-4 mb-8 md:flex-row md:items-center shrink-0">
        <div>
          <h1 class="text-3xl font-bold text-gray-900 dark:text-white">
            {{ t('usage') }}
          </h1>
          <div class="flex items-center gap-3 mt-1 text-sm text-gray-500 dark:text-gray-400">
            <div class="flex gap-1.5 items-center">
              <div class="w-1.5 h-1.5 bg-green-500 rounded-full" />
              {{ lastRunDate() }}
            </div>
            <span class="text-gray-300 dark:text-gray-600">•</span>
            <div class="flex gap-1.5 items-center">
              <div class="w-1.5 h-1.5 bg-blue-500 rounded-full" />
              {{ nextRunDate() }}
            </div>
          </div>
        </div>

        <div class="flex gap-2 items-center py-1.5 px-3 text-sm bg-gray-50 rounded-lg border border-gray-200 shadow-sm dark:bg-gray-900 dark:border-gray-700">
          <span class="text-gray-500 dark:text-gray-400">{{ t('billing-cycle') }}:</span>
          <span class="font-medium text-gray-900 dark:text-white">{{ planUsage?.cycle.subscription_anchor_start }}</span>
          <span class="text-gray-400">→</span>
          <span class="font-medium text-gray-900 dark:text-white">{{ planUsage?.cycle.subscription_anchor_end }}</span>
        </div>
      </div>

      <!-- Plan & Cost Overview -->
      <div class="grid grid-cols-1 gap-6 mb-8 lg:grid-cols-3 shrink-0">
        <!-- Current Plan -->
        <div class="flex flex-col justify-between p-5 border border-gray-200 shadow-sm lg:col-span-2 bg-gray-50 rounded-xl dark:bg-gray-900 dark:border-gray-700">
          <div class="flex flex-row justify-between">
            <div class="flex flex-col">
              <div class="mb-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('plan') }}
              </div>
              <div class="text-2xl font-bold text-gray-900 dark:text-white">
                {{ currentPlanLabel }}
              </div>
              <div v-if="isCreditsOnly" class="mt-1 text-xs font-medium text-blue-600 dark:text-blue-400">
                {{ t('credits-only-banner') }}
              </div>
            </div>
            <div v-if="!hideExternalPurchaseFlows && !isCreditsOnly" class="flex flex-col">
              <div class="mb-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('base') }}
              </div>
              <div class="text-2xl font-bold text-gray-900 dark:text-white">
                {{ formatMonthlyPrice(currentPlan?.price_m) }}
              </div>
            </div>
            <div v-if="!hideExternalPurchaseFlows && isCreditsOnly" class="flex flex-col">
              <div class="mb-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('credits') }}
              </div>
              <div class="text-2xl font-bold text-gray-900 dark:text-white">
                {{ formatNumberValue(Number(currentOrganization?.credit_available ?? 0), { maximumFractionDigits: 0 }) }}
              </div>
            </div>
            <div v-if="!hideExternalPurchaseFlows" class="flex flex-col">
              <div class="mb-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('credits-used-in-period') }}
              </div>
              <div class="text-2xl font-bold text-gray-900 dark:text-white">
                {{ formatCurrency(planUsage?.totalUsagePrice) }}
              </div>
            </div>
          </div>
          <div v-if="!hideExternalPurchaseFlows" class="flex items-end justify-between pt-4 mt-4 border-t border-gray-100 dark:border-gray-700">
            <div class="text-sm text-gray-500 dark:text-gray-400">
              {{ t('total') }}
            </div>
            <div class="text-xl font-semibold text-gray-900 dark:text-white">
              {{ formatCurrency(isCreditsOnly ? planUsage?.totalUsagePrice : planUsage?.totalPrice) }}
            </div>
          </div>
        </div>

        <!-- Upgrade / Best Plan -->
        <div v-if="shouldShowUpgrade" class="relative p-5 overflow-hidden border border-blue-200 shadow-sm from-blue-50 to-indigo-50 rounded-xl dark:border-blue-800 bg-linear-to-br dark:from-blue-900/20 dark:to-indigo-900/20">
          <div class="relative z-10">
            <div class="flex items-start justify-between mb-2">
              <div class="text-sm font-medium text-blue-800 dark:text-blue-200">
                {{ t('recommended') }}
              </div>
              <div class="py-0.5 px-2 text-xs font-bold text-white bg-blue-600 rounded-full">
                {{ t('upgrade') }}
              </div>
            </div>
            <div class="mb-1 text-xl font-bold text-gray-900 dark:text-white">
              {{ currentPlanSuggest?.name }}
            </div>
            <div class="mb-4 text-sm text-gray-600 dark:text-gray-300">
              {{ formatMonthlyPrice(currentPlanSuggest?.price_m) }}
            </div>
            <button type="button" class="w-full py-2 text-sm font-semibold text-white transition-colors bg-blue-600 rounded-lg shadow-sm hover:bg-blue-700" @click="goToPlans">
              {{ t('plan-upgrade-v2') }}
            </button>
          </div>
        </div>
        <div v-else class="flex items-center justify-center p-5 text-sm italic text-gray-400 border border-gray-200 bg-gray-50 rounded-xl dark:text-gray-500 dark:bg-gray-900 dark:border-gray-700">
          {{ t('good') }}
        </div>
      </div>

      <!-- Credits CTA -->
      <CreditsCta v-if="!hideExternalPurchaseFlows" class="mb-8 shrink-0" :credits-only="isCreditsOnly" />

      <!-- Usage Metrics Grid -->
      <h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white shrink-0">
        {{ t('usage') }}
      </h2>
      <div class="grid grid-cols-1 gap-6 mb-8 md:grid-cols-2 xl:grid-cols-4 shrink-0">
        <!-- MAU -->
        <div class="p-5 transition-shadow border border-gray-200 shadow-sm bg-gray-50 rounded-xl dark:bg-gray-900 dark:border-gray-700 hover:shadow-md">
          <div class="flex items-start justify-between mb-4">
            <div class="text-sm font-medium text-gray-500 dark:text-gray-400">
              {{ t('monthly-active-users') }}
            </div>
            <div class="text-lg font-bold" :class="(planUsage?.detailPlanUsage?.mau_percent || 0) >= 100 ? 'text-red-600' : 'text-gray-900 dark:text-white'">
              {{ formatPercentValue(planUsage?.detailPlanUsage?.mau_percent) }}%
            </div>
          </div>
          <div class="w-full h-2 mb-4 overflow-hidden bg-gray-100 rounded-full dark:bg-gray-700">
            <div class="h-full transition-all duration-500 rounded-full" :class="(planUsage?.detailPlanUsage?.mau_percent || 0) >= 100 ? 'bg-red-500' : 'bg-blue-500'" :style="{ width: `${Math.min(planUsage?.detailPlanUsage?.mau_percent || 0, 100)}%` }" />
          </div>
          <div class="space-y-1 text-sm">
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('used-in-period') }}</span>
              <span class="font-medium text-gray-900 dark:text-white">{{ formatNumberValue(planUsage?.totalMau) }}</span>
            </div>
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('included-in-plan') }}</span>
              <span>{{ formatNumberValue(planUsage?.currentPlan?.mau) }}</span>
            </div>
          </div>
        </div>

        <!-- Storage -->
        <div class="p-5 transition-shadow border border-gray-200 shadow-sm bg-gray-50 rounded-xl dark:bg-gray-900 dark:border-gray-700 hover:shadow-md">
          <div class="flex items-start justify-between mb-4">
            <div class="text-sm font-medium text-gray-500 dark:text-gray-400">
              {{ t('Storage') }}
            </div>
            <div class="text-lg font-bold" :class="(planUsage?.detailPlanUsage?.storage_percent || 0) >= 100 ? 'text-red-600' : 'text-gray-900 dark:text-white'">
              {{ formatPercentValue(planUsage?.detailPlanUsage?.storage_percent) }}%
            </div>
          </div>
          <div class="w-full h-2 mb-4 overflow-hidden bg-gray-100 rounded-full dark:bg-gray-700">
            <div class="h-full transition-all duration-500 rounded-full" :class="(planUsage?.detailPlanUsage?.storage_percent || 0) >= 100 ? 'bg-red-500' : 'bg-purple-500'" :style="{ width: `${Math.min(planUsage?.detailPlanUsage?.storage_percent || 0, 100)}%` }" />
          </div>
          <div class="space-y-1 text-sm">
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('used-in-period') }}</span>
              <span class="font-medium text-gray-900 dark:text-white">{{ formatNumberValue(planUsage?.totalStorage) }} GB</span>
            </div>
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('included-in-plan') }}</span>
              <span>{{ formatNumberValue(planUsage?.currentPlan?.storage) }} GB</span>
            </div>
          </div>
        </div>

        <!-- Bandwidth -->
        <div class="p-5 transition-shadow border border-gray-200 shadow-sm bg-gray-50 rounded-xl dark:bg-gray-900 dark:border-gray-700 hover:shadow-md">
          <div class="flex items-start justify-between mb-4">
            <div class="text-sm font-medium text-gray-500 dark:text-gray-400">
              {{ t('Bandwidth') }}
            </div>
            <div class="text-lg font-bold" :class="(planUsage?.detailPlanUsage?.bandwidth_percent || 0) >= 100 ? 'text-red-600' : 'text-gray-900 dark:text-white'">
              {{ formatPercentValue(planUsage?.detailPlanUsage?.bandwidth_percent) }}%
            </div>
          </div>
          <div class="w-full h-2 mb-4 overflow-hidden bg-gray-100 rounded-full dark:bg-gray-700">
            <div class="h-full transition-all duration-500 rounded-full" :class="(planUsage?.detailPlanUsage?.bandwidth_percent || 0) >= 100 ? 'bg-red-500' : 'bg-green-500'" :style="{ width: `${Math.min(planUsage?.detailPlanUsage?.bandwidth_percent || 0, 100)}%` }" />
          </div>
          <div class="space-y-1 text-sm">
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('used-in-period') }}</span>
              <span class="font-medium text-gray-900 dark:text-white">{{ formatNumberValue(planUsage?.totalBandwidth) }} GB</span>
            </div>
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('included-in-plan') }}</span>
              <span>{{ formatNumberValue(planUsage?.currentPlan?.bandwidth) }} GB</span>
            </div>
          </div>
        </div>

        <!-- Build Time -->
        <div class="p-5 transition-shadow border border-gray-200 shadow-sm bg-gray-50 rounded-xl dark:bg-gray-900 dark:border-gray-700 hover:shadow-md">
          <div class="flex items-start justify-between mb-4">
            <div class="text-sm font-medium text-gray-500 dark:text-gray-400">
              {{ t('build-time') }}
            </div>
            <div class="text-lg font-bold" :class="(planUsage?.detailPlanUsage?.build_time_percent || 0) >= 100 ? 'text-red-600' : 'text-gray-900 dark:text-white'">
              {{ formatPercentValue(planUsage?.detailPlanUsage?.build_time_percent) }}%
            </div>
          </div>
          <div class="w-full h-2 mb-4 overflow-hidden bg-gray-100 rounded-full dark:bg-gray-700">
            <div class="h-full transition-all duration-500 rounded-full" :class="(planUsage?.detailPlanUsage?.build_time_percent || 0) >= 100 ? 'bg-red-500' : 'bg-orange-500'" :style="{ width: `${Math.min(planUsage?.detailPlanUsage?.build_time_percent || 0, 100)}%` }" />
          </div>
          <div class="space-y-1 text-sm">
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('used-in-period') }}</span>
              <span class="font-medium text-gray-900 dark:text-white">{{ formatBuildTime(planUsage?.totalBuildTime || 0) }}</span>
            </div>
            <div class="flex justify-between text-gray-600 dark:text-gray-400">
              <span>{{ t('included-in-plan') }}</span>
              <span>{{ formatBuildTime(planUsage?.currentPlan?.build_time_unit || 0) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Loading State -->
    <PageLoader v-else :label="t('loading')" />

    <!-- Teleport for Detailed Usage Plan Dialog -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('detailed-usage-plan')" defer to="#dialog-v2-content">
      <div class="space-y-4">
        <div class="text-sm">
          <div class="mb-2 font-medium text-gray-900 dark:text-white">
            {{ t('billing-cycle') }} {{ planUsage?.cycle.subscription_anchor_start }} {{ t('to') }} {{ planUsage?.cycle.subscription_anchor_end }}
          </div>

          <div class="mb-3 font-medium text-gray-900 dark:text-white">
            {{ t('your-usage') }}
          </div>

          <div class="space-y-2 text-gray-600 dark:text-gray-400">
            <div class="flex justify-between">
              <span>{{ t('mau-usage') }}</span>
              <span class="font-medium">{{ formatPercentValue(planUsage?.detailPlanUsage?.mau_percent) }}%</span>
            </div>
            <div class="flex justify-between">
              <span>{{ t('bandwidth-usage') }}</span>
              <span class="font-medium">{{ formatPercentValue(planUsage?.detailPlanUsage?.bandwidth_percent) }}%</span>
            </div>
            <div class="flex justify-between">
              <span>{{ t('storage-usage') }}</span>
              <span class="font-medium">{{ formatPercentValue(planUsage?.detailPlanUsage?.storage_percent) }}%</span>
            </div>
            <div class="flex justify-between">
              <span>{{ t('build-time-usage') }}</span>
              <span class="font-medium">{{ formatPercentValue(planUsage?.detailPlanUsage?.build_time_percent) }}%</span>
            </div>
          </div>

          <div class="pt-3 mt-4 text-xs text-gray-500 whitespace-pre-line border-t border-gray-200 dark:text-gray-400 dark:border-gray-600">
            {{ lastRunDate() }} {{ nextRunDate() }}
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
        </route>
