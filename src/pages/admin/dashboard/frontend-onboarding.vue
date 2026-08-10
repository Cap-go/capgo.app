<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { FrontendOnboardingAnalytics } from '~/services/adminFrontendOnboarding'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminFunnelChart from '~/components/admin/AdminFunnelChart.vue'
import AdminStackedBarChart from '~/components/admin/AdminStackedBarChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingFunnelStages,
  createFrontendOnboardingAnalyticsLoader,
  formatFrontendOnboardingDuration,
} from '~/services/adminFrontendOnboarding'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const adminStore = useAdminDashboardStore()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const isLoading = ref(true)
const isLoadingStats = ref(false)
const isReady = ref(false)
const analytics = ref<FrontendOnboardingAnalytics | null>(null)

const loadAnalytics = createFrontendOnboardingAnalyticsLoader(
  async () => await adminStore.fetchStats('frontend_onboarding_analytics') || null,
  {
    onAnalytics: (value) => {
      analytics.value = value
    },
    onError: (error) => {
      console.error('[Admin Frontend Onboarding] Error loading analytics:', error)
    },
    onLoading: (value) => {
      isLoadingStats.value = value
      if (!value)
        isLoading.value = false
    },
  },
)

const visibleAnalytics = computed(() => isLoadingStats.value ? null : analytics.value)
const kpis = computed(() => visibleAnalytics.value?.kpis)
const dailySeries = computed(() => buildFrontendOnboardingDailySeries(
  visibleAnalytics.value?.daily_attempts ?? [],
  t('frontend-onboarding-new-users'),
))
const funnelStages = computed(() => buildFrontendOnboardingFunnelStages(visibleAnalytics.value?.funnel ?? []))
const hasAttempts = computed(() => (kpis.value?.attempts ?? 0) > 0)
const attemptsValue = computed(() => formatNumberValue(kpis.value?.attempts ?? 0))
const completionValue = computed(() => `${formatNumberValue(kpis.value?.completion_rate ?? 0, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})}%`)
const completionSubtitle = computed(() => t('frontend-onboarding-completed-subtitle', {
  count: formatNumberValue(kpis.value?.completed ?? 0),
}))
const largestDropoffValue = computed(() => kpis.value?.largest_dropoff
  ? `${formatNumberValue(kpis.value.largest_dropoff.percentage, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`
  : '—')
const largestDropoffSubtitle = computed(() => {
  const dropoff = kpis.value?.largest_dropoff
  if (!dropoff)
    return t('frontend-onboarding-no-dropoff')

  const stages = visibleAnalytics.value?.funnel ?? []
  const from = stages.find(stage => stage.key === dropoff.from)?.label ?? dropoff.from
  const to = stages.find(stage => stage.key === dropoff.to)?.label ?? dropoff.to
  return t('frontend-onboarding-transition', { from, to })
})

watch(() => adminStore.activeDateRange, () => {
  if (!isReady.value)
    return
  void loadAnalytics()
}, { deep: true })

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access frontend onboarding analytics')
    await router.push('/dashboard')
    return
  }

  isReady.value = true
  void loadAnalytics()
  displayStore.NavTitle = t('frontend-onboarding')
})

displayStore.NavTitle = t('frontend-onboarding')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div class="h-full pb-4 overflow-hidden">
    <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <AdminFilterBar />

      <PageLoader v-if="isLoading" />

      <div v-else class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
            {{ t('frontend-onboarding') }}
          </h1>
          <span class="px-3 py-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded-full dark:bg-indigo-500/20 dark:text-indigo-200">
            {{ t('frontend-onboarding-version-1') }}
          </span>
        </div>

        <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          <AdminStatsCard
            :title="t('frontend-onboarding-attempts')"
            :value="attemptsValue"
            :subtitle="t('frontend-onboarding-attempts-subtitle')"
            color-class="text-indigo-500"
            :is-loading="isLoadingStats"
          />
          <AdminStatsCard
            :title="t('frontend-onboarding-completed')"
            :value="completionValue"
            :subtitle="completionSubtitle"
            color-class="text-emerald-500"
            :is-loading="isLoadingStats"
          />
          <AdminStatsCard
            :title="t('frontend-onboarding-median-time')"
            :value="formatFrontendOnboardingDuration(kpis?.median_completion_ms ?? null)"
            :subtitle="t('frontend-onboarding-median-time-subtitle')"
            color-class="text-amber-500"
            :is-loading="isLoadingStats"
          />
          <AdminStatsCard
            :title="t('frontend-onboarding-largest-dropoff')"
            :value="largestDropoffValue"
            :subtitle="largestDropoffSubtitle"
            color-class="text-rose-500"
            :is-loading="isLoadingStats"
          />
        </div>

        <ChartCard
          :title="t('frontend-onboarding-daily-attempts')"
          :is-loading="isLoadingStats"
          :has-data="hasAttempts"
        >
          <AdminStackedBarChart :series="dailySeries" :is-loading="isLoadingStats" />
        </ChartCard>

        <section class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
          <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
            {{ t('frontend-onboarding-funnel') }}
          </h2>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {{ t('frontend-onboarding-funnel-description') }}
          </p>
          <div class="mt-6 h-72 sm:h-80">
            <AdminFunnelChart :stages="funnelStages" :is-loading="isLoadingStats" />
          </div>
          <div class="grid grid-cols-2 gap-4 pt-5 mt-5 border-t border-slate-200 md:grid-cols-4 dark:border-slate-700">
            <div v-for="stage in visibleAnalytics?.funnel ?? []" :key="stage.key" class="text-center">
              <p class="text-xl font-bold text-slate-900 tabular-nums dark:text-white">
                {{ formatNumberValue(stage.of_start_percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}%
              </p>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ stage.label }} · {{ formatNumberValue(stage.reached) }}
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
