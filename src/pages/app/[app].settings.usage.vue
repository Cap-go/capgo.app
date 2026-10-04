<script setup lang="ts">
import type { AppChartRefreshState } from '~/services/dashboardRefresh'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import BundleUploadsCard from '~/components/dashboard/BundleUploadsCard.vue'
import { provideChartCardCompact } from '~/components/dashboard/chartCardDensity'
import DeploymentStatsCard from '~/components/dashboard/DeploymentStatsCard.vue'
import UpdateStatsCard from '~/components/dashboard/UpdateStatsCard.vue'
import Usage from '~/components/dashboard/Usage.vue'
import { useAppPage } from '~/composables/useAppPage'
import { fetchAppChartRefreshState } from '~/services/dashboardRefresh'

// Billed usage (MAU, storage, bandwidth) and release activity counts. These
// used to open the app overview; they are billing data, so they live here.
const { t } = useI18n()
const { id, app, isLoading } = useAppPage({
  routeName: '/app/[app].settings.usage',
  navTitle: t('usage'),
})
const refreshState = ref<AppChartRefreshState | null>(null)
const usageComponent = ref<{
  useBillingPeriod: boolean
  showCumulative: boolean
  reloadTrigger: number
} | null>(null)

provideChartCardCompact()

const chartPeriodProps = computed(() => {
  const useBillingPeriod = usageComponent.value?.useBillingPeriod ?? true
  return {
    useBillingPeriod,
    accumulated: useBillingPeriod && (usageComponent.value?.showCumulative ?? false),
    reloadTrigger: usageComponent.value?.reloadTrigger ?? 0,
  }
})

watch(id, async (appId) => {
  refreshState.value = null
  if (!appId)
    return
  const state = await fetchAppChartRefreshState(appId)
  if (appId === id.value)
    refreshState.value = state
}, { immediate: true })
</script>

<template>
  <AppPageFrame :found="!!app" :loading="isLoading">
    <div v-if="id" class="px-4 sm:px-0">
      <Usage
        ref="usageComponent"
        :app-id="id"
        :app-stats-updated-at="refreshState?.stats_updated_at ?? null"
        :app-stats-refresh-requested-at="refreshState?.stats_refresh_requested_at ?? null"
      />

      <div class="grid grid-cols-1 gap-6 mb-6 sm:grid-cols-12">
        <BundleUploadsCard
          :app-id="id"
          :use-billing-period="chartPeriodProps.useBillingPeriod"
          :accumulated="chartPeriodProps.accumulated"
          :reload-trigger="chartPeriodProps.reloadTrigger"
          class="col-span-full sm:col-span-6 xl:col-span-4"
        />
        <UpdateStatsCard
          :app-id="id"
          :use-billing-period="chartPeriodProps.useBillingPeriod"
          :accumulated="chartPeriodProps.accumulated"
          :reload-trigger="chartPeriodProps.reloadTrigger"
          class="col-span-full sm:col-span-6 xl:col-span-4"
        />
        <DeploymentStatsCard
          :app-id="id"
          :use-billing-period="chartPeriodProps.useBillingPeriod"
          :accumulated="chartPeriodProps.accumulated"
          :reload-trigger="chartPeriodProps.reloadTrigger"
          class="col-span-full sm:col-span-6 xl:col-span-4"
        />
      </div>
    </div>
  </AppPageFrame>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
