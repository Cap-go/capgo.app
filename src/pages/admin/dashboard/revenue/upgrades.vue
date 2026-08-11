<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminRevenueUpgradesPanel from '~/components/admin/AdminRevenueUpgradesPanel.vue'
import PageLoader from '~/components/PageLoader.vue'
import { useAdminRevenueDashboard } from '~/composables/useAdminRevenueDashboard'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)

const {
  isLoadingGlobalStatsTrend,
  loadGlobalStatsTrend,
  latestGlobalStats,
  upgradeTrendSeries,
  upgradeRate12mSeries,
  abovePlanMetricCards,
} = useAdminRevenueDashboard('Admin Dashboard Revenue Upgrades')

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

        <AdminRevenueUpgradesPanel
          v-else
          :is-loading-global-stats-trend="isLoadingGlobalStatsTrend"
          :latest-global-stats="latestGlobalStats"
          :above-plan-metric-cards="abovePlanMetricCards"
          :upgrade-trend-series="upgradeTrendSeries"
          :upgrade-rate12m-series="upgradeRate12mSeries"
        />
      </div>
    </div>
  </div>
</template>
