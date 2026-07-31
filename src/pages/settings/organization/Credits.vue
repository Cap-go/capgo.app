<script setup lang="ts">
import type { CreditMetricType, CreditPricingStep } from '~/services/creditPricing'
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ArchiveBoxIcon from '~icons/heroicons/archive-box'
import BanknotesIcon from '~icons/heroicons/banknotes'
import ChevronDownIcon from '~icons/heroicons/chevron-down'
import CloudIcon from '~icons/heroicons/cloud'
import ScaleIcon from '~icons/heroicons/scale'
import UserGroupIcon from '~icons/heroicons/user-group'
import RbacPermissionOnlyModal from '~/components/RbacPermissionOnlyModal.vue'
import { creditPricingMetricOrder, formatCreditPricingPrice, formatCreditPricingTierLabel } from '~/services/creditPricing'
import { formatLocalDate } from '~/services/date'
import { formatNumber, formatNumberValue } from '~/services/formatLocale'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { completeCreditTopUp, startCreditTopUp } from '~/services/stripe'
import { getCreditPricingSteps, useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

interface UsageCreditLedgerRow {
  id: number
  org_id: string
  transaction_type: Database['public']['Enums']['credit_transaction_type']
  amount: number
  balance_after: number | null
  occurred_at: string
  description: string | null
  source_ref: Record<string, any> | null
  overage_event_id: string | null
  metric: Database['public']['Enums']['credit_metric_type'] | null
  overage_amount: number | null
  billing_cycle_start: string | null
  billing_cycle_end: string | null
  grant_allocations: any | null
  details: any | null
}

interface DailyLedgerRow {
  dateKey: string
  dateLabel: string
  transactionCount: number
  amountTotal: number
  positiveTotal: number
  negativeTotal: number
  latestBalance: number | null
  typeCounts: Record<Database['public']['Enums']['credit_transaction_type'], number>
  grantsTotal: number
  grantsCount: number
  deductionsTotal: number
  deductionsCount: number
  deductionsByMetric: Partial<Record<Database['public']['Enums']['credit_metric_type'], { total: number, count: number }>>
}

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)
const displayStore = useDisplayStore()
const isMobile = isNativeAppStoreContext()

// Modal state for non-admin access
const showAdminModal = ref(false)

const transactions = ref<UsageCreditLedgerRow[]>([])
const pricingSteps = ref<CreditPricingStep[]>([])
const isLoadingTransactions = ref(false)
const loadError = ref<string | null>(null)
const creditUsdRate = ref(1)
const isStartingCheckout = ref(false)
const isCompletingTopUp = ref(false)
const isProcessingCheckout = computed(() => isStartingCheckout.value || isCompletingTopUp.value)
const currentPage = ref(1)
const pageSize = 5
const CREDIT_PRICING_HASH = '#credit-pricing'
const isCreditPricingOpen = ref(route.hash === CREDIT_PRICING_HASH)
const DEFAULT_TOP_UP_QUANTITY = 100
const QUICK_TOP_UP_OPTIONS = [50, 500, 5000] as const
const CREDIT_TAX_MULTIPLIER = 1.2
const topUpQuantityInput = ref(String(DEFAULT_TOP_UP_QUANTITY))
const topUpQuantity = computed(() => {
  const parsed = Number.parseInt(topUpQuantityInput.value, 10)
  if (Number.isNaN(parsed) || parsed <= 0)
    return null
  return parsed
})
const isTopUpQuantityValid = computed(() => topUpQuantity.value !== null)
const topUpQuantityUsd = computed(() => (topUpQuantity.value ?? 0) * creditUsdRate.value * CREDIT_TAX_MULTIPLIER)

const creditTotal = computed(() => Number(currentOrganization.value?.credit_total ?? 0))
const creditAvailable = computed(() => Number(currentOrganization.value?.credit_available ?? 0))
const creditUsed = computed(() => Math.max(creditTotal.value - creditAvailable.value, 0))
const creditUsagePercent = computed(() => {
  if (creditTotal.value <= 0)
    return 0
  return Math.min(100, Math.round((creditUsed.value / creditTotal.value) * 100))
})
const creditNextExpiration = computed(() => {
  const expiresAt = currentOrganization.value?.credit_next_expiration
  return expiresAt ? formatLocalDate(expiresAt) || null : null
})
const hasCreditSummary = computed(() => creditTotal.value > 0 || creditAvailable.value > 0)

const creditUsedUsd = computed(() => creditUsed.value * creditUsdRate.value)
const creditsAvailableUsd = computed(() => creditAvailable.value * creditUsdRate.value)

const creditPricingSectionsMeta: Record<CreditMetricType, {
  icon: typeof UserGroupIcon
  titleKey: string
  subtitleKey: string
  accentClass: string
}> = {
  mau: {
    icon: UserGroupIcon,
    titleKey: 'credits-pricing-mau-title',
    subtitleKey: 'credits-pricing-mau-subtitle',
    accentClass: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300',
  },
  bandwidth: {
    icon: CloudIcon,
    titleKey: 'credits-pricing-bandwidth-title',
    subtitleKey: 'credits-pricing-bandwidth-subtitle',
    accentClass: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-300',
  },
  storage: {
    icon: ArchiveBoxIcon,
    titleKey: 'credits-pricing-storage-title',
    subtitleKey: 'credits-pricing-storage-subtitle',
    accentClass: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300',
  },
  build_time: {
    icon: ScaleIcon,
    titleKey: 'credits-pricing-build-title',
    subtitleKey: 'credits-pricing-build-subtitle',
    accentClass: 'bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-300',
  },
}

const creditPricingSections = computed(() =>
  creditPricingMetricOrder.flatMap((metric) => {
    const meta = creditPricingSectionsMeta[metric]
    const tiers = pricingSteps.value
      .filter(step => step.type === metric)
      .map(step => ({
        label: formatCreditPricingTierLabel(step, t),
        price: formatCreditPricingPrice(metric, step.price_per_unit, t),
      }))

    if (!tiers.length)
      return []

    return [{
      icon: meta.icon,
      accentClass: meta.accentClass,
      title: t(meta.titleKey),
      subtitle: t(meta.subtitleKey),
      tiers,
    }]
  }),
)

const creditPricingFootnote = computed(() => t('credits-pricing-footnote'))
const creditPricingDisclaimer = computed(() => t('credits-pricing-disclaimer'))

function formatCredits(value: number) {
  return formatNumberValue(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatCurrency(value: number) {
  return formatNumber(value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatMetricAmount(metric: Database['public']['Enums']['credit_metric_type'], value: number) {
  // Apply ceil to round up the metric value
  const ceiledValue = Math.ceil(value)
  switch (metric) {
    case 'mau':
      return `${formatNumberValue(ceiledValue, { maximumFractionDigits: 0 })} ${t('users')}`
    case 'bandwidth':
    case 'storage': {
      // Convert bytes to GiB (1 GiB = 1073741824 bytes) and round up to match pricing
      const gib = Math.ceil(ceiledValue / 1073741824)
      return `${formatNumberValue(gib, { maximumFractionDigits: 0 })} GiB`
    }
    case 'build_time': {
      // ceiledValue is in seconds: computeUsageFromCredits inverts the SQL pricing
      // formula (credits = ceil(seconds / unit_factor) * price_per_unit) where
      // unit_factor = 60, so the inverse hands back raw seconds. Convert to hours
      // when >= 1h, otherwise show whole minutes (rounded up to match billing).
      if (ceiledValue >= 3600) {
        const hours = formatNumberValue(ceiledValue / 3600, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        return t('x-hours-short', { hours })
      }
      const minutes = formatNumberValue(Math.ceil(ceiledValue / 60), { maximumFractionDigits: 0 })
      return t('minutes-short', { minutes })
    }
    default:
      return formatNumberValue(ceiledValue, { maximumFractionDigits: 2 })
  }
}

function selectTopUpQuantity(amount: number) {
  topUpQuantityInput.value = String(amount)
}

function transactionLabel(type: Database['public']['Enums']['credit_transaction_type']) {
  switch (type) {
    case 'grant':
      return t('credit-transaction-grant')
    case 'purchase':
      return t('credit-transaction-purchase')
    case 'manual_grant':
      return t('credit-transaction-manual_grant')
    case 'deduction':
      return t('credit-transaction-deduction')
    case 'expiry':
      return t('credit-transaction-expiry')
    case 'refund':
      return t('credit-transaction-refund')
    default:
      return type
  }
}

function metricLabel(metric: Database['public']['Enums']['credit_metric_type']) {
  switch (metric) {
    case 'mau':
      return 'MAU'
    case 'bandwidth':
      return t('Bandwidth') || 'Bandwidth'
    case 'storage':
      return t('Storage') || 'Storage'
    case 'build_time':
      return t('build-time') || 'Build time'
    default:
      return metric
  }
}

function summarizeTypes(typeCounts: Record<Database['public']['Enums']['credit_transaction_type'], number>) {
  const entries = Object.entries(typeCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${transactionLabel(type as Database['public']['Enums']['credit_transaction_type'])} ×${formatNumberValue(count)}`)
  return entries.join(' • ') || '—'
}

const dailyTransactions = computed<DailyLedgerRow[]>(() => {
  const groups = new Map<string, DailyLedgerRow>()
  for (const tx of transactions.value) {
    const dateKey = tx.occurred_at.slice(0, 10)
    const dateLabel = formatLocalDate(tx.occurred_at) || dateKey
    const existing = groups.get(dateKey)
    if (!existing) {
      const initial: DailyLedgerRow = {
        dateKey,
        dateLabel,
        transactionCount: 1,
        amountTotal: tx.amount ?? 0,
        positiveTotal: tx.amount >= 0 ? tx.amount : 0,
        negativeTotal: tx.amount < 0 ? tx.amount : 0,
        latestBalance: tx.balance_after,
        typeCounts: {
          grant: 0,
          purchase: 0,
          manual_grant: 0,
          deduction: 0,
          expiry: 0,
          refund: 0,
        },
        grantsTotal: tx.amount >= 0 ? tx.amount : 0,
        grantsCount: tx.amount >= 0 ? 1 : 0,
        deductionsTotal: tx.amount < 0 ? tx.amount : 0,
        deductionsCount: tx.amount < 0 ? 1 : 0,
        deductionsByMetric: {},
      }

      initial.typeCounts[tx.transaction_type as Database['public']['Enums']['credit_transaction_type']] = (initial.typeCounts[tx.transaction_type as Database['public']['Enums']['credit_transaction_type']] ?? 0) + 1
      if (tx.transaction_type === 'deduction' && tx.metric) {
        initial.deductionsByMetric[tx.metric as Database['public']['Enums']['credit_metric_type']] = {
          total: tx.amount,
          count: 1,
        }
      }
      groups.set(dateKey, initial)
    }
    else {
      existing.transactionCount += 1
      existing.amountTotal += tx.amount ?? 0
      if (tx.amount >= 0) {
        existing.positiveTotal += tx.amount
        existing.grantsTotal += tx.amount
        existing.grantsCount += 1
      }
      else {
        existing.negativeTotal += tx.amount
        existing.deductionsTotal += tx.amount
        existing.deductionsCount += 1
        if (tx.transaction_type === 'deduction' && tx.metric) {
          const metricEntry = existing.deductionsByMetric[tx.metric as Database['public']['Enums']['credit_metric_type']] ?? { total: 0, count: 0 }
          metricEntry.total += tx.amount
          metricEntry.count += 1
          existing.deductionsByMetric[tx.metric as Database['public']['Enums']['credit_metric_type']] = metricEntry
        }
      }
      if (existing.latestBalance === null)
        existing.latestBalance = tx.balance_after
      existing.typeCounts[tx.transaction_type as Database['public']['Enums']['credit_transaction_type']] = (existing.typeCounts[tx.transaction_type as Database['public']['Enums']['credit_transaction_type']] ?? 0) + 1
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey))
})

const totalPages = computed(() => Math.max(1, Math.ceil(dailyTransactions.value.length / pageSize)))

const paginatedDailyTransactions = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  const end = start + pageSize
  return dailyTransactions.value.slice(start, end)
})

// Compute estimated usage from credits consumed using first-tier pricing
// This is an approximation since actual pricing is tiered, but gives a reasonable estimate
function computeUsageFromCredits(metric: Database['public']['Enums']['credit_metric_type'], credits: number): number {
  // Find first-tier pricing for this metric (lowest step_min)
  const step = pricingSteps.value.find(s => s.type === metric)
  if (!step || step.price_per_unit <= 0)
    return 0

  // credits is negative for deductions, so we use Math.abs
  // Formula: usage = (credits / price_per_unit) * unit_factor
  return (Math.abs(credits) / step.price_per_unit) * step.unit_factor
}

function metricsWithData(day: DailyLedgerRow) {
  const entries = Object.entries(day.deductionsByMetric || {})
    .filter(([, info]) => info && info.count > 0)
    .map(([metric, info]) => ({
      metric: metric as Database['public']['Enums']['credit_metric_type'],
      data: info!,
    }))

  // Keep preferred order, then fall back to original
  return entries.sort((a, b) => {
    const aIdx = creditPricingMetricOrder.indexOf(a.metric)
    const bIdx = creditPricingMetricOrder.indexOf(b.metric)
    if (aIdx === -1 && bIdx === -1)
      return a.metric.localeCompare(b.metric)
    if (aIdx === -1)
      return 1
    if (bIdx === -1)
      return -1
    return aIdx - bIdx
  })
}

async function loadTransactions() {
  const orgId = currentOrganization.value?.gid
  if (!orgId) {
    transactions.value = []
    return
  }

  isLoadingTransactions.value = true
  loadError.value = null

  const { data, error } = await supabase
    .from('usage_credit_ledger')
    .select('*')
    .eq('org_id', orgId)
    .order('occurred_at', { ascending: false })

  if (error) {
    console.error('Failed to load usage credit ledger entries', error)
    loadError.value = error.message
    transactions.value = []
  }
  else {
    transactions.value = (data ?? []) as UsageCreditLedgerRow[]
    currentPage.value = 1
  }

  isLoadingTransactions.value = false
}

async function loadPricingSteps() {
  pricingSteps.value = await getCreditPricingSteps(currentOrganization.value?.gid)
}

// Returns true when the current user can manage billing for the current org.
// Otherwise shows the permission modal; used to gate both the page and the buy action.
async function ensureBillingAccess() {
  const orgId = currentOrganization.value?.gid
  if (orgId && await checkPermissions('org.update_billing', { orgId }))
    return true
  showAdminModal.value = true
  return false
}

async function handleBuyCredits() {
  if (!(await ensureBillingAccess()))
    return
  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return
  if (!isTopUpQuantityValid.value || topUpQuantity.value === null) {
    toast.error(t('credits-top-up-quantity-invalid'))
    return
  }
  try {
    isStartingCheckout.value = true
    await startCreditTopUp(orgId, topUpQuantity.value)
  }
  catch (error) {
    console.error('Failed to initiate credit checkout', error)
  }
  finally {
    isStartingCheckout.value = false
  }
}

function handleCreditPricingToggle(event: Event) {
  isCreditPricingOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

async function handleCreditCheckoutReturn() {
  if (isCompletingTopUp.value)
    return
  const checkoutStatusRaw = route.query.creditCheckout
  const checkoutStatus = Array.isArray(checkoutStatusRaw) ? checkoutStatusRaw[0] : checkoutStatusRaw
  if (!checkoutStatus) {
    return
  }

  const newQuery = { ...route.query }
  if (checkoutStatus !== 'success') {
    delete newQuery.creditCheckout
    delete newQuery.session_id
    await router.replace({ query: newQuery })
    return
  }
  const sessionIdRaw = route.query.session_id
  const sessionIdParam = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw
  // Stripe may append unexpected query fragments after the session id; keep only the valid prefix.
  const sessionId = typeof sessionIdParam === 'string'
    ? (sessionIdParam.match(/^cs_[\w-]+/)?.[0] ?? null)
    : null
  if (!currentOrganization.value?.gid)
    return

  isCompletingTopUp.value = true
  try {
    await completeCreditTopUp(currentOrganization.value.gid, sessionId)
    toast.success(t('credits-top-up-success'))
    const orgId = currentOrganization.value?.gid
    await organizationStore.fetchOrganizations()
    if (orgId)
      organizationStore.setCurrentOrganization(orgId)
    await Promise.allSettled([loadTransactions()])
  }
  catch (error) {
    console.error('Failed to finalize credit top-up', error)
  }
  finally {
    isCompletingTopUp.value = false
    delete newQuery.creditCheckout
    delete newQuery.session_id
    await router.replace({ query: newQuery })
  }
}

watch(() => route.hash, (hash) => {
  if (hash === CREDIT_PRICING_HASH)
    isCreditPricingOpen.value = true
})

onMounted(async () => {
  if (isMobile) {
    await router.replace('/settings/organization/usage')
    return
  }

  displayStore.NavTitle = t('credits')
  await organizationStore.awaitInitialLoad()
  if (!(await ensureBillingAccess()))
    return
  await Promise.allSettled([loadTransactions(), loadPricingSteps()])
  await handleCreditCheckoutReturn()
})

watch(() => currentOrganization.value?.gid, async (newOrgId: string | undefined, oldOrgId: string | undefined) => {
  if (isMobile)
    return

  if (!newOrgId || newOrgId === oldOrgId)
    return
  if (!(await ensureBillingAccess()))
    return
  await Promise.allSettled([loadTransactions(), loadPricingSteps()])
  await handleCreditCheckoutReturn()
})
</script>

<template>
  <div class="space-y-8 px-4 pt-6 pb-6 mx-auto max-w-7xl lg:px-8 sm:px-6">
    <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div class="flex h-full flex-col justify-between rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <ScaleIcon class="h-4 w-4" />
              {{ t('credits-balance') }}
            </div>
            <div class="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">
              {{ formatCredits(creditAvailable) }} <span class="font-medium text-gray-900 dark:text-white">/ {{ formatCredits(creditTotal) }}</span>
            </div>
            <p class="text-sm text-gray-500 dark:text-gray-400">
              {{ t('credits-available') }}
            </p>
          </div>
          <div v-if="creditNextExpiration" class="text-right">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {{ t('credits-next-expiration') }}
            </div>
            <div class="mt-1 text-sm font-medium text-gray-900 dark:text-white">
              {{ creditNextExpiration }}
            </div>
          </div>
        </div>
        <div class="mt-6">
          <div class="mb-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>{{ t('credits-used-in-period') }}</span>
            <span class="font-medium text-gray-900 dark:text-white">{{ formatCredits(creditUsed) }}</span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-all duration-300"
              :style="{ width: `${creditUsagePercent}%` }"
            />
          </div>
          <p v-if="!hasCreditSummary" class="mt-4 text-sm text-gray-500 dark:text-gray-400">
            {{ t('no-credits-available') }}
          </p>
        </div>
      </div>

      <div class="flex h-full flex-col justify-between rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div>
          <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <BanknotesIcon class="h-4 w-4" />
            {{ t('credits-used-dollars') }}
          </div>
          <div class="mt-3 text-3xl font-semibold text-gray-900 dark:text-white">
            {{ formatCurrency(creditUsedUsd) }}
          </div>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {{ t('credits-used-dollars-description') }}
          </p>
        </div>
        <div class="mt-6">
          <div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>{{ t('credits-available') }}</span>
            <span class="font-medium text-gray-900 dark:text-white">
              {{ formatCurrency(creditsAvailableUsd) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="rounded-3xl border border-blue-500 p-6 text-white shadow-lg">
      <div class="flex flex-col items-start justify-between gap-6 sm:flex-col sm:items-start">
        <div class="max-w-xl">
          <h3 class="text-2xl font-semibold text-gray-900 dark:text-white">
            {{ t('credits-cta-title') }}
          </h3>
          <p class="mt-2 max-w-xl text-sm opacity-90 font-medium text-gray-900 dark:text-white">
            {{ t('credits-cta-description') }}
          </p>
        </div>
        <form class="flex w-full flex-col p-3 sm:flex-row sm:items-center sm:justify-between" @submit.prevent="handleBuyCredits">
          <div class="flex w-full flex-col gap-3 sm:max-w-md">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div class="relative w-full sm:flex-1">
                <FormKit
                  v-model="topUpQuantityInput"
                  type="number"
                  name="creditsTopUpQuantity"
                  data-test="credits-top-up-quantity"
                  inputmode="numeric"
                  min="1"
                  step="1"
                  :placeholder="`${DEFAULT_TOP_UP_QUANTITY}`"
                  :label="t('credits-top-up-quantity-label')"
                  validation="required|min:1"
                  validation-visibility="live"
                  outer-class="w-full !mb-0"
                  label-class="text-xs font-semibold uppercase tracking-wide"
                  help-class="hidden"
                  message-class="text-xs text-rose-200 mt-1"
                >
                  <template #prefix>
                    $
                  </template>
                </FormKit>
              </div>
              <div class="grid grid-cols-3 gap-2 sm:flex sm:shrink-0 sm:items-end">
                <button
                  v-for="amount in QUICK_TOP_UP_OPTIONS"
                  :key="amount"
                  type="button"
                  class="d-btn d-btn-sm h-11 min-w-0 sm:min-w-[4.25rem]"
                  :class="topUpQuantity === amount
                    ? 'border border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700 dark:border-blue-500 dark:bg-blue-500 dark:hover:border-blue-400 dark:hover:bg-blue-500/90'
                    : 'border border-blue-200 bg-white text-blue-700 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/60 dark:bg-gray-900 dark:text-blue-200 dark:hover:border-blue-400 dark:hover:bg-blue-900/40'"
                  @click="selectTopUpQuantity(amount)"
                >
                  ${{ amount }}
                </button>
              </div>
            </div>
            <button
              type="submit"
              data-test="credits-top-up-submit"
              :disabled="isProcessingCheckout || !isTopUpQuantityValid"
              :class="{ 'opacity-75 pointer-events-none': isProcessingCheckout || !isTopUpQuantityValid }"
              class="inline-flex w-full justify-center items-center py-2 px-3 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white text-sm font-semibold rounded-lg transition-all duration-200 shadow-md hover:shadow-lg transform hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed sm:w-auto"
            >
              <Spinner v-if="isProcessingCheckout" size="w-4 h-4" class="mr-2" color="white" />
              <span>{{ t('buy-credits') }}</span>
            </button>
            <div class="text-xs opacity-90 space-y-1 font-medium text-gray-900 dark:text-white">
              <p>
                {{ t('credits-top-up-quantity-help') }}
              </p>
              <p class="font-medium">
                {{ t('credits-top-up-total-estimate', { amount: formatCurrency(topUpQuantityUsd) }) }}
              </p>
            </div>
          </div>
        </form>
      </div>
    </div>

    <details id="credit-pricing" class="group rounded-3xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800" :open="isCreditPricingOpen" @toggle="handleCreditPricingToggle">
      <summary class="flex w-full cursor-pointer items-center justify-between gap-4 p-6 text-left [&::-webkit-details-marker]:hidden">
        <div>
          <h2 class="text-2xl font-semibold text-gray-900 dark:text-white">
            {{ t('credits-pricing-title') }}
          </h2>
          <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
            {{ t('credits-pricing-description') }}
          </p>
        </div>
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-700 transition-transform duration-200 dark:bg-blue-900/40 dark:text-blue-200">
          <ChevronDownIcon class="h-5 w-5 transition-transform duration-200 group-open:rotate-180" />
        </div>
      </summary>
      <div class="space-y-8 border-t border-gray-200 p-6 lg:p-8 dark:border-gray-700">
        <div class="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          <div
            v-for="section in creditPricingSections"
            :key="section.title"
            class="flex h-full flex-col rounded-2xl border border-gray-200 bg-gray-50 p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900/40"
          >
            <div class="flex items-start gap-3">
              <div class="flex h-10 w-20 items-center justify-center rounded-full" :class="section.accentClass">
                <component :is="section.icon" class="h-5 w-5" />
              </div>
              <div>
                <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
                  {{ section.title }}
                </h3>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  {{ section.subtitle }}
                </p>
              </div>
            </div>
            <dl class="mt-6 flex-1 space-y-3">
              <div
                v-for="tier in section.tiers"
                :key="tier.label"
                class="flex items-baseline justify-between rounded-lg bg-white px-4 py-3 text-sm text-gray-600 shadow-sm dark:bg-gray-900/60 dark:text-gray-300"
              >
                <dt class="font-medium text-gray-700 dark:text-gray-200">
                  {{ tier.label }}
                </dt>
                <dd class="font-semibold text-gray-900 dark:text-white">
                  {{ tier.price }}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div class="space-y-2 text-center text-xs text-gray-500 dark:text-gray-400">
          <p>
            {{ creditPricingFootnote }}
          </p>
          <p>
            {{ creditPricingDisclaimer }}
          </p>
        </div>
      </div>
    </details>
    <div class="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
          {{ t('credits-transactions') }}
        </h2>
      </div>
      <div>
        <div v-if="loadError" class="rounded-lg border border-red-200 bg-red-50 p-4 m-8 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
          {{ t('credits-load-error') }}
        </div>
        <div v-else-if="isLoadingTransactions" class="flex items-center justify-center py-12">
          <Spinner size="w-6 h-6" class="text-blue-500" />
        </div>
        <div v-else-if="transactions.length === 0" class="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
          {{ t('credits-empty-state') }}
        </div>
        <div v-else class="-mx-4 overflow-x-auto sm:mx-0">
          <table class="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
            <thead class="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th scope="col" class="px-4 py-3">
                  {{ t('credit-transaction-occurred-at') }}
                </th>
                <th scope="col" class="px-4 py-3">
                  {{ t('credit-transaction-description') }}
                </th>
                <th scope="col" class="px-4 py-3 text-right">
                  {{ t('credit-transaction-amount') }}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <template v-for="day in paginatedDailyTransactions" :key="day.dateKey">
                <tr class="bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-white">
                  <td class="px-4 py-3 font-semibold">
                    {{ day.dateLabel }}
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-700 dark:text-gray-200">
                    {{ t('credits-daily-transaction-count', { count: day.transactionCount }) }} • {{ summarizeTypes(day.typeCounts) }}
                  </td>
                  <td class="px-4 py-3 text-right font-semibold text-gray-900 dark:text-white">
                    <div class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {{ t('credits-daily-balance-label') }}
                    </div>
                    <div>
                      {{ day.latestBalance !== null ? formatCredits(day.latestBalance) : '—' }}
                    </div>
                  </td>
                </tr>
                <tr
                  v-if="day.grantsCount > 0"
                  :key="`${day.dateKey}-grants`"
                  class="transition hover:bg-gray-50 dark:hover:bg-gray-700/60"
                >
                  <td class="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-200">
                    {{ day.dateLabel }}
                  </td>
                  <td class="px-4 py-3 text-gray-700 dark:text-gray-200">
                    <div class="font-semibold text-gray-900 dark:text-white">
                      {{ t('credits-daily-grants-purchases') }}
                    </div>
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 text-right font-semibold text-emerald-600 dark:text-emerald-400"
                  >
                    +{{ formatCredits(day.grantsTotal) }}
                  </td>
                </tr>
                <tr
                  v-for="(entry) in metricsWithData(day)"
                  :key="`${day.dateKey}-${entry.metric}`"
                  class="transition hover:bg-gray-50 dark:hover:bg-gray-700/60"
                >
                  <td class="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-200">
                    {{ day.dateLabel }}
                  </td>
                  <td class="px-4 py-3 text-gray-700 dark:text-gray-200">
                    <div class="font-semibold text-gray-900 dark:text-white">
                      {{ t('credits-daily-deduction-title', { metric: metricLabel(entry.metric) }) }}
                    </div>
                    <div class="text-xs text-gray-500 dark:text-gray-400">
                      {{ t('credits-daily-deduction-count', { count: entry.data?.count ?? 0 }) }}
                      <span v-if="entry.data?.total && pricingSteps.length > 0" class="ml-2 inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                        ~{{ formatMetricAmount(entry.metric, computeUsageFromCredits(entry.metric, entry.data.total)) }}
                      </span>
                    </div>
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 text-right font-semibold text-rose-500 dark:text-rose-400"
                  >
                    -{{ formatCredits(Math.abs(entry.data?.total ?? 0)) }}
                  </td>
                </tr>
                <tr
                  v-if="day.grantsCount === 0 && metricsWithData(day).length === 0"
                  :key="`${day.dateKey}-empty`"
                  class="transition hover:bg-gray-50 dark:hover:bg-gray-700/60"
                >
                  <td class="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-200">
                    {{ day.dateLabel }}
                  </td>
                  <td class="px-4 py-3 text-gray-700 dark:text-gray-200">
                    <div class="text-sm text-gray-600 dark:text-gray-300">
                      {{ t('credits-daily-no-activity') }}
                    </div>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-right font-semibold text-gray-700 dark:text-gray-200">
                    0.00
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div class="mt-4 flex items-center justify-between px-6 py-4 text-sm">
            <span>
              {{ t('credits-pagination-label', { current: currentPage, total: totalPages }) }}
            </span>
            <div class="flex items-center gap-2">
              <button
                class="d-btn d-btn-sm"
                :disabled="currentPage === 1"
                @click="currentPage = Math.max(1, currentPage - 1)"
              >
                {{ t('previous') }}
              </button>
              <button
                class="d-btn d-btn-sm"
                :disabled="currentPage >= totalPages"
                @click="currentPage = Math.min(totalPages, currentPage + 1)"
              >
                {{ t('next') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Permission modal shown when the user can't manage billing -->
    <RbacPermissionOnlyModal
      v-if="showAdminModal"
      :title="t('billing-access-required')"
      permission="org.update_billing"
      @click="showAdminModal = false"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
