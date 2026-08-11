<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import { computed, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatLocalDate, formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)

interface TrialPlanBreakdown {
  totals: Array<{
    plan_name: string
    total: number
  }>
  trend: Array<{
    date: string
    total: number
    plans: Record<string, number>
  }>
}

const trialPlanBreakdown = ref<TrialPlanBreakdown | null>(null)
const isLoadingTrialPlanBreakdown = ref(false)

// Global stats trend data
const {
  globalStatsTrendData,
  isLoadingGlobalStatsTrend,
  loadGlobalStatsTrend,
  latestGlobalStats,
} = useAdminGlobalStatsTrend('Admin Dashboard Retention Trials')


// Trial organizations data
interface TrialOrganization {
  org_id: string
  org_name: string
  management_email: string
  plan_name: string | null
  trial_end_date: string
  days_remaining: number
  trial_extension_count: number
  created_at: string
  last_bundle_upload_at: string | null
}

interface TrialOrganizationsResponse {
  success: boolean
  data: {
    organizations: TrialOrganization[]
    total: number
  }
}

const trialOrganizations = ref<TrialOrganization[]>([])
const trialOrganizationsTotal = ref(0)
const trialOrganizationsCurrentPage = ref(1)
const isLoadingTrialOrganizations = ref(false)
const TRIAL_PAGE_SIZE = 20

function getTrialExtensionBadgeLabel(extensionCount: number) {
  return t('trial-extended-badge', { count: extensionCount })
}

const trialOrganizationsColumns = computed<TableColumn[]>(() => [
  {
    label: t('org-name'),
    key: 'org_name',
    mobile: true,
    head: true,
    sortable: false,
    renderFunction: (item: TrialOrganization) => h('div', { class: 'flex flex-wrap items-center gap-2 text-slate-800 dark:text-white' }, [
      h('span', { class: 'font-medium' }, item.org_name),
      item.trial_extension_count > 0
        ? h('span', {
            class: 'inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-200',
          }, getTrialExtensionBadgeLabel(item.trial_extension_count))
        : null,
    ]),
  },
  { label: t('email'), key: 'management_email', mobile: false, sortable: false },
  {
    label: t('plan'),
    key: 'plan_name',
    mobile: true,
    sortable: false,
    displayFunction: (item: TrialOrganization) => item.plan_name || t('unknown'),
  },
  {
    label: t('days-remaining'),
    key: 'days_remaining',
    mobile: true,
    sortable: false,
    displayFunction: (item: TrialOrganization) => {
      if (item.days_remaining === 0)
        return t('expires-today')
      if (item.days_remaining === 1)
        return `1 ${t('day')}`
      return `${formatNumberValue(item.days_remaining)} ${t('days')}`
    },
  },
  {
    label: t('trial-end-date'),
    key: 'trial_end_date',
    mobile: false,
    sortable: false,
    displayFunction: (item: TrialOrganization) => {
      return formatLocalDate(item.trial_end_date)
    },
  },
  {
    label: t('last-upload'),
    key: 'last_bundle_upload_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: TrialOrganization) => {
      return formatLocalDateTime(item.last_bundle_upload_at) || t('never')
    },
  },
])

let loadTrialOrganizationsSequence = 0

async function loadTrialOrganizations() {
  const sequence = ++loadTrialOrganizationsSequence
  isLoadingTrialOrganizations.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const offset = (trialOrganizationsCurrentPage.value - 1) * TRIAL_PAGE_SIZE

    // Note: start_date and end_date are required by the API schema but not used for trial_organizations
    // which queries current trial status rather than time-series data
    const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        metric_category: 'trial_organizations',
        start_date: new Date().toISOString(),
        end_date: new Date().toISOString(),
        limit: TRIAL_PAGE_SIZE,
        offset,
      }),
    })

    if (!response.ok) {
      const errorData: unknown = await response.json().catch(() => ({}))
      throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
    }

    const data = await response.json() as TrialOrganizationsResponse
    if (!data.success)
      throw new Error('Failed to fetch trial organizations')

    if (sequence !== loadTrialOrganizationsSequence)
      return

    trialOrganizations.value = data.data.organizations || []
    trialOrganizationsTotal.value = data.data.total || 0
  }
  catch (error) {
    if (sequence !== loadTrialOrganizationsSequence)
      return

    console.error('[Admin Dashboard Retention Trials] Error loading trial organizations:', error)
    trialOrganizations.value = []
    trialOrganizationsTotal.value = 0
  }
  finally {
    if (sequence === loadTrialOrganizationsSequence)
      isLoadingTrialOrganizations.value = false
  }
}

async function loadTrialPlanBreakdown() {
  isLoadingTrialPlanBreakdown.value = true
  try {
    const data = await adminStore.fetchStats('trial_plan_breakdown')
    trialPlanBreakdown.value = data as TrialPlanBreakdown
  }
  catch (error) {
    console.error('[Admin Dashboard Retention Trials] Error loading trial plan breakdown:', error)
    trialPlanBreakdown.value = null
  }
  finally {
    isLoadingTrialPlanBreakdown.value = false
  }
}

const usersTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('admin-pulse-paying-orgs'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: Number(item.paying) || 0,
      })),
      color: '#10b981', // green
    },
    {
      label: t('trial-organizations'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: Number(item.trial) || 0,
      })),
      color: '#f59e0b', // amber
    },
  ]
})

const trialPlanBreakdownTotal = computed(() => {
  const totals = trialPlanBreakdown.value?.totals ?? []
  return totals.reduce((sum, plan) => sum + plan.total, 0)
})

const trialPlanBreakdownPlanNames = computed(() => {
  const totals = trialPlanBreakdown.value?.totals ?? []
  return totals.map(plan => plan.plan_name)
})

const trialPlanChartColors: Record<string, string> = {
  Solo: '#119eff',
  Maker: '#d97706',
  Team: '#8b5cf6',
  Enterprise: '#059669',
}

const fallbackTrialPlanChartColors = ['#119eff', '#d97706', '#8b5cf6', '#059669', '#db2777', '#0f766e', '#dc2626']

function getTrialPlanChartColor(planName: string, index: number) {
  return trialPlanChartColors[planName] ?? fallbackTrialPlanChartColors[index % fallbackTrialPlanChartColors.length]
}

const trialPlanBreakdownTrendSeries = computed(() => {
  const trend = trialPlanBreakdown.value?.trend ?? []
  if (trend.length === 0 || trialPlanBreakdownPlanNames.value.length === 0)
    return []

  return trialPlanBreakdownPlanNames.value
    .map((planName, index) => ({
      label: planName,
      data: trend.map(item => ({
        date: item.date,
        value: item.plans[planName] ?? 0,
      })),
      color: getTrialPlanChartColor(planName, index),
    }))
    .filter(series => series.data.some(item => item.value > 0))
})

const trialExtensionTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('trial-extensions'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: Number(item.trial_extended_orgs) || 0,
      })),
      color: '#119eff',
    },
    {
      label: t('extended-trial-subscriptions'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: Number(item.trial_extended_subscribed_orgs) || 0,
      })),
      color: '#10b981',
    },
  ]
})

watch(
  () => [
    adminStore.dateRangeMode,
    adminStore.customDateRange.start.getTime(),
    adminStore.customDateRange.end.getTime(),
  ] as const,
  () => {
    if (!mainStore.isAdmin)
      return
    trialOrganizationsCurrentPage.value = 1
    loadGlobalStatsTrend()
    loadTrialPlanBreakdown()
    loadTrialOrganizations()
  },
)

watch(() => adminStore.refreshTrigger, () => {
  if (!mainStore.isAdmin)
    return
  loadGlobalStatsTrend()
  loadTrialPlanBreakdown()
  loadTrialOrganizations()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await Promise.all([loadGlobalStatsTrend(), loadTrialPlanBreakdown(), loadTrialOrganizations()])
  isLoading.value = false

  displayStore.NavTitle = t('admin-retention-trials')
})

displayStore.NavTitle = t('admin-retention-trials')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <!-- Trial Organizations KPI -->
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-warning/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-warning"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ t('trial-organizations') }}
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-warning">
                  {{ formatNumberValue(latestGlobalStats.trial || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-warning">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('organizations-in-trial-period') }}
                </p>
              </div>
            </div>
          </div>

          <ChartCard
            :title="t('admin-users-trial-plan-breakdown')"
            :total="trialPlanBreakdownTotal"
            :is-loading="isLoadingTrialPlanBreakdown"
            :has-data="trialPlanBreakdownTrendSeries.length > 0"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ t('admin-users-trial-plan-breakdown') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('admin-users-trial-plan-breakdown-description') }}
                </p>
              </div>
            </template>
            <AdminMultiLineChart
              :series="trialPlanBreakdownTrendSeries"
              :is-loading="isLoadingTrialPlanBreakdown"
            />
          </ChartCard>

          <!-- Trial Organizations Table -->
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-4 text-lg font-semibold">
              {{ t('trial-organizations-list') }}
            </h3>
            <DataTable
              :is-loading="isLoadingTrialOrganizations"
              :total="trialOrganizationsTotal"
              :current-page="trialOrganizationsCurrentPage"
              :columns="trialOrganizationsColumns"
              :element-list="trialOrganizations"
              :auto-reload="false"
              @reload="loadTrialOrganizations"
              @reset="loadTrialOrganizations"
              @update:current-page="(page: number) => { trialOrganizationsCurrentPage = page; loadTrialOrganizations() }"
            />
          </div>

          <!-- Charts - 2 per row -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Users Trend -->
            <ChartCard
              :title="t('users-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="usersTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="usersTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Trial Extension Conversions -->
            <ChartCard
              :title="t('trial-extension-conversion-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="trialExtensionTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="trialExtensionTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
