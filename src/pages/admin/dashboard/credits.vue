<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { FormKit } from '@formkit/vue'
import dayjs from 'dayjs'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import MagnifyingGlassIcon from '~icons/heroicons/magnifying-glass'
import XMarkIcon from '~icons/heroicons/x-mark'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import Spinner from '~/components/Spinner.vue'
import { formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

interface OrgSearchResult {
  id: string
  name: string
  management_email: string
  created_at: string
}

interface OrgBalance {
  total_credits: number
  available_credits: number
  next_expiration: string | null
}

interface AdminGrant {
  id: string
  org_id: string
  credits_total: number
  notes: string | null
  source_ref: {
    admin_user_id?: string
    granted_via?: string
    org_name?: string
  } | null
  granted_at: string
  expires_at: string
  orgs: {
    name: string
    management_email: string
  }
}

interface GlobalStatsTrendRow {
  date: string
  mrr: number
  credits_bought: number
  credits_consumed: number
}

const { t } = useI18n()
const router = useRouter()
const mainStore = useMainStore()
const displayStore = useDisplayStore()
const adminStore = useAdminDashboardStore()
const supabase = useSupabase()

const searchQuery = ref('')
const searchResults = ref<OrgSearchResult[]>([])
const isSearching = ref(false)
const selectedOrg = ref<OrgSearchResult | null>(null)
const orgBalance = ref<OrgBalance | null>(null)
const isLoadingBalance = ref(false)

const creditAmountStr = ref('100')
const creditNotes = ref('')
const expiresInMonthsStr = ref('12')
const isGranting = ref(false)

const creditAmount = computed(() => {
  const parsed = Number.parseInt(creditAmountStr.value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
})

const expiresInMonths = computed(() => {
  const parsed = Number.parseInt(expiresInMonthsStr.value, 10)
  return Number.isNaN(parsed) ? 12 : parsed
})

const recentGrants = ref<AdminGrant[]>([])
const isLoadingGrants = ref(false)
const globalStatsTrendData = ref<GlobalStatsTrendRow[]>([])
const isLoadingCreditAnalytics = ref(false)

let searchDebounce: ReturnType<typeof setTimeout> | null = null
let creditAnalyticsRequestSeq = 0
let currentSearchQuery = '' // Track current query to avoid race conditions

function getExpiresAt() {
  if (expiresInMonths.value <= 0)
    return null
  return dayjs().add(expiresInMonths.value, 'month').toISOString()
}

function formatCredits(value: number) {
  return formatNumberValue(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function toMonthKey(date: string) {
  const month = dayjs(date).startOf('month')
  return `${month.year()}-${String(month.month() + 1).padStart(2, '0')}-01`
}

async function loadCreditAnalytics() {
  const requestSeq = ++creditAnalyticsRequestSeq
  isLoadingCreditAnalytics.value = true

  try {
    const data = await adminStore.fetchStats('global_stats_trend')
    if (requestSeq !== creditAnalyticsRequestSeq)
      return
    globalStatsTrendData.value = (data || []) as GlobalStatsTrendRow[]
  }
  catch (error) {
    if (requestSeq !== creditAnalyticsRequestSeq)
      return
    console.error('Credit analytics load error:', error)
    globalStatsTrendData.value = []
    toast.error(t('admin-credits-analytics-error'))
  }
  finally {
    if (requestSeq === creditAnalyticsRequestSeq)
      isLoadingCreditAnalytics.value = false
  }
}

const monthlyCreditSummary = computed(() => {
  const monthlyBuckets = new Map<string, {
    date: string
    creditsBought: number
    creditsConsumed: number
    monthEndMrr: number
  }>()

  for (const row of globalStatsTrendData.value) {
    const monthKey = toMonthKey(row.date)
    const current = monthlyBuckets.get(monthKey) ?? {
      date: monthKey,
      creditsBought: 0,
      creditsConsumed: 0,
      monthEndMrr: 0,
    }

    current.creditsBought += Number(row.credits_bought || 0)
    current.creditsConsumed += Number(row.credits_consumed || 0)
    current.monthEndMrr = Number(row.mrr || 0)
    monthlyBuckets.set(monthKey, current)
  }

  return Array.from(monthlyBuckets.values())
})

const periodCreditTotals = computed(() => {
  return globalStatsTrendData.value.reduce(
    (totals, row) => {
      totals.creditsBought += Number(row.credits_bought || 0)
      totals.creditsConsumed += Number(row.credits_consumed || 0)
      return totals
    },
    {
      creditsBought: 0,
      creditsConsumed: 0,
    },
  )
})

const dailyCreditsSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('admin-credits-analytics-series-bought'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: Number(item.credits_bought || 0),
      })),
      color: '#119eff',
    },
    {
      label: t('admin-credits-analytics-series-used'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: Number(item.credits_consumed || 0),
      })),
      color: '#ef4444',
    },
  ]
})

const monthlyCreditsSeries = computed(() => {
  if (monthlyCreditSummary.value.length === 0)
    return []

  return [
    {
      label: t('admin-credits-analytics-series-bought'),
      data: monthlyCreditSummary.value.map(item => ({
        date: item.date,
        value: item.creditsBought,
      })),
      color: '#119eff',
    },
    {
      label: t('admin-credits-analytics-series-used'),
      data: monthlyCreditSummary.value.map(item => ({
        date: item.date,
        value: item.creditsConsumed,
      })),
      color: '#ef4444',
    },
  ]
})

const monthlyRevenueWithCreditsSeries = computed(() => {
  if (monthlyCreditSummary.value.length === 0)
    return []

  return [
    {
      label: t('admin-credits-analytics-series-revenue'),
      data: monthlyCreditSummary.value.map(item => ({
        date: item.date,
        value: item.monthEndMrr + item.creditsBought,
      })),
      color: '#10b981',
    },
  ]
})

async function searchOrgs(query: string) {
  if (query.length < 2) {
    searchResults.value = []
    return
  }

  currentSearchQuery = query
  isSearching.value = true

  try {
    const { data } = await supabase.auth.getSession()
    const response = await fetch(`${defaultApiHost}/private/admin_credits/search-orgs?q=${encodeURIComponent(query)}`, {
      headers: {
        authorization: `Bearer ${data.session?.access_token}`,
      },
    })

    if (!response.ok) {
      throw new Error('Search failed')
    }

    const result = await response.json() as { orgs?: OrgSearchResult[] }
    // Only update results if this is still the current search query
    if (currentSearchQuery === query) {
      searchResults.value = result.orgs || []
    }
  }
  catch (error) {
    console.error('Search error:', error)
    if (currentSearchQuery === query) {
      searchResults.value = []
      toast.error(t('admin-credits-search-error'))
    }
  }
  finally {
    if (currentSearchQuery === query) {
      isSearching.value = false
    }
  }
}

function handleSearchInput() {
  if (searchDebounce)
    clearTimeout(searchDebounce)

  searchDebounce = setTimeout(() => {
    searchOrgs(searchQuery.value)
  }, 300)
}

async function selectOrg(org: OrgSearchResult) {
  selectedOrg.value = org
  searchQuery.value = ''
  searchResults.value = []
  await loadOrgBalance(org.id)
}

function clearSelectedOrg() {
  selectedOrg.value = null
  orgBalance.value = null
}

async function loadOrgBalance(orgId: string) {
  isLoadingBalance.value = true

  try {
    const { data } = await supabase.auth.getSession()
    const response = await fetch(`${defaultApiHost}/private/admin_credits/org-balance/${orgId}`, {
      headers: {
        authorization: `Bearer ${data.session?.access_token}`,
      },
    })

    if (!response.ok) {
      throw new Error('Failed to load balance')
    }

    const result = await response.json() as { balance?: OrgBalance }
    orgBalance.value = result.balance ?? null
  }
  catch (error) {
    console.error('Balance load error:', error)
    orgBalance.value = null
    toast.error(t('admin-credits-balance-error'))
  }
  finally {
    isLoadingBalance.value = false
  }
}

async function grantCredits() {
  if (!selectedOrg.value)
    return

  if (creditAmount.value < 1) {
    toast.error(t('admin-credits-amount-required'))
    return
  }

  isGranting.value = true

  try {
    const { data } = await supabase.auth.getSession()
    const response = await fetch(`${defaultApiHost}/private/admin_credits/grant`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${data.session?.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: selectedOrg.value.id,
        amount: creditAmount.value,
        notes: creditNotes.value || undefined,
        expires_at: getExpiresAt(),
      }),
    })

    if (!response.ok) {
      const errorData = await response.json() as { message?: string }
      throw new Error(errorData.message || 'Grant failed')
    }

    toast.success(t('admin-credits-grant-success', { amount: creditAmount.value, org: selectedOrg.value.name }))

    // Refresh balance and grants
    await Promise.all([
      loadOrgBalance(selectedOrg.value.id),
      loadRecentGrants(),
    ])

    // Reset form
    creditAmountStr.value = '100'
    creditNotes.value = ''
  }
  catch (error) {
    console.error('Grant error:', error)
    toast.error(t('admin-credits-grant-error'))
  }
  finally {
    isGranting.value = false
  }
}

async function loadRecentGrants() {
  isLoadingGrants.value = true

  try {
    const { data } = await supabase.auth.getSession()
    const response = await fetch(`${defaultApiHost}/private/admin_credits/grants-history`, {
      headers: {
        authorization: `Bearer ${data.session?.access_token}`,
      },
    })

    if (!response.ok) {
      throw new Error('Failed to load grants')
    }

    const result = await response.json() as { grants?: AdminGrant[] }
    recentGrants.value = result.grants || []
  }
  catch (error) {
    console.error('Grants load error:', error)
    recentGrants.value = []
    toast.error(t('admin-credits-grants-load-error'))
  }
  finally {
    isLoadingGrants.value = false
  }
}

watch(searchQuery, handleSearchInput)

watch(() => adminStore.activeDateRange, () => {
  loadCreditAnalytics()
}, { deep: true })

watch(() => adminStore.refreshTrigger, () => {
  loadCreditAnalytics()
})

onUnmounted(() => {
  if (searchDebounce) {
    clearTimeout(searchDebounce)
    searchDebounce = null
  }
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin credits')
    router.push('/dashboard')
    return
  }

  displayStore.NavTitle = t('admin-credits')
  displayStore.defaultBack = '/dashboard'
  await Promise.all([
    loadRecentGrants(),
    loadCreditAnalytics(),
  ])
})
</script>

<template>
  <div class="h-full pb-4 overflow-hidden">
    <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-6xl max-h-fit">
      <div class="space-y-8">
        <!-- Header -->
        <div>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white">
            {{ t('admin-credits-title') }}
          </h1>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin-credits-description') }}
          </p>
        </div>

        <div class="space-y-4">
          <div class="flex flex-col gap-2">
            <div>
              <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
                {{ t('admin-credits-analytics-title') }}
              </h2>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('admin-credits-analytics-description') }}
              </p>
            </div>
            <AdminFilterBar />
          </div>

          <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
            <AdminStatsCard
              :title="t('admin-credits-period-total-bought')"
              :value="formatCredits(periodCreditTotals.creditsBought)"
              :is-loading="isLoadingCreditAnalytics"
              color-class="text-[#119eff]"
              :subtitle="t('admin-credits-period-total-subtitle')"
            />
            <AdminStatsCard
              :title="t('admin-credits-period-total-used')"
              :value="formatCredits(periodCreditTotals.creditsConsumed)"
              :is-loading="isLoadingCreditAnalytics"
              color-class="text-red-500"
              :subtitle="t('admin-credits-period-total-subtitle')"
            />
          </div>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              :title="t('admin-credits-analytics-chart-day')"
              :is-loading="isLoadingCreditAnalytics"
              :has-data="dailyCreditsSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="dailyCreditsSeries"
                :is-loading="isLoadingCreditAnalytics"
              />
            </ChartCard>

            <ChartCard
              :title="t('admin-credits-analytics-chart-month')"
              :is-loading="isLoadingCreditAnalytics"
              :has-data="monthlyCreditsSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="monthlyCreditsSeries"
                :is-loading="isLoadingCreditAnalytics"
                date-granularity="month"
              />
            </ChartCard>
          </div>

          <ChartCard
            :title="t('admin-credits-analytics-chart-revenue-month')"
            :is-loading="isLoadingCreditAnalytics"
            :has-data="monthlyRevenueWithCreditsSeries.length > 0"
          >
            <AdminMultiLineChart
              :series="monthlyRevenueWithCreditsSeries"
              :is-loading="isLoadingCreditAnalytics"
              date-granularity="month"
              value-prefix="$"
            />
          </ChartCard>
        </div>

        <!-- Grant Form Card -->
        <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
          <h2 class="mb-6 text-lg font-semibold text-gray-900 dark:text-white">
            {{ t('admin-credits-grant-title') }}
          </h2>

          <div class="space-y-6">
            <!-- Organization Search -->
            <div>
              <label class="block mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                {{ t('admin-credits-select-org') }}
              </label>

              <div v-if="selectedOrg" class="flex items-center justify-between p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20">
                <div>
                  <div class="font-medium text-gray-900 dark:text-white">
                    {{ selectedOrg.name }}
                  </div>
                  <div class="text-sm text-gray-500 dark:text-gray-400">
                    {{ selectedOrg.management_email }}
                  </div>
                  <div class="text-xs text-gray-400 dark:text-gray-500">
                    ID: {{ selectedOrg.id }}
                  </div>
                </div>
                <button
                  type="button"
                  class="p-2 text-gray-500 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
                  @click="clearSelectedOrg"
                >
                  <XMarkIcon class="w-5 h-5" />
                </button>
              </div>

              <div v-else class="relative">
                <div class="relative">
                  <label for="admin-credits-search" class="sr-only">{{ t('admin-credits-search-placeholder') }}</label>
                  <MagnifyingGlassIcon class="absolute w-5 h-5 text-gray-400 transform -translate-y-1/2 left-3 top-1/2" />
                  <input
                    id="admin-credits-search"
                    v-model="searchQuery"
                    type="text"
                    :placeholder="t('admin-credits-search-placeholder')"
                    :aria-label="t('admin-credits-search-placeholder')"
                    class="w-full py-3 pl-10 pr-4 border rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                  >
                  <Spinner v-if="isSearching" size="w-5 h-5" class="absolute text-blue-500 transform -translate-y-1/2 right-3 top-1/2" />
                </div>

                <!-- Search Results Dropdown -->
                <div
                  v-if="searchResults.length > 0"
                  class="absolute z-10 w-full mt-1 overflow-hidden bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-600"
                >
                  <button
                    v-for="org in searchResults"
                    :key="org.id"
                    type="button"
                    class="w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                    @click="selectOrg(org)"
                  >
                    <div class="font-medium text-gray-900 dark:text-white">
                      {{ org.name }}
                    </div>
                    <div class="text-sm text-gray-500 dark:text-gray-400">
                      {{ org.management_email }}
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <!-- Current Balance -->
            <div v-if="selectedOrg" class="p-4 rounded-lg bg-gray-50 dark:bg-gray-700">
              <div class="text-sm font-medium text-gray-500 dark:text-gray-400">
                {{ t('admin-credits-current-balance') }}
              </div>
              <div v-if="isLoadingBalance" class="mt-2">
                <Spinner size="w-5 h-5" />
              </div>
              <div v-else-if="orgBalance" class="mt-2">
                <div class="text-2xl font-bold text-gray-900 dark:text-white">
                  {{ formatCredits(orgBalance.available_credits) }}
                  <span class="text-sm font-normal text-gray-500">/ {{ formatCredits(orgBalance.total_credits) }}</span>
                </div>
                <div v-if="orgBalance.next_expiration" class="text-sm text-gray-500 dark:text-gray-400">
                  {{ t('admin-credits-expires') }}: {{ formatLocalDateTime(orgBalance.next_expiration) }}
                </div>
              </div>
              <div v-else class="mt-2 text-gray-500 dark:text-gray-400">
                {{ t('admin-credits-no-balance') }}
              </div>
            </div>

            <!-- Grant Form Fields -->
            <div v-if="selectedOrg" class="grid gap-6 md:grid-cols-2">
              <FormKit
                v-model="creditAmountStr"
                type="number"
                name="creditAmount"
                :label="t('admin-credits-amount-label')"
                validation="required|min:1"
                :min="1"
                :step="1"
                outer-class="!mb-0"
              />

              <FormKit
                v-model="expiresInMonthsStr"
                type="number"
                name="expiresInMonths"
                :label="t('admin-credits-expires-months')"
                :min="1"
                :max="60"
                :step="1"
                outer-class="!mb-0"
              />
            </div>

            <FormKit
              v-if="selectedOrg"
              v-model="creditNotes"
              type="textarea"
              name="notes"
              :label="t('admin-credits-notes-label')"
              :placeholder="t('admin-credits-notes-placeholder')"
              rows="2"
              outer-class="!mb-0"
            />

            <!-- Submit Button -->
            <button
              v-if="selectedOrg"
              type="button"
              :disabled="isGranting || creditAmount < 1"
              class="flex items-center justify-center w-full px-6 py-3 text-white transition-colors bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              @click="grantCredits"
            >
              <Spinner v-if="isGranting" size="w-5 h-5" class="mr-2" color="white" />
              {{ t('admin-credits-grant-button', { amount: creditAmount }) }}
            </button>
          </div>
        </div>

        <!-- Recent Grants Table -->
        <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
          <h2 class="mb-6 text-lg font-semibold text-gray-900 dark:text-white">
            {{ t('admin-credits-recent-grants') }}
          </h2>

          <div v-if="isLoadingGrants" class="flex items-center justify-center py-12">
            <Spinner size="w-8 h-8" />
          </div>

          <div v-else-if="recentGrants.length === 0" class="py-12 text-center text-gray-500 dark:text-gray-400">
            {{ t('admin-credits-no-grants') }}
          </div>

          <div v-else class="-mx-4 overflow-x-auto sm:mx-0">
            <table class="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
              <thead class="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th scope="col" class="px-4 py-3">
                    {{ t('admin-credits-col-org') }}
                  </th>
                  <th scope="col" class="px-4 py-3">
                    {{ t('admin-credits-col-amount') }}
                  </th>
                  <th scope="col" class="px-4 py-3">
                    {{ t('admin-credits-col-notes') }}
                  </th>
                  <th scope="col" class="px-4 py-3">
                    {{ t('admin-credits-col-date') }}
                  </th>
                  <th scope="col" class="px-4 py-3">
                    {{ t('admin-credits-col-expires') }}
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr v-for="grant in recentGrants" :key="grant.id" class="hover:bg-gray-50 dark:hover:bg-gray-700/60">
                  <td class="px-4 py-3">
                    <div class="font-medium text-gray-900 dark:text-white">
                      {{ grant.orgs?.name || grant.source_ref?.org_name || 'Unknown' }}
                    </div>
                    <div class="text-xs text-gray-500 dark:text-gray-400">
                      {{ grant.orgs?.management_email || '' }}
                    </div>
                  </td>
                  <td class="px-4 py-3 font-semibold text-emerald-600 dark:text-emerald-400">
                    +{{ formatCredits(grant.credits_total) }}
                  </td>
                  <td class="px-4 py-3 text-gray-700 dark:text-gray-300 max-w-xs truncate">
                    {{ grant.notes || '-' }}
                  </td>
                  <td class="px-4 py-3 text-gray-700 dark:text-gray-300">
                    {{ formatLocalDateTime(grant.granted_at) }}
                  </td>
                  <td class="px-4 py-3 text-gray-700 dark:text-gray-300">
                    {{ formatLocalDateTime(grant.expires_at) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
