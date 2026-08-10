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

const globalStatsTrendData = ref<Array<{
  date: string
  need_upgrade: number
  above_plan_with_credits: number | null
  above_plan_without_credits: number | null
  upgraded_orgs: number
  upgrade_rate_12m: number
}>>([])

const isLoadingGlobalStatsTrend = ref(false)

async function loadGlobalStatsTrend() {
  isLoadingGlobalStatsTrend.value = true
  try {
    const data = await adminStore.fetchStats('global_stats_trend')
    globalStatsTrendData.value = data || []
  }
  catch (error) {
    console.error('[Admin Dashboard Revenue Upgrades] Error loading global stats trend:', error)
    globalStatsTrendData.value = []
  }
  finally {
    isLoadingGlobalStatsTrend.value = false
  }
}

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
      color: '#7c3aed',
    },
    {
      label: t('total-above-plan'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: (item.above_plan_with_credits ?? 0) + (item.above_plan_without_credits ?? 0),
      })),
      color: '#0ea5e9',
    },
    {
      label: t('above-plan-with-credits'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: item.above_plan_with_credits ?? 0,
      })),
      color: '#f59e0b',
    },
    {
      label: t('above-plan-without-credits'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: item.above_plan_without_credits ?? 0,
      })),
      color: '#ef4444',
    },
    {
      label: t('upgraded-organizations'),
      data: abovePlanTrendData.value.map(item => ({
        date: item.date,
        value: item.upgraded_orgs || 0,
      })),
      color: '#10b981',
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
      color: '#10b981',
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
      title: t('need-upgrade'),
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

watch(
  [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
  () => {
    if (!mainStore.isAdmin)
      return
    loadGlobalStatsTrend()
  },
  { deep: true },
)

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin revenue upgrades')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadGlobalStatsTrend()
  isLoading.value = false

  displayStore.NavTitle = t('admin-revenue-upgrades')
})

displayStore.NavTitle = t('admin-revenue-upgrades')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
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
          </div>

          <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
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
          </div>

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
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

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
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
