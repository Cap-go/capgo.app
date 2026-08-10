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

const { onboardingFunnelConversionSummaries, onboardingFunnelConversionGridClass } = useOnboardingFunnelMetrics(onboardingFunnelData)

watch(
  [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
  () => {
    if (!mainStore.isAdmin)
      return
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
