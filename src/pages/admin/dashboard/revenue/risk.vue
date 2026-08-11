<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminRevenueRiskPanel from '~/components/admin/AdminRevenueRiskPanel.vue'
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
  subscriptionFlowSeries,
  pastDueOrgSeries,
  pastDueAverageDaysSeries,
  activeCanceledOrgSeries,
  activePastDueOrgSeries,
} = useAdminRevenueDashboard('Admin Dashboard Revenue Risk')

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

        <AdminRevenueRiskPanel
          v-else
          :is-loading-global-stats-trend="isLoadingGlobalStatsTrend"
          :latest-global-stats="latestGlobalStats"
          :subscription-flow-series="subscriptionFlowSeries"
          :past-due-org-series="pastDueOrgSeries"
          :past-due-average-days-series="pastDueAverageDaysSeries"
          :active-canceled-org-series="activeCanceledOrgSeries"
          :active-past-due-org-series="activePastDueOrgSeries"
        />
      </div>
    </div>
  </div>
</template>
