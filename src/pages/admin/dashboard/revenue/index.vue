<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)
type ChurnChartMode = 'revenue' | 'rate'
const churnChartMode = ref<ChurnChartMode>('revenue')

// Global stats trend data
const globalStatsTrendData = ref<Array<{
  date: string
  apps: number
  apps_active: number
  users: number
  users_active: number
  paying: number
  org_conversion_rate: number
  plan_total_conversion_rate: number
  plan_solo_conversion_rate: number
  plan_maker_conversion_rate: number
  plan_team_conversion_rate: number
  plan_enterprise_conversion_rate: number
  trial: number
  not_paying: number
  updates: number
  updates_external: number
  success_rate: number
  bundle_storage_gb: number
  plan_solo: number
  plan_maker: number
  plan_team: number
  plan_enterprise: number
  registers_today: number
  devices_last_month: number
  stars: number
  need_upgrade: number
  above_plan_with_credits: number | null
  above_plan_without_credits: number | null
  paying_yearly: number
  paying_monthly: number
  new_paying_orgs: number
  canceled_orgs: number
  upgraded_orgs: number
  upgrade_rate_12m: number
  past_due_orgs: number
  past_due_orgs_average_days: number
  active_canceled_orgs: number
  active_past_due_orgs: number
  mrr: number
  previous_mrr: number
  previous_mrr_solo: number
  previous_mrr_maker: number
  previous_mrr_team: number
  previous_mrr_enterprise: number
  nrr: number
  churn_revenue: number
  churn_revenue_solo: number
  churn_revenue_maker: number
  churn_revenue_team: number
  churn_revenue_enterprise: number
  total_revenue: number
  revenue_solo: number
  revenue_maker: number
  revenue_team: number
  revenue_enterprise: number
  average_ltv: number
  shortest_ltv: number
  longest_ltv: number
  paying_orgs_subscription?: number
  paying_orgs_credits?: number
  paying_orgs_total?: number
}>>([])

const isLoadingGlobalStatsTrend = ref(false)

function toChurnRate(lostRevenue: number, previousMrr: number) {
  if (!Number.isFinite(previousMrr) || previousMrr <= 0)
    return 0
  return Math.round((lostRevenue / previousMrr) * 10000) / 100
}

async function loadGlobalStatsTrend() {
  isLoadingGlobalStatsTrend.value = true
  try {
    const data = await adminStore.fetchStats('global_stats_trend')
    console.log('[Admin Dashboard Revenue] Global stats trend data:', data)
    globalStatsTrendData.value = data || []
  }
  catch (error) {
    console.error('[Admin Dashboard Revenue] Error loading global stats trend:', error)
    globalStatsTrendData.value = []
  }
  finally {
    isLoadingGlobalStatsTrend.value = false
  }
}

// Computed properties for charts
const subscriptionTypeSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Yearly Subscriptions',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.paying_yearly || 0,
      })),
      color: '#10b981', // green
    },
    {
      label: 'Monthly Subscriptions',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.paying_monthly || 0,
      })),
      color: '#3b82f6', // blue
    },
  ]
})

const subscriptionFlowSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'New Subscriptions',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.new_paying_orgs || 0,
      })),
      color: '#10b981', // green
    },
    {
      label: 'Cancellations',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.canceled_orgs || 0,
      })),
      color: '#ef4444', // red
    },
  ]
})

const pastDueOrgSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('past-due-organizations'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.past_due_orgs || 0,
      })),
      color: '#ef4444', // red
    },
  ]
})

const pastDueAverageDaysSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('average-past-due-days'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.past_due_orgs_average_days || 0,
      })),
      color: '#f59e0b', // amber
    },
  ]
})

const activeCanceledOrgSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('active-canceled-organizations'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.active_canceled_orgs || 0,
      })),
      color: '#f97316', // orange
    },
  ]
})

const activePastDueOrgSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('active-past-due-organizations'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.active_past_due_orgs || 0,
      })),
      color: '#dc2626', // red
    },
  ]
})

const abovePlanTrendData = computed(() => globalStatsTrendData.value.filter(
  item => item.above_plan_with_credits !== null && item.above_plan_without_credits !== null,
))

const upgradeTrendSeries = computed(() => {
  if (abovePlanTrendData.value.length === 0)
    return []

  return [
    {
      label: t('need-upgrade-trend'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: item.need_upgrade || 0,
      })),
      color: '#7c3aed', // violet
    },
    {
      label: t('total-above-plan'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: (item.above_plan_with_credits ?? 0) + (item.above_plan_without_credits ?? 0),
      })),
      color: '#2563eb', // blue
    },
    {
      label: t('above-plan-with-credits'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: item.above_plan_with_credits ?? 0,
      })),
      color: '#f59e0b', // amber
    },
    {
      label: t('above-plan-without-credits'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: item.above_plan_without_credits ?? 0,
      })),
      color: '#ef4444', // red
    },
    {
      label: t('upgraded-organizations'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: item.upgraded_orgs || 0,
      })),
      color: '#10b981', // green
    },
  ]
})

const planConversionSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  // No "All Paid Plans" series: with paying as denom that line is always ~100%.
  return [
    {
      label: 'Solo (% of paying)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_solo_conversion_rate || 0,
      })),
      color: '#8b5cf6', // purple
    },
    {
      label: 'Maker (% of paying)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_maker_conversion_rate || 0,
      })),
      color: '#ec4899', // pink
    },
    {
      label: 'Team (% of paying)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_team_conversion_rate || 0,
      })),
      color: '#10b981', // green
    },
    {
      label: 'Enterprise (% of paying)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_enterprise_conversion_rate || 0,
      })),
      color: '#f59e0b', // amber
    },
  ]
})

const upgradeRate12mSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('upgrade-rate-12m'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.upgrade_rate_12m || 0,
      })),
      color: '#10b981', // green
    },
  ]
})

const mrrSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'MRR - Monthly Recurring Revenue ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.mrr || 0,
      })),
      color: '#3b82f6', // blue
    },
  ]
})

const nrrSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'NRR - Net Revenue Retention (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.nrr ?? 100,
      })),
      color: '#8b5cf6', // violet
    },
  ]
})

const churnRevenueSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  const totalSeries = {
    label: 'Total Lost MRR ($)',
    data: globalStatsTrendData.value.map(item => ({
      date: item.date,
      value: item.churn_revenue || 0,
    })),
    color: '#ef4444', // red
  }
  const planSeries = [
    {
      label: 'Solo Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_solo || 0,
      })),
      color: '#8b5cf6', // purple
    },
    {
      label: 'Maker Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_maker || 0,
      })),
      color: '#ec4899', // pink
    },
    {
      label: 'Team Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_team || 0,
      })),
      color: '#10b981', // green
    },
    {
      label: 'Enterprise Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_enterprise || 0,
      })),
      color: '#f59e0b', // amber
    },
  ]

  if (planSeries.some(series => series.data.some(point => point.value > 0)))
    return [totalSeries, ...planSeries]

  return [totalSeries]
})

const churnRateSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  const totalSeries = {
    label: 'Total Churn Rate (%)',
    data: globalStatsTrendData.value.map(item => ({
      date: item.date,
      value: toChurnRate(item.churn_revenue || 0, item.previous_mrr || 0),
    })),
    color: '#ef4444', // red
  }
  const planSeries = [
    {
      label: 'Solo Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_solo || 0, item.previous_mrr_solo || 0),
      })),
      color: '#8b5cf6', // purple
    },
    {
      label: 'Maker Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_maker || 0, item.previous_mrr_maker || 0),
      })),
      color: '#ec4899', // pink
    },
    {
      label: 'Team Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_team || 0, item.previous_mrr_team || 0),
      })),
      color: '#10b981', // green
    },
    {
      label: 'Enterprise Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_enterprise || 0, item.previous_mrr_enterprise || 0),
      })),
      color: '#f59e0b', // amber
    },
  ]

  if (planSeries.some(series => series.data.some(point => point.value > 0)))
    return [totalSeries, ...planSeries]

  return [totalSeries]
})

const churnChartSeries = computed(() => churnChartMode.value === 'rate' ? churnRateSeries.value : churnRevenueSeries.value)
const churnChartTitle = computed(() => churnChartMode.value === 'rate' ? 'Churn Rate by Plan' : 'Churn Revenue - Lost MRR by Plan')
const churnChartValuePrefix = computed(() => churnChartMode.value === 'revenue' ? '$' : '')
const churnChartValueSuffix = computed(() => churnChartMode.value === 'rate' ? '%' : '')

const arrSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'ARR - Annual Recurring Revenue ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.total_revenue || 0,
      })),
      color: '#10b981', // green
    },
  ]
})

const nrrAxisRange = computed(() => {
  const values = nrrSeries.value.flatMap(series => series.data.map(point => point.value)).filter(value => Number.isFinite(value))
  if (values.length === 0) {
    return {
      suggestedMin: 90,
      suggestedMax: 110,
    }
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const padding = Math.max((max - min) * 0.25, 5)

  return {
    suggestedMin: Math.max(0, Math.floor(min - padding)),
    suggestedMax: Math.ceil(max + padding),
  }
})

const planARRSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Solo Plan ARR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.revenue_solo || 0,
      })),
      color: '#8b5cf6', // purple
    },
    {
      label: 'Maker Plan ARR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.revenue_maker || 0,
      })),
      color: '#ec4899', // pink
    },
    {
      label: 'Team Plan ARR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.revenue_team || 0,
      })),
      color: '#10b981', // green
    },
    {
      label: 'Enterprise Plan ARR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.revenue_enterprise || 0,
      })),
      color: '#f59e0b', // amber
    },
  ]
})

const ltvSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Average LTV ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.average_ltv || 0,
      })),
      color: '#119eff',
    },
    {
      label: 'Shortest LTV ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.shortest_ltv || 0,
      })),
      color: '#f59e0b',
    },
    {
      label: 'Longest LTV ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.longest_ltv || 0,
      })),
      color: '#10b981',
    },
  ]
})

const totalPayingOrgsSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Total Paying Organizations',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.paying,
      })),
      color: '#10b981', // green
    },
  ]
})

const latestGlobalStats = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return null
  return globalStatsTrendData.value[globalStatsTrendData.value.length - 1]
})

const totalAbovePlan = computed(() => {
  const stats = latestGlobalStats.value
  if (!stats || stats.above_plan_with_credits === null || stats.above_plan_without_credits === null)
    return null
  return stats.above_plan_with_credits + stats.above_plan_without_credits
})

const abovePlanMetricCards = computed(() => {
  const stats = latestGlobalStats.value
  return [
    {
      key: 'need-upgrade',
      title: 'Orgs Need Upgrade',
      description: t('need-upgrade-description'),
      value: stats ? stats.need_upgrade : 0,
      emptyDisplay: '0',
      iconWrapClass: 'bg-error/10',
      iconClass: 'text-error',
      valueClass: 'text-error',
      iconPath: 'M12 9v4m0 4h.01M5.07 19h13.86a2 2 0 001.74-3l-6.93-12a2 2 0 00-3.48 0l-6.93 12a2 2 0 001.74 3z',
    },
    {
      key: 'total-above-plan',
      title: t('total-above-plan'),
      description: t('total-above-plan-description'),
      value: totalAbovePlan.value,
      emptyDisplay: '—',
      iconWrapClass: 'bg-info/10',
      iconClass: 'text-info',
      valueClass: 'text-info',
      iconPath: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
    },
    {
      key: 'above-plan-with-credits',
      title: t('above-plan-with-credits'),
      description: t('above-plan-with-credits-description'),
      value: stats?.above_plan_with_credits ?? null,
      emptyDisplay: '—',
      iconWrapClass: 'bg-warning/10',
      iconClass: 'text-warning',
      valueClass: 'text-warning',
      iconPath: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V7m0 9v1m0-13a9 9 0 110 18 9 9 0 010-18z',
    },
    {
      key: 'above-plan-without-credits',
      title: t('above-plan-without-credits'),
      description: t('above-plan-without-credits-description'),
      value: stats?.above_plan_without_credits ?? null,
      emptyDisplay: '—',
      iconWrapClass: 'bg-error/10',
      iconClass: 'text-error',
      valueClass: 'text-error',
      iconPath: 'M12 9v4m0 4h.01M5.07 19h13.86a2 2 0 001.74-3l-6.93-12a2 2 0 00-3.48 0l-6.93 12a2 2 0 001.74 3z',
    },
  ]
})

watch(() => adminStore.activeDateRange, () => {
  loadGlobalStatsTrend()
}, { deep: true })

// Watch for refresh button clicks
watch(() => adminStore.refreshTrigger, () => {
  loadGlobalStatsTrend()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadGlobalStatsTrend()
  isLoading.value = false

  displayStore.NavTitle = t('revenue')
})

displayStore.NavTitle = t('revenue')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <!-- MRR & ARR Cards -->
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
            <!-- MRR Card -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-primary/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-primary"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  MRR - Monthly Recurring Revenue
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-primary">
                  ${{ formatNumberValue(latestGlobalStats.mrr, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-primary">
                  $0.00
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Current monthly recurring revenue
                </p>
              </div>
            </div>

            <!-- ARR Card -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-success/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  ARR - Annual Recurring Revenue Projection
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
                  ${{ formatNumberValue(latestGlobalStats.total_revenue, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-success">
                  $0.00
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Projected annual recurring revenue (MRR × 12)
                </p>
              </div>
            </div>
          </div>

          <!-- Paid Organization Breakdown -->
          <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Total Paid Organizations
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
                  {{ formatNumberValue(latestGlobalStats.paying_orgs_total || latestGlobalStats.paying || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-success">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Subscription and/or available credits
                </p>
              </div>
            </div>
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Paid via Subscription
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-primary">
                  {{ formatNumberValue(latestGlobalStats.paying_orgs_subscription || latestGlobalStats.paying || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-primary">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Active subscription organizations
                </p>
              </div>
            </div>
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Paid via Credits
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-accent">
                  {{ formatNumberValue(latestGlobalStats.paying_orgs_credits || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-accent">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Organizations with available credits
                </p>
              </div>
            </div>
          </div>

          <!-- Revenue Metrics Cards -->
          <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
            <!-- Total Paying Organizations -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-success/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Total Paying
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
                  {{ formatNumberValue(latestGlobalStats.paying) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-success">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Active paying organizations
                </p>
              </div>
            </div>

            <!-- Yearly Subscriptions -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-primary/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-primary"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Yearly Subscriptions
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-primary">
                  {{ formatNumberValue(latestGlobalStats.paying_yearly || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-primary">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Organizations on yearly plans
                </p>
              </div>
            </div>

            <!-- Monthly Subscriptions -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-info/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-info"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Monthly Subscriptions
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-info">
                  {{ formatNumberValue(latestGlobalStats.paying_monthly || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-info">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Organizations on monthly plans
                </p>
              </div>
            </div>
          </div>

          <!-- Upgrade Metrics Cards -->
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
            <div
              v-for="card in abovePlanMetricCards"
              :key="card.key"
              class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900"
            >
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg" :class="card.iconWrapClass">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current" :class="card.iconClass">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="card.iconPath" />
                  </svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ card.title }}
                </p>
                <p v-if="card.value !== null" class="mt-2 text-3xl font-bold" :class="card.valueClass">
                  {{ formatNumberValue(card.value) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold" :class="card.valueClass">
                  {{ card.emptyDisplay }}
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ card.description }}
                </p>
              </div>
            </div>

            <!-- Organizations Upgraded -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-success/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ t('upgraded-organizations') }}
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
                  {{ formatNumberValue(latestGlobalStats.upgraded_orgs || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-success">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('upgraded-organizations-latest-day') }}
                </p>
              </div>
            </div>

            <!-- 12-Month Upgrade Rate -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-success/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ t('upgrade-rate-12m') }}
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
                  {{ formatNumberValue(latestGlobalStats.upgrade_rate_12m || 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}%
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-success">
                  0.0%
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('upgrade-rate-12m-description') }}
                </p>
              </div>
            </div>

            <!-- Past Due Organizations -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-error/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-error"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M9.172 4.172a4 4 0 015.656 0l5 5a4 4 0 010 5.656l-5 5a4 4 0 01-5.656 0l-5-5a4 4 0 010-5.656l5-5z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ t('past-due-orgs') }}
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-error">
                  {{ formatNumberValue(latestGlobalStats.past_due_orgs || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-error">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('stripe-subscriptions-past-due') }}
                </p>
              </div>
            </div>

            <!-- Average Past Due Days -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-warning/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-warning"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ t('avg-past-due-days') }}
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-warning">
                  {{ formatNumberValue(latestGlobalStats.past_due_orgs_average_days || 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-warning">
                  0.0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('current-average-delay') }}
                </p>
              </div>
            </div>

            <!-- Active Canceled (Paid Period) -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-warning/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-warning"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ t('active-canceled-orgs') }}
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-warning">
                  {{ formatNumberValue(latestGlobalStats.active_canceled_orgs || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-warning">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('active-canceled-orgs-description') }}
                </p>
              </div>
            </div>

            <!-- Active Past Due (Still Access) -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-error/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-error"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86l-8.5 14.74A2 2 0 003.55 22h16.9a2 2 0 001.76-3.4l-8.5-14.74a2 2 0 00-3.42 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  {{ t('active-past-due-orgs') }}
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-error">
                  {{ formatNumberValue(latestGlobalStats.active_past_due_orgs || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-error">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('active-past-due-orgs-description') }}
                </p>
              </div>
            </div>
          </div>

          <!-- Charts - 2 per row -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Subscription Flow (New vs Canceled) -->
            <ChartCard
              chart-id="subscription-flow"
              :title="t('subscription-flow')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="subscriptionFlowSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="subscriptionFlowSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Subscription Type (Yearly vs Monthly) -->
            <ChartCard
              chart-id="subscription-type-trend"
              :title="t('subscription-type-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="subscriptionTypeSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="subscriptionTypeSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              chart-id="past-due-organizations"
              :title="t('past-due-organizations')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="pastDueOrgSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="pastDueOrgSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <ChartCard
              chart-id="average-past-due-days"
              :title="t('average-past-due-days')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="pastDueAverageDaysSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="pastDueAverageDaysSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                :value-suffix="` ${t('days')}`"
              />
            </ChartCard>
          </div>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              chart-id="active-canceled-organizations"
              :title="t('active-canceled-organizations')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="activeCanceledOrgSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="activeCanceledOrgSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <ChartCard
              chart-id="active-past-due-organizations"
              :title="t('active-past-due-organizations')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="activePastDueOrgSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="activePastDueOrgSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
              chart-id="paid-plan-mix"
              title="Paid Plan Mix (of paying)"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="planConversionSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="planConversionSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-suffix="%"
              />
            </ChartCard>
          </div>

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
              chart-id="upgrade-rate-12m"
              :title="t('upgrade-rate-12m')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="upgradeRate12mSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="upgradeRate12mSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-suffix="%"
              />
            </ChartCard>
          </div>

          <!-- Revenue Charts - Full Width -->
          <div class="grid grid-cols-1 gap-6">
            <!-- MRR - Monthly Recurring Revenue -->
            <ChartCard
              chart-id="mrr"
              title="MRR - Monthly Recurring Revenue"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="mrrSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="mrrSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-prefix="$"
              />
            </ChartCard>

            <!-- ARR - Annual Recurring Revenue -->
            <ChartCard
              chart-id="arr"
              title="ARR - Annual Recurring Revenue Projection"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="arrSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="arrSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-prefix="$"
              />
            </ChartCard>

            <!-- ARR by Plan (3 lines) -->
            <ChartCard
              chart-id="arr-by-plan"
              title="ARR by Plan"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="planARRSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="planARRSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-prefix="$"
              />
            </ChartCard>

            <ChartCard
              chart-id="ltv-by-customer"
              title="LTV by Customer"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="ltvSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="ltvSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-prefix="$"
              />
            </ChartCard>
          </div>

          <!-- Retention Charts -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              chart-id="nrr"
              title="NRR - Net Revenue Retention"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="nrrSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="nrrSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                :begin-at-zero="false"
                :suggested-min="nrrAxisRange.suggestedMin"
                :suggested-max="nrrAxisRange.suggestedMax"
                value-suffix="%"
              />
            </ChartCard>

            <ChartCard
              chart-id="churn"
              :title="churnChartTitle"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="churnChartSeries.length > 0"
            >
              <template #header>
                <div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                    {{ churnChartTitle }}
                  </h2>
                  <div class="d-join shrink-0" role="group" aria-label="Churn chart unit">
                    <button
                      type="button"
                      class="d-btn d-btn-xs d-join-item min-w-10"
                      :class="churnChartMode === 'revenue' ? 'd-btn-primary' : 'd-btn-outline'"
                      :aria-pressed="churnChartMode === 'revenue'"
                      aria-label="Show churn in dollars"
                      @click="churnChartMode = 'revenue'"
                    >
                      $
                    </button>
                    <button
                      type="button"
                      class="d-btn d-btn-xs d-join-item min-w-10"
                      :class="churnChartMode === 'rate' ? 'd-btn-primary' : 'd-btn-outline'"
                      :aria-pressed="churnChartMode === 'rate'"
                      aria-label="Show churn as percent"
                      @click="churnChartMode = 'rate'"
                    >
                      %
                    </button>
                  </div>
                </div>
              </template>
              <AdminMultiLineChart
                :series="churnChartSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                :value-prefix="churnChartValuePrefix"
                :value-suffix="churnChartValueSuffix"
              />
            </ChartCard>
          </div>

          <!-- Additional Charts - 2 per row -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Total Paying Organizations Trend -->
            <ChartCard
              chart-id="paying-organizations-trend"
              :title="t('paying-orgs-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="totalPayingOrgsSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="totalPayingOrgsSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Above Plan Trend -->
            <ChartCard
              chart-id="above-plan-trend"
              :title="t('above-plan-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="upgradeTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="upgradeTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
