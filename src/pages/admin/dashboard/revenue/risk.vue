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
  new_paying_orgs: number
  canceled_orgs: number
  past_due_orgs: number
  past_due_orgs_average_days: number
  active_canceled_orgs: number
  active_past_due_orgs: number
}>>([])

const isLoadingGlobalStatsTrend = ref(false)

async function loadGlobalStatsTrend() {
  isLoadingGlobalStatsTrend.value = true
  try {
    const data = await adminStore.fetchStats('global_stats_trend')
    globalStatsTrendData.value = data || []
  }
  catch (error) {
    console.error('[Admin Dashboard Revenue Risk] Error loading global stats trend:', error)
    globalStatsTrendData.value = []
  }
  finally {
    isLoadingGlobalStatsTrend.value = false
  }
}

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
      color: '#10b981',
    },
    {
      label: 'Cancellations',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.canceled_orgs || 0,
      })),
      color: '#ef4444',
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
      color: '#ef4444',
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
      color: '#f59e0b',
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
      color: '#f97316',
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
      color: '#dc2626',
    },
  ]
})

const latestGlobalStats = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return null
  return globalStatsTrendData.value[globalStatsTrendData.value.length - 1]
})

watch(() => adminStore.activeDateRange, () => {
  loadGlobalStatsTrend()
}, { deep: true })

watch(() => adminStore.refreshTrigger, () => {
  loadGlobalStatsTrend()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin revenue risk')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadGlobalStatsTrend()
  isLoading.value = false

  displayStore.NavTitle = t('admin-revenue-risk')
})

displayStore.NavTitle = t('admin-revenue-risk')
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

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              :title="t('subscription-flow')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="subscriptionFlowSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="subscriptionFlowSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <ChartCard
              :title="t('past-due-organizations')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="pastDueOrgSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="pastDueOrgSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
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

            <ChartCard
              :title="t('active-canceled-organizations')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="activeCanceledOrgSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="activeCanceledOrgSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
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
        </div>
      </div>
    </div>
  </div>
</template>
