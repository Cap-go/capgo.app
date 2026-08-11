<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { OnboardingFunnelData } from '~/services/adminStatsTypes'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminFunnelChart from '~/components/admin/AdminFunnelChart.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { useAdminGlobalStatsTrend } from '~/composables/useAdminGlobalStatsTrend'
import { useOnboardingFunnelMetrics } from '~/composables/useOnboardingFunnelMetrics'
import { formatOneDecimal } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)

const onboardingFunnelData = ref<OnboardingFunnelData | null>(null)
const isLoadingOnboardingFunnel = ref(false)

// Global stats trend data
const {
  globalStatsTrendData,
  isLoadingGlobalStatsTrend,
  loadGlobalStatsTrend,
} = useAdminGlobalStatsTrend('Admin Dashboard Onboarding')

async function loadOnboardingFunnel() {
  isLoadingOnboardingFunnel.value = true
  try {
    const data = await adminStore.fetchStats('onboarding_funnel')
    onboardingFunnelData.value = data || null
  }
  catch (error) {
    console.error('[Admin Dashboard Onboarding] Error loading onboarding funnel:', error)
    onboardingFunnelData.value = null
  }
  finally {
    isLoadingOnboardingFunnel.value = false
  }
}

const registrationsTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('daily-registrations'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: Number(item.registers_today) || 0,
      })),
      color: '#3b82f6', // blue
    },
  ]
})

const registrationToSubscriptionConversionSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('registration-to-subscription-conversion'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: (Number(item.registers_today) || 0) > 0
          ? ((Number(item.new_paying_orgs) || 0) / (Number(item.registers_today) || 0)) * 100
          : 0,
      })),
      color: '#8b5cf6', // violet
    },
  ]
})

const { onboardingFunnelRates, onboardingFunnelConversionSummaries, onboardingFunnelConversionGridClass } = useOnboardingFunnelMetrics(onboardingFunnelData)

// Onboarding funnel stages for display
const onboardingFunnelStages = computed(() => {
  if (!onboardingFunnelData.value)
    return []

  const data = onboardingFunnelData.value
  const rates = onboardingFunnelRates.value
  return [
    {
      label: t('user-registrations'),
      value: Number(data.total_registrations) || 0,
      percentage: 100,
      color: '#0ea5e9', // sky
    },
    {
      label: t('organizations-created'),
      value: Number(data.total_orgs) || 0,
      percentage: rates.org,
      color: '#3b82f6', // blue
    },
    {
      label: t('created-an-app'),
      value: Number(data.orgs_with_app) || 0,
      percentage: rates.app,
      color: '#8b5cf6', // purple
    },
    {
      label: t('created-a-channel'),
      value: Number(data.orgs_with_channel) || 0,
      percentage: rates.channel,
      color: '#f59e0b', // amber
    },
    {
      label: t('uploaded-a-bundle'),
      value: Number(data.orgs_with_bundle) || 0,
      percentage: rates.bundle,
      color: '#10b981', // green
    },
    ...(data.activation_telemetry_available
      ? [
          {
            label: t('production-plugin-device'),
            value: Number(data.orgs_with_production_device) || 0,
            percentage: rates.productionDevice,
            color: '#ec4899', // pink
          },
          {
            label: t('completed-update-download'),
            value: Number(data.orgs_with_update_download) || 0,
            percentage: rates.updateDownload,
            color: '#6366f1', // indigo
          },
        ]
      : []),
  ]
})

// Onboarding funnel trend for multi-line chart
function normalizeTrendDate(value: string) {
  return value.includes('T') ? value.split('T')[0] : value
}

const onboardingFunnelTrendSeries = computed(() => {
  if (!onboardingFunnelData.value || !onboardingFunnelData.value.trend)
    return []

  const trend = onboardingFunnelData.value.trend
  const demoAppsCreatedByDate = new Map(globalStatsTrendData.value.map(item => [normalizeTrendDate(item.date), Number(item.demo_apps_created) || 0]))
  return [
    {
      label: t('user-registrations'),
      data: trend.map(item => ({
        date: item.date,
        value: item.new_registrations,
      })),
      color: '#0ea5e9', // sky
    },
    {
      label: t('new-organizations'),
      data: trend.map(item => ({
        date: item.date,
        value: item.new_orgs,
      })),
      color: '#8b5cf6', // purple
    },
    {
      label: t('created-app-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_created_app,
      })),
      color: '#2563eb', // blue
    },
    {
      label: t('created-channel-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_created_channel,
      })),
      color: '#f59e0b', // amber
    },
    {
      label: t('uploaded-bundle-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_created_bundle,
      })),
      color: '#10b981', // green
    },
    ...(onboardingFunnelData.value.activation_telemetry_available
      ? [
          {
            label: t('production-plugin-device-within-7-days'),
            data: trend.map(item => ({
              date: item.date,
              value: item.orgs_with_production_device,
            })),
            color: '#ec4899', // pink
          },
          {
            label: t('completed-update-download-within-7-days'),
            data: trend.map(item => ({
              date: item.date,
              value: item.orgs_with_update_download,
            })),
            color: '#6366f1', // indigo
          },
        ]
      : []),
    {
      label: t('demo-apps-created'),
      data: trend.map(item => ({
        date: item.date,
        value: demoAppsCreatedByDate.get(normalizeTrendDate(item.date)) ?? 0,
      })),
      color: '#ef4444', // red
    },
    {
      label: t('subscribed-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_subscribed,
      })),
      color: '#14b8a6', // teal
    },
  ]
})

const inviteJoinTrendSeries = computed(() => {
  const inviteTrend = onboardingFunnelData.value?.invite_trend
  if (!inviteTrend || inviteTrend.length === 0)
    return []

  return [
    {
      label: t('invite-registrations'),
      data: inviteTrend.map(item => ({
        date: item.date,
        value: Number(item.invite_registrations) || 0,
      })),
      color: '#f97316', // orange
    },
    {
      label: t('org-joins-invite-register'),
      data: inviteTrend.map(item => ({
        date: item.date,
        value: Number(item.org_joins_invite_register) || 0,
      })),
      color: '#06b6d4', // cyan
    },
    {
      label: t('org-joins-existing-account'),
      data: inviteTrend.map(item => ({
        date: item.date,
        value: Number(item.org_joins_existing_account) || 0,
      })),
      color: '#a855f7', // purple
    },
  ]
})

watch(
  [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
  () => {
    if (!mainStore.isAdmin)
      return
    loadGlobalStatsTrend()
    loadOnboardingFunnel()
  },
  { deep: true },
)

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await Promise.all([loadGlobalStatsTrend(), loadOnboardingFunnel()])
  isLoading.value = false

  displayStore.NavTitle = t('admin-onboarding')
})

displayStore.NavTitle = t('admin-onboarding')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <!-- Onboarding Funnel Section -->
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-4 text-lg font-semibold">
              {{ t('onboarding-funnel') }}
            </h3>
            <p class="mb-4 text-sm text-slate-600 dark:text-slate-400">
              {{ t('onboarding-funnel-description') }}
            </p>
            <div v-if="isLoadingOnboardingFunnel" class="flex items-center justify-center h-48">
              <span class="d-loading d-loading-spinner d-loading-lg" />
            </div>
            <div v-else-if="onboardingFunnelStages.length > 0" class="space-y-6">
              <div class="h-72 sm:h-80">
                <AdminFunnelChart :stages="onboardingFunnelStages" :is-loading="isLoadingOnboardingFunnel" />
              </div>

              <!-- Funnel conversion summary: one grid so rates share the funnel column rhythm -->
              <div
                class="grid gap-x-2 gap-y-4 pt-4 mt-4 border-t border-gray-200 dark:border-gray-700"
                :class="onboardingFunnelConversionGridClass"
              >
                <div
                  v-for="item in onboardingFunnelConversionSummaries"
                  :key="item.key"
                  class="min-w-0 px-1 text-center"
                >
                  <p
                    class="text-xl font-bold tabular-nums sm:text-2xl"
                    :class="item.colorClass"
                  >
                    {{ formatOneDecimal(item.value) }}%
                  </p>
                  <p class="mt-1 text-[11px] leading-snug text-gray-500 break-words sm:text-xs dark:text-gray-400">
                    {{ item.label }}
                  </p>
                </div>
              </div>

              <p v-if="!onboardingFunnelData?.activation_telemetry_available" class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('activation-telemetry-unavailable') }}
              </p>
            </div>
            <div v-else class="flex items-center justify-center h-48 text-slate-400">
              {{ t('no-data-available') }}
            </div>
          </div>

          <!-- Onboarding Trend Chart -->
          <ChartCard
            :title="t('onboarding-trend')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="onboardingFunnelTrendSeries.length > 0"
          >
            <AdminMultiLineChart
              :series="onboardingFunnelTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
          </ChartCard>

          <!-- Invite Join Trend Chart -->
          <ChartCard
            :title="t('invite-join-trend')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="inviteJoinTrendSeries.length > 0"
          >
            <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
              {{ t('invite-join-trend-description') }}
            </p>
            <AdminMultiLineChart
              :series="inviteJoinTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
          </ChartCard>

          <!-- Charts - 2 per row -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Daily Registrations -->
            <ChartCard
              :title="t('daily-registrations')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="registrationsTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="registrationsTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Registration to Subscription Conversion -->
            <ChartCard
              :title="t('registration-to-subscription-conversion')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="registrationToSubscriptionConversionSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="registrationToSubscriptionConversionSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-suffix="%"
              />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
