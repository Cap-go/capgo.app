<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminFunnelChart from '~/components/admin/AdminFunnelChart.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
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

// Onboarding funnel data
interface OnboardingFunnelData {
  total_registrations: number
  total_orgs: number
  orgs_with_app: number
  orgs_with_channel: number
  orgs_with_bundle: number
  orgs_subscribed: number
  orgs_with_production_device: number
  orgs_with_update_download: number
  activation_telemetry_available: boolean
  total_invite_registrations: number
  total_org_joins_invite_register: number
  total_org_joins_existing_account: number
  org_conversion_rate: number
  app_conversion_rate: number
  channel_conversion_rate: number
  bundle_conversion_rate: number
  subscription_conversion_rate: number
  production_device_conversion_rate: number
  update_download_conversion_rate: number
  trend: Array<{
    date: string
    new_registrations: number
    new_orgs: number
    orgs_created_app: number
    orgs_created_channel: number
    orgs_created_bundle: number
    orgs_subscribed: number
    orgs_with_production_device: number
    orgs_with_update_download: number
  }>
  invite_trend: Array<{
    date: string
    invite_registrations: number
    org_joins_invite_register: number
    org_joins_existing_account: number
  }>
}

const onboardingFunnelData = ref<OnboardingFunnelData | null>(null)
const isLoadingOnboardingFunnel = ref(false)

// Global stats trend data
const globalStatsTrendData = ref<Array<{
  date: string
  apps: number
  apps_active: number
  users: number
  users_active: number
  paying: number
  trial: number
  not_paying: number
  updates: number
  updates_external: number
  success_rate: number
  bundle_storage_gb: number
  plan_solo: number
  plan_maker: number
  plan_team: number
  plan_enterprise: number
  registers_today: number
  new_paying_orgs: number
  apps_created: number
  versions_created: number
  demo_apps_created: number
  apps_with_preview: number
  devices_last_month: number
  trial_extended_orgs: number
  trial_extended_subscribed_orgs: number
  paying_orgs_subscription?: number
  paying_orgs_credits?: number
  paying_orgs_total?: number
}>>([])

const isLoadingGlobalStatsTrend = ref(false)

async function loadGlobalStatsTrend() {
  isLoadingGlobalStatsTrend.value = true
  try {
    const data = await adminStore.fetchStats('global_stats_trend')
    console.log('[Admin Dashboard Onboarding] Global stats trend data:', data)
    globalStatsTrendData.value = data || []
  }
  catch (error) {
    console.error('[Admin Dashboard Onboarding] Error loading global stats trend:', error)
    globalStatsTrendData.value = []
  }
  finally {
    isLoadingGlobalStatsTrend.value = false
  }
}

async function loadOnboardingFunnel() {
  isLoadingOnboardingFunnel.value = true
  try {
    const data = await adminStore.fetchStats('onboarding_funnel')
    console.log('[Admin Dashboard Onboarding] Onboarding funnel data:', data)
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
      label: 'Daily Registrations',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.registers_today,
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
        value: item.registers_today > 0
          ? (item.new_paying_orgs / item.registers_today) * 100
          : 0,
      })),
      color: '#8b5cf6', // violet
    },
  ]
})

const onboardingFunnelRates = computed(() => {
  if (!onboardingFunnelData.value) {
    return {
      org: 0,
      app: 0,
      channel: 0,
      bundle: 0,
      subscribed: 0,
      productionDevice: 0,
      updateDownload: 0,
    }
  }

  const totalRegistrations = Number(onboardingFunnelData.value.total_registrations) || 0
  const totalOrgs = Number(onboardingFunnelData.value.total_orgs) || 0
  const orgsWithApp = Number(onboardingFunnelData.value.orgs_with_app) || 0
  const orgsWithChannel = Number(onboardingFunnelData.value.orgs_with_channel) || 0
  const orgsWithBundle = Number(onboardingFunnelData.value.orgs_with_bundle) || 0
  const orgsSubscribed = Number(onboardingFunnelData.value.orgs_subscribed) || 0
  const orgsWithProductionDevice = Number(onboardingFunnelData.value.orgs_with_production_device) || 0
  const orgsWithUpdateDownload = Number(onboardingFunnelData.value.orgs_with_update_download) || 0

  return {
    org: totalRegistrations > 0 ? (totalOrgs / totalRegistrations) * 100 : 0,
    app: totalOrgs > 0 ? (orgsWithApp / totalOrgs) * 100 : 0,
    channel: orgsWithApp > 0 ? (orgsWithChannel / orgsWithApp) * 100 : 0,
    bundle: orgsWithChannel > 0 ? (orgsWithBundle / orgsWithChannel) * 100 : 0,
    subscribed: orgsWithBundle > 0 ? (orgsSubscribed / orgsWithBundle) * 100 : 0,
    productionDevice: orgsWithBundle > 0 ? (orgsWithProductionDevice / orgsWithBundle) * 100 : 0,
    updateDownload: orgsWithProductionDevice > 0 ? (orgsWithUpdateDownload / orgsWithProductionDevice) * 100 : 0,
  }
})

const onboardingFunnelConversionSummaries = computed(() => {
  const rates = onboardingFunnelRates.value
  const items = [
    {
      key: 'org',
      value: rates.org,
      label: t('register-to-org'),
      colorClass: 'text-sky-500',
    },
    {
      key: 'app',
      value: rates.app,
      label: t('org-to-app'),
      colorClass: 'text-purple-500',
    },
    {
      key: 'channel',
      value: rates.channel,
      label: t('app-to-channel'),
      colorClass: 'text-amber-500',
    },
    {
      key: 'bundle',
      value: rates.bundle,
      label: t('channel-to-bundle'),
      colorClass: 'text-emerald-500',
    },
  ]

  if (onboardingFunnelData.value?.activation_telemetry_available) {
    items.push(
      {
        key: 'productionDevice',
        value: rates.productionDevice,
        label: t('bundle-to-production-device'),
        colorClass: 'text-pink-500',
      },
      {
        key: 'updateDownload',
        value: rates.updateDownload,
        label: t('production-device-to-update-download'),
        colorClass: 'text-indigo-500',
      },
    )
  }

  items.push({
    key: 'subscribed',
    value: rates.subscribed,
    label: t('bundle-to-subscribed'),
    colorClass: 'text-rose-500',
  })

  return items
})

const onboardingFunnelConversionGridClass = computed(() => {
  // Keep one row on large screens so rates follow the funnel columns.
  const count = onboardingFunnelConversionSummaries.value.length
  if (count >= 7)
    return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-7'
  if (count >= 6)
    return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
  return 'grid-cols-2 sm:grid-cols-4'
})

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
  const demoAppsCreatedByDate = new Map(globalStatsTrendData.value.map(item => [normalizeTrendDate(item.date), item.demo_apps_created]))
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

watch(() => adminStore.activeDateRange, () => {
  loadGlobalStatsTrend()
  loadOnboardingFunnel()
}, { deep: true })

// Watch for refresh button clicks
watch(() => adminStore.refreshTrigger, () => {
  loadGlobalStatsTrend()
  loadOnboardingFunnel()
})

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
              <span class="loading loading-spinner loading-lg" />
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
