<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, ref, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import IconCheck from '~icons/lucide/check'
import AppNotFoundModal from '~/components/AppNotFoundModal.vue'
import BundleUploadsCard from '~/components/dashboard/BundleUploadsCard.vue'
import CompatibilityBanner from '~/components/dashboard/CompatibilityBanner.vue'
import DeploymentBanner from '~/components/dashboard/DeploymentBanner.vue'
import DeploymentStatsCard from '~/components/dashboard/DeploymentStatsCard.vue'
import DevicesStats from '~/components/dashboard/DevicesStats.vue'
import ReleaseBanner from '~/components/dashboard/ReleaseBanner.vue'
import StoreReleaseValidationModal from '~/components/dashboard/StoreReleaseValidationModal.vue'
import UpdateStatsCard from '~/components/dashboard/UpdateStatsCard.vue'
import { getCapgoVersion, useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const id = ref('')
const route = useRoute('/app/[app]')
const router = useRouter()
const lastPath = ref('')
const bundlesNb = ref(0)
const devicesNb = ref(0)
const updatesNb = ref(0)
const channelsNb = ref(0)
const capgoVersion = ref('')
const main = useMainStore()
const organizationStore = useOrganizationStore()
const isLoading = ref(false)
const supabase = useSupabase()
const displayStore = useDisplayStore()
const app = ref<Database['public']['Tables']['apps']['Row']>()
const usageComponent = ref()
const appNotFound = ref(false)
const onboardingTourStep = ref(0)
const onboardingTour = [
  {
    title: 'Dashboard',
    body: 'This page shows the high-level activity of your app: active devices, downloads, deployments, and storage trends.',
  },
  {
    title: 'Bundles and channels',
    body: 'Use bundles for every web build you upload, then point channels like production or development to the versions you want devices to receive.',
  },
  {
    title: 'Devices and builds',
    body: 'Devices help you inspect real installs and rollout state. Builds gives you the native build pipeline when you need app store binaries.',
  },
  {
    title: 'Ready for the real app',
    body: 'When you are ready, finish the real app setup. The CLI can reuse this pending app and clear the temporary onboarding data before your first real upload.',
  },
]
const appOrganization = computed(() => {
  if (!id.value)
    return undefined
  return organizationStore.getOrgByAppId(id.value) ?? organizationStore.currentOrganization
})
const showOnboardingBanner = computed(() => app.value?.need_onboarding === true)
const showOnboardingTour = computed(() => showOnboardingBanner.value && route.query.tour === '1')
const tourEntry = computed(() => onboardingTour[onboardingTourStep.value] ?? onboardingTour[0])

// Check if user lacks security compliance (2FA or password)
const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

async function loadAppInfo() {
  try {
    await organizationStore.awaitInitialLoad()
    const { data: dataApp, error } = await supabase
      .from('apps')
      .select()
      .eq('app_id', id.value)
      .single()

    if (error || !dataApp) {
      appNotFound.value = true
      app.value = undefined
      return
    }

    const appId = id.value
    const subscriptionStart = appOrganization.value?.subscription_start
    appNotFound.value = false
    app.value = dataApp

    const [
      capgoVersionResult,
      updatesCount,
      devicesCount,
      bundlesCount,
      channelsCount,
    ] = await Promise.all([
      getCapgoVersion(appId, dataApp.last_version),
      main.getTotalStatsByApp(appId, subscriptionStart),
      main.getTotalMauByApp(appId, subscriptionStart),
      supabase
        .from('app_versions')
        .select('*', { count: 'exact', head: true })
        .eq('app_id', appId)
        .eq('deleted', false)
        .then(({ count }) => count ?? 0),
      supabase
        .from('channels')
        .select('*', { count: 'exact', head: true })
        .eq('app_id', appId)
        .then(({ count }) => count ?? 0),
    ])

    if (id.value !== appId)
      return

    capgoVersion.value = capgoVersionResult
    updatesNb.value = updatesCount
    devicesNb.value = devicesCount
    bundlesNb.value = bundlesCount
    channelsNb.value = channelsCount
  }
  catch (error) {
    console.error(error)
    appNotFound.value = true
    app.value = undefined
  }
}

async function refreshData() {
  isLoading.value = true
  try {
    await main.awaitInitialLoad()
    await loadAppInfo()
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}

function finishRealOnboarding() {
  if (!id.value)
    return

  router.push(`/app/new?resume=${encodeURIComponent(id.value)}`)
}

function closeTour() {
  router.replace({ query: { ...route.query, tour: undefined } })
}

function nextTourStep() {
  if (onboardingTourStep.value === onboardingTour.length - 1) {
    closeTour()
    return
  }

  onboardingTourStep.value += 1
}

watchEffect(async () => {
  if (route.params.app && lastPath.value !== route.path) {
    lastPath.value = route.path
    id.value = route.params.app as string
    await refreshData()
    displayStore.NavTitle = ''
    displayStore.defaultBack = '/apps'
  }
})
</script>

<template>
  <div>
    <div v-if="app || isLoading || appNotFound">
      <div class="relative w-full h-full px-4 pt-4 mb-8 overflow-x-hidden overflow-y-auto sm:px-6 lg:px-8 max-h-fit">
        <!-- Only show FailedCard for security access issues (2FA/password) -->
        <FailedCard v-if="lacksSecurityAccess" />

        <!-- Content - blurred when app not found -->
        <div :class="{ 'blur-sm pointer-events-none select-none': appNotFound }">
          <div v-if="showOnboardingBanner" class="mb-6 rounded-3xl border border-azure-200 bg-white p-5 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div class="max-w-3xl">
                <p class="text-sm font-semibold uppercase tracking-[0.18em] text-azure-500">
                  Onboarding app
                </p>
                <h2 class="mt-2 text-2xl font-semibold text-slate-900">
                  Explore first, then finish the real app setup when you are ready
                </h2>
                <p class="mt-2 text-sm text-slate-600">
                  This app is still marked as pending onboarding. Demo data is temporary, and the real CLI onboarding can reuse this app instead of creating a second one.
                </p>
              </div>
              <div class="flex flex-wrap gap-3">
                <button class="d-btn d-btn-primary" @click="finishRealOnboarding">
                  Finish real app setup
                </button>
                <button v-if="!showOnboardingTour" class="d-btn d-btn-outline" @click="router.replace(`/app/${encodeURIComponent(id)}?tour=1`)">
                  Show tour
                </button>
              </div>
            </div>
          </div>
          <StoreReleaseValidationModal v-if="!appNotFound && !isLoading && app && !showOnboardingBanner" :app-id="id" />
          <DeploymentBanner v-if="!appNotFound" :app-id="id" @deployed="refreshData" />
          <ReleaseBanner v-if="!appNotFound" :app-id="id" />
          <CompatibilityBanner v-if="!appNotFound" :app-id="id" />

          <!-- Capgo Builder promo banner (only for valid apps with no native build yet) -->
          <BuilderPromoBanner v-if="!appNotFound" :app-id="id" />

          <Usage
            v-if="!lacksSecurityAccess"
            ref="usageComponent"
            :app-id="id"
            :app-stats-updated-at="app?.stats_updated_at ?? null"
            :app-stats-refresh-requested-at="app?.stats_refresh_requested_at ?? null"
            :force-demo="appNotFound"
          />

          <!-- Charts section -->
          <div class="grid grid-cols-1 gap-6 mb-6 sm:grid-cols-12 xl:grid-cols-16">
            <BundleUploadsCard
              :app-id="id"
              :use-billing-period="usageComponent?.useBillingPeriod ?? true"
              :accumulated="(usageComponent?.useBillingPeriod ?? true) && (usageComponent?.showCumulative ?? false)"
              :reload-trigger="usageComponent?.reloadTrigger ?? 0"
              :force-demo="appNotFound"
              class="col-span-full sm:col-span-6 xl:col-span-4"
            />
            <UpdateStatsCard
              :app-id="id"
              :use-billing-period="usageComponent?.useBillingPeriod ?? true"
              :accumulated="(usageComponent?.useBillingPeriod ?? true) && (usageComponent?.showCumulative ?? false)"
              :reload-trigger="usageComponent?.reloadTrigger ?? 0"
              :force-demo="appNotFound"
              class="col-span-full sm:col-span-6 xl:col-span-4"
            />
            <DeploymentStatsCard
              :app-id="id"
              :use-billing-period="usageComponent?.useBillingPeriod ?? true"
              :accumulated="(usageComponent?.useBillingPeriod ?? true) && (usageComponent?.showCumulative ?? false)"
              :reload-trigger="usageComponent?.reloadTrigger ?? 0"
              :force-demo="appNotFound"
              class="col-span-full sm:col-span-6 xl:col-span-4"
            />
            <DevicesStats
              :app-id="id"
              usage-kind="native"
              :use-billing-period="usageComponent?.useBillingPeriod ?? true"
              :accumulated="false"
              :reload-trigger="usageComponent?.reloadTrigger ?? 0"
              :force-demo="appNotFound"
              class="col-span-full sm:col-span-6 xl:col-span-4"
            />
          </div>
        </div>

        <!-- App not found overlay -->
        <AppNotFoundModal v-if="appNotFound" />
      </div>

      <div v-if="showOnboardingTour" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4">
        <div class="w-full max-w-xl rounded-3xl bg-white p-6 shadow-2xl">
          <p class="text-sm font-semibold uppercase tracking-[0.18em] text-azure-500">
            Guided tour
          </p>
          <h2 class="mt-2 text-2xl font-semibold text-slate-900">
            {{ tourEntry.title }}
          </h2>
          <p class="mt-3 text-sm leading-6 text-slate-600">
            {{ tourEntry.body }}
          </p>
          <div class="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
            <p class="font-medium text-slate-900">
              What to look for next
            </p>
            <p class="mt-2">
              Tabs like Bundles, Channels, Devices, and Builds stay available in the app sidebar. You can explore the demo data now and switch to the real CLI onboarding any time.
            </p>
          </div>
          <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div class="inline-flex items-center gap-2 text-sm text-slate-500">
              <IconCheck class="h-4 w-4 text-emerald-500" />
              Step {{ onboardingTourStep + 1 }} of {{ onboardingTour.length }}
            </div>
            <div class="flex flex-wrap gap-3">
              <button class="d-btn d-btn-outline" @click="closeTour">
                Close
              </button>
              <button v-if="onboardingTourStep === onboardingTour.length - 1" class="d-btn d-btn-primary" @click="finishRealOnboarding">
                Finish real setup
              </button>
              <button v-else class="d-btn d-btn-primary" @click="nextTourStep">
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
