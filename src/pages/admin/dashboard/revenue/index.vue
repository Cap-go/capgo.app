<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminRevenueRiskPanel from '~/components/admin/AdminRevenueRiskPanel.vue'
import AdminRevenueUpgradesPanel from '~/components/admin/AdminRevenueUpgradesPanel.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { ensureAdminOrRedirect, useAdminStatsReload } from '~/composables/useAdminStatsReload'
import { useAdminRevenueDashboard } from '~/composables/useAdminRevenueDashboard'
import { formatNumberValue } from '~/services/formatLocale'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const displayStore = useDisplayStore()
const isLoading = ref(true)
type ChurnChartMode = 'revenue' | 'rate'
const churnChartMode = ref<ChurnChartMode>('revenue')

const {
  globalStatsTrendData,
  isLoadingGlobalStatsTrend,
  loadGlobalStatsTrend,
  latestGlobalStats,
  upgradeTrendSeries,
  upgradeRate12mSeries,
  abovePlanMetricCards,
  subscriptionFlowSeries,
  pastDueOrgSeries,
  pastDueAverageDaysSeries,
  activeCanceledOrgSeries,
  activePastDueOrgSeries,
} = useAdminRevenueDashboard('Admin Dashboard Revenue')

function toChurnRate(lostRevenue: number, previousMrr: number) {
  if (!Number.isFinite(previousMrr) || previousMrr <= 0)
    return 0
  return Math.round((lostRevenue / previousMrr) * 10000) / 100
}

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
      color: '#10b981',
    },
    {
      label: 'Monthly Subscriptions',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.paying_monthly || 0,
      })),
      color: '#3b82f6',
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
      color: '#8b5cf6',
    },
    {
      label: 'Maker (% of paying)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_maker_conversion_rate || 0,
      })),
      color: '#ec4899',
    },
    {
      label: 'Team (% of paying)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_team_conversion_rate || 0,
      })),
      color: '#10b981',
    },
    {
      label: 'Enterprise (% of paying)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_enterprise_conversion_rate || 0,
      })),
      color: '#f59e0b',
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
      color: '#3b82f6',
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
      color: '#8b5cf6',
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
    color: '#ef4444',
  }
  const planSeries = [
    {
      label: 'Solo Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_solo || 0,
      })),
      color: '#8b5cf6',
    },
    {
      label: 'Maker Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_maker || 0,
      })),
      color: '#ec4899',
    },
    {
      label: 'Team Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_team || 0,
      })),
      color: '#10b981',
    },
    {
      label: 'Enterprise Lost MRR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.churn_revenue_enterprise || 0,
      })),
      color: '#f59e0b',
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
    color: '#ef4444',
  }
  const planSeries = [
    {
      label: 'Solo Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_solo || 0, item.previous_mrr_solo || 0),
      })),
      color: '#8b5cf6',
    },
    {
      label: 'Maker Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_maker || 0, item.previous_mrr_maker || 0),
      })),
      color: '#ec4899',
    },
    {
      label: 'Team Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_team || 0, item.previous_mrr_team || 0),
      })),
      color: '#10b981',
    },
    {
      label: 'Enterprise Churn (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: toChurnRate(item.churn_revenue_enterprise || 0, item.previous_mrr_enterprise || 0),
      })),
      color: '#f59e0b',
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
      color: '#10b981',
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
      color: '#8b5cf6',
    },
    {
      label: 'Maker Plan ARR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.revenue_maker || 0,
      })),
      color: '#ec4899',
    },
    {
      label: 'Team Plan ARR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.revenue_team || 0,
      })),
      color: '#10b981',
    },
    {
      label: 'Enterprise Plan ARR ($)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.revenue_enterprise || 0,
      })),
      color: '#f59e0b',
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
        value: item.paying || 0,
      })),
      color: '#10b981',
    },
  ]
})

useAdminStatsReload(loadGlobalStatsTrend)

onMounted(async () => {
  const ok = await ensureAdminOrRedirect('Non-admin user attempted to access admin dashboard', isLoading, loadGlobalStatsTrend)
  if (!ok)
    return

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
                  {{ formatNumberValue(latestGlobalStats.paying_orgs_total ?? latestGlobalStats.paying ?? 0) }}
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

          <AdminRevenueUpgradesPanel
            :is-loading-global-stats-trend="isLoadingGlobalStatsTrend"
            :latest-global-stats="latestGlobalStats"
            :above-plan-metric-cards="abovePlanMetricCards"
            :upgrade-trend-series="upgradeTrendSeries"
            :upgrade-rate12m-series="upgradeRate12mSeries"
          />

          <AdminRevenueRiskPanel
            :is-loading-global-stats-trend="isLoadingGlobalStatsTrend"
            :latest-global-stats="latestGlobalStats"
            :subscription-flow-series="subscriptionFlowSeries"
            :past-due-org-series="pastDueOrgSeries"
            :past-due-average-days-series="pastDueAverageDaysSeries"
            :active-canceled-org-series="activeCanceledOrgSeries"
            :active-past-due-org-series="activePastDueOrgSeries"
          />

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
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

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
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

          <!-- Revenue Charts - Full Width -->
          <div class="grid grid-cols-1 gap-6">
            <!-- MRR - Monthly Recurring Revenue -->
            <ChartCard
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

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
              :title="t('paying-orgs-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="totalPayingOrgsSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="totalPayingOrgsSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
