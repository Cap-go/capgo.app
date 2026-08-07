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
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

interface GlobalStatsTrendPoint {
  date: string
  notifications_apps: number
  notifications_providers: number
  notifications_campaigns: number
  notifications_campaigns_day: number
  notifications_sent_day: number
  notifications_received_day: number
  notifications_opened_day: number
  notifications_failed_day: number
  notifications_sent_last_month: number
  notifications_opened_last_month: number
}

const { t } = useI18n()
const router = useRouter()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()

const isLoading = ref(true)
const globalStatsTrendData = ref<GlobalStatsTrendPoint[]>([])
const isLoadingGlobalStatsTrend = ref(false)
let trendRequestSeq = 0

function formatCount(value: number) {
  return formatNumberValue(value || 0)
}

async function loadGlobalStatsTrend() {
  const requestSeq = ++trendRequestSeq
  isLoadingGlobalStatsTrend.value = true
  try {
    const result = await adminStore.fetchStats('global_stats_trend')
    if (requestSeq !== trendRequestSeq)
      return
    globalStatsTrendData.value = result || []
  }
  catch (error) {
    if (requestSeq !== trendRequestSeq)
      return
    console.error('[Admin Dashboard Notifications] Error loading global stats trend:', error)
    globalStatsTrendData.value = []
  }
  finally {
    if (requestSeq === trendRequestSeq)
      isLoadingGlobalStatsTrend.value = false
  }
}

const latestPoint = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return null
  return globalStatsTrendData.value[globalStatsTrendData.value.length - 1]!
})

const periodTotals = computed(() => {
  return globalStatsTrendData.value.reduce((acc, item) => {
    acc.sent += item.notifications_sent_day || 0
    acc.received += item.notifications_received_day || 0
    acc.opened += item.notifications_opened_day || 0
    acc.failed += item.notifications_failed_day || 0
    acc.campaigns += item.notifications_campaigns_day || 0
    return acc
  }, { sent: 0, received: 0, opened: 0, failed: 0, campaigns: 0 })
})

const appsTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []
  return [
    { label: t('admin-notifications-apps'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_apps || 0 })), color: '#119eff' },
    { label: t('admin-notifications-providers'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_providers || 0 })), color: '#8b5cf6' },
    { label: t('admin-notifications-campaigns'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_campaigns || 0 })), color: '#10b981' },
  ]
})

const dailyDeliverySeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []
  return [
    { label: t('admin-notifications-sent'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_sent_day || 0 })), color: '#119eff' },
    { label: t('admin-notifications-received'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_received_day || 0 })), color: '#10b981' },
    { label: t('admin-notifications-opened'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_opened_day || 0 })), color: '#8b5cf6' },
    { label: t('admin-notifications-failed'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_failed_day || 0 })), color: '#ef4444' },
  ]
})

const lastMonthSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []
  return [
    { label: t('admin-notifications-sent-last-month'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_sent_last_month || 0 })), color: '#119eff' },
    { label: t('admin-notifications-opened-last-month'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_opened_last_month || 0 })), color: '#8b5cf6' },
  ]
})

const campaignsDaySeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []
  return [
    { label: t('admin-notifications-campaigns-day'), data: globalStatsTrendData.value.map(item => ({ date: item.date, value: item.notifications_campaigns_day || 0 })), color: '#f59e0b' },
  ]
})

watch(() => adminStore.activeDateRange, () => {
  if (mainStore.isAdmin)
    loadGlobalStatsTrend()
})

watch(() => adminStore.refreshTrigger, () => {
  if (mainStore.isAdmin)
    loadGlobalStatsTrend()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin notifications')
    router.push('/dashboard')
    return
  }

  displayStore.NavTitle = t('notifications')
  displayStore.defaultBack = '/dashboard'
  await loadGlobalStatsTrend()
  isLoading.value = false
})
</script>

<template>
  <PageLoader v-if="isLoading" />
  <div v-else class="h-full pb-4 overflow-hidden">
    <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-6xl max-h-fit">
      <div class="space-y-8">
        <div>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white">
            {{ t('admin-notifications-title') }}
          </h1>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin-notifications-description') }}
          </p>
        </div>

        <AdminFilterBar />

        <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <AdminStatsCard
            :title="t('admin-notifications-apps')"
            :value="formatCount(latestPoint?.notifications_apps || 0)"
            :is-loading="isLoadingGlobalStatsTrend"
            color-class="text-[#119eff]"
            :subtitle="t('admin-notifications-latest-subtitle')"
          />
          <AdminStatsCard
            :title="t('admin-notifications-providers')"
            :value="formatCount(latestPoint?.notifications_providers || 0)"
            :is-loading="isLoadingGlobalStatsTrend"
            color-class="text-[#8b5cf6]"
            :subtitle="t('admin-notifications-latest-subtitle')"
          />
          <AdminStatsCard
            :title="t('admin-notifications-period-sent')"
            :value="formatCount(periodTotals.sent)"
            :is-loading="isLoadingGlobalStatsTrend"
            color-class="text-[#10b981]"
            :subtitle="t('admin-notifications-period-subtitle')"
          />
          <AdminStatsCard
            :title="t('admin-notifications-period-opened')"
            :value="formatCount(periodTotals.opened)"
            :is-loading="isLoadingGlobalStatsTrend"
            color-class="text-[#f59e0b]"
            :subtitle="t('admin-notifications-period-subtitle')"
          />
        </div>

        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChartCard
            :title="t('admin-notifications-adoption-chart')"
            :is-loading="isLoadingGlobalStatsTrend"
            :has-data="appsTrendSeries.length > 0"
          >
            <AdminMultiLineChart
              :series="appsTrendSeries"
              :is-loading="isLoadingGlobalStatsTrend"
            />
          </ChartCard>

          <ChartCard
            :title="t('admin-notifications-delivery-chart')"
            :is-loading="isLoadingGlobalStatsTrend"
            :has-data="dailyDeliverySeries.length > 0"
          >
            <AdminMultiLineChart
              :series="dailyDeliverySeries"
              :is-loading="isLoadingGlobalStatsTrend"
            />
          </ChartCard>

          <ChartCard
            :title="t('admin-notifications-last-month-chart')"
            :is-loading="isLoadingGlobalStatsTrend"
            :has-data="lastMonthSeries.length > 0"
          >
            <AdminMultiLineChart
              :series="lastMonthSeries"
              :is-loading="isLoadingGlobalStatsTrend"
            />
          </ChartCard>

          <ChartCard
            :title="t('admin-notifications-campaigns-chart')"
            :is-loading="isLoadingGlobalStatsTrend"
            :has-data="campaignsDaySeries.length > 0"
          >
            <AdminMultiLineChart
              :series="campaignsDaySeries"
              :is-loading="isLoadingGlobalStatsTrend"
            />
          </ChartCard>
        </div>
      </div>
    </div>
  </div>
</template>
