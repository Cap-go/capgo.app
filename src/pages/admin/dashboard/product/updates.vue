<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import DeliveryLatencyPanel from '~/components/dashboard/DeliveryLatencyPanel.vue'
import PageLoader from '~/components/PageLoader.vue'
import { ensureAdminOrRedirect, useAdminStatsReload } from '~/composables/useAdminStatsReload'
import { useAdminGlobalStatsTrend } from '~/composables/useAdminGlobalStatsTrend'
import { formatNumberValue, formatOneDecimal } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const displayStore = useDisplayStore()
const adminStore = useAdminDashboardStore()
const isLoading = ref(true)

const {
  globalStatsTrendData,
  isLoadingGlobalStatsTrend,
  loadGlobalStatsTrend,
  latestGlobalStats,
} = useAdminGlobalStatsTrend('Admin Dashboard Updates')

const deliveryLatencyDays = computed(() => {
  const { start, end } = adminStore.activeDateRange
  return Math.max(1, Math.min(365, Math.ceil((end.getTime() - start.getTime()) / 86_400_000)))
})

const updatesTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Daily Updates',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.updates || 0,
      })),
      color: '#f59e0b',
    },
  ]
})

const successRateTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Success Rate (%)',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.success_rate || 0,
      })),
      color: '#10b981',
    },
  ]
})

const externalUpdatesSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Open Source Updates',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.updates_external || 0,
      })),
      color: '#8b5cf6',
    },
  ]
})

const devicesTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Active Devices',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.devices_last_month || 0,
      })),
      color: '#06b6d4',
    },
    {
      label: 'iOS Devices',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.devices_last_month_ios || 0,
      })),
      color: '#000000',
    },
    {
      label: 'Android Devices',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.devices_last_month_android || 0,
      })),
      color: '#3ddc84',
    },
  ]
})
useAdminStatsReload(loadGlobalStatsTrend)

onMounted(async () => {
  const ok = await ensureAdminOrRedirect('Non-admin user attempted to access admin dashboard', isLoading, loadGlobalStatsTrend)
  if (!ok)
    return

  displayStore.NavTitle = t('updates')
})

displayStore.NavTitle = t('updates')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <!-- Key Metrics Cards -->
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
            <!-- Total Updates Card -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-primary/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-primary"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Total Updates Today
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-primary">
                  {{ formatNumberValue(latestGlobalStats.updates) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-primary">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Platform-wide update count
                </p>
              </div>
            </div>

            <!-- Success Rate Card -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-success/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Success Rate
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
                  {{ formatOneDecimal(latestGlobalStats.success_rate) }}%
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-success">
                  0%
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Successful update installations
                </p>
              </div>
            </div>
          </div>

          <!-- Charts - 2 per row -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Updates Trend -->
            <ChartCard
              chart-id="updates-trend"
              :title="t('updates-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="updatesTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="updatesTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- External/Open Source Updates -->
            <ChartCard
              chart-id="open-source-updates"
              :title="t('open-source-updates')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="externalUpdatesSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="externalUpdatesSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>

          <!-- More Charts - 2 per row -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Success Rate Trend -->
            <ChartCard
              chart-id="success-rate-trend"
              :title="t('success-rate-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="successRateTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="successRateTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Devices Trend -->
            <ChartCard
              chart-id="devices-trend"
              :title="t('devices-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="devicesTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="devicesTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>

          <DeliveryLatencyPanel scope="platform" :days="deliveryLatencyDays" hide-period-selector />
        </div>
      </div>
    </div>
  </div>
</template>
