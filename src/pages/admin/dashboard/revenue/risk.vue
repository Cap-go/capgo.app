<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminRevenueRiskPanel from '~/components/admin/AdminRevenueRiskPanel.vue'
import PageLoader from '~/components/PageLoader.vue'
import { useAdminRevenueDashboard } from '~/composables/useAdminRevenueDashboard'
import { ensureAdminOrRedirect, useAdminStatsReload } from '~/composables/useAdminStatsReload'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const displayStore = useDisplayStore()
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

useAdminStatsReload(loadGlobalStatsTrend)

onMounted(async () => {
  const ok = await ensureAdminOrRedirect('Non-admin user attempted to access admin revenue risk', isLoading, loadGlobalStatsTrend)
  if (!ok)
    return

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
