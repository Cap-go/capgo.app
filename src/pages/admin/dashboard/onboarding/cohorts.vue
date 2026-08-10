<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
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
  org_conversion_rate: number
  app_conversion_rate: number
  channel_conversion_rate: number
  bundle_conversion_rate: number
  subscription_conversion_rate: number
  production_device_conversion_rate: number
  update_download_conversion_rate: number
}

const onboardingFunnelData = ref<OnboardingFunnelData | null>(null)
const isLoadingOnboardingFunnel = ref(false)

async function loadOnboardingFunnel() {
  isLoadingOnboardingFunnel.value = true
  try {
    const data = await adminStore.fetchStats('onboarding_funnel')
    console.log('[Admin Dashboard Onboarding Cohorts] Onboarding funnel data:', data)
    onboardingFunnelData.value = data || null
  }
  catch (error) {
    console.error('[Admin Dashboard Onboarding Cohorts] Error loading onboarding funnel:', error)
    onboardingFunnelData.value = null
  }
  finally {
    isLoadingOnboardingFunnel.value = false
  }
}

const stuckCohorts = computed(() => {
  if (!onboardingFunnelData.value)
    return []

  const data = onboardingFunnelData.value
  const orgsWithApp = Number(data.orgs_with_app) || 0
  const orgsWithChannel = Number(data.orgs_with_channel) || 0
  const orgsWithBundle = Number(data.orgs_with_bundle) || 0
  const orgsWithProductionDevice = Number(data.orgs_with_production_device) || 0
  const orgsWithUpdateDownload = Number(data.orgs_with_update_download) || 0

  const items = [
    {
      key: 'app-no-channel',
      title: t('admin-onboarding-stuck-app-no-channel'),
      subtitle: t('admin-onboarding-stuck-app-no-channel-description'),
      value: Math.max(0, orgsWithApp - orgsWithChannel),
      colorClass: 'text-amber-500',
    },
    {
      key: 'channel-no-bundle',
      title: t('admin-onboarding-stuck-channel-no-bundle'),
      subtitle: t('admin-onboarding-stuck-channel-no-bundle-description'),
      value: Math.max(0, orgsWithChannel - orgsWithBundle),
      colorClass: 'text-orange-500',
    },
  ]

  if (data.activation_telemetry_available) {
    items.push(
      {
        key: 'bundle-no-device',
        title: t('admin-onboarding-stuck-bundle-no-device'),
        subtitle: t('admin-onboarding-stuck-bundle-no-device-description'),
        value: Math.max(0, orgsWithBundle - orgsWithProductionDevice),
        colorClass: 'text-pink-500',
      },
      {
        key: 'device-no-download',
        title: t('admin-onboarding-stuck-device-no-download'),
        subtitle: t('admin-onboarding-stuck-device-no-download-description'),
        value: Math.max(0, orgsWithProductionDevice - orgsWithUpdateDownload),
        colorClass: 'text-indigo-500',
      },
    )
  }

  return items
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

watch(() => adminStore.activeDateRange, () => {
  loadOnboardingFunnel()
}, { deep: true })

// Watch for refresh button clicks
watch(() => adminStore.refreshTrigger, () => {
  loadOnboardingFunnel()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadOnboardingFunnel()
  isLoading.value = false

  displayStore.NavTitle = t('admin-onboarding-cohorts')
})

displayStore.NavTitle = t('admin-onboarding-cohorts')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-2 text-lg font-semibold">
              {{ t('admin-onboarding-cohorts') }}
            </h3>
            <p class="mb-2 text-sm text-slate-600 dark:text-slate-400">
              {{ t('admin-onboarding-cohorts-description') }}
            </p>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              {{ t('admin-onboarding-cohorts-hint') }}
            </p>
          </div>

          <div
            v-if="isLoadingOnboardingFunnel"
            class="flex items-center justify-center h-48"
          >
            <span class="loading loading-spinner loading-lg" />
          </div>

          <template v-else-if="onboardingFunnelData">
            <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
              <AdminStatsCard
                v-for="cohort in stuckCohorts"
                :key="cohort.key"
                :title="cohort.title"
                :value="cohort.value"
                :color-class="cohort.colorClass"
                :subtitle="cohort.subtitle"
                :is-loading="isLoadingOnboardingFunnel"
              />
            </div>

            <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <h3 class="mb-4 text-lg font-semibold">
                {{ t('onboarding-funnel') }}
              </h3>
              <div
                class="grid gap-x-2 gap-y-4"
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

              <p v-if="!onboardingFunnelData.activation_telemetry_available" class="mt-4 text-sm text-slate-500 dark:text-slate-400">
                {{ t('activation-telemetry-unavailable') }}
              </p>
            </div>
          </template>

          <div v-else class="flex items-center justify-center h-48 text-slate-400">
            {{ t('no-data-available') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
