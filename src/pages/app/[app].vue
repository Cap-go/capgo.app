<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import AppNotFoundModal from '~/components/AppNotFoundModal.vue'
import BundleInstallStatsPanel from '~/components/dashboard/BundleInstallStatsPanel.vue'
import BundleUploadsCard from '~/components/dashboard/BundleUploadsCard.vue'
import CompatibilityBanner from '~/components/dashboard/CompatibilityBanner.vue'
import DeploymentBanner from '~/components/dashboard/DeploymentBanner.vue'
import DeploymentStatsCard from '~/components/dashboard/DeploymentStatsCard.vue'
import DevicesStats from '~/components/dashboard/DevicesStats.vue'
import ReleaseBanner from '~/components/dashboard/ReleaseBanner.vue'
import StoreReleaseValidationModal from '~/components/dashboard/StoreReleaseValidationModal.vue'
import UpdateStatsCard from '~/components/dashboard/UpdateStatsCard.vue'
import { getCapgoVersion, useSupabase } from '~/services/supabase'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'
import { shouldShowBuilderPromo } from '~/utils/builderPromoVisibility'

const id = ref('')
const route = useRoute('/app/[app]')
const lastPath = ref('')
const bundlesNb = ref(0)
const devicesNb = ref(0)
const updatesNb = ref(0)
const channelsNb = ref(0)
const capgoVersion = ref('')
const main = useMainStore()
const organizationStore = useOrganizationStore()
const dashboardAppsStore = useDashboardAppsStore()
const isLoading = ref(false)
const supabase = useSupabase()
const displayStore = useDisplayStore()
const app = ref<Database['public']['Tables']['apps']['Row']>()
const appCount = ref<number | null>(null)
const usageComponent = ref()
const appNotFound = ref(false)
const appOrganization = computed(() => {
  if (!id.value)
    return undefined
  return organizationStore.getOrgByAppId(id.value) ?? organizationStore.currentOrganization
})
const isPendingOnboarding = computed(() => app.value?.need_onboarding === true)
const selectableOrganizationCount = computed(() => organizationStore.organizations.filter(org => !isPendingOrganizationInvite(org)).length)
const showBuilderPromo = computed(() => {
  if (appCount.value === null)
    return false

  return shouldShowBuilderPromo({
    organizationCount: selectableOrganizationCount.value,
    appCount: appCount.value,
    appNeedsOnboarding: isPendingOnboarding.value,
  })
})

// Check if user lacks security compliance (2FA or password)
const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

async function loadAppInfo() {
  app.value = undefined
  appCount.value = null
  try {
    await organizationStore.awaitInitialLoad()
    const { data: dataApp, error } = await supabase
      .from('apps')
      .select()
      .eq('app_id', id.value)
      .single()

    if (error || !dataApp) {
      appNotFound.value = true
      return
    }

    const appId = id.value
    const subscriptionStart = appOrganization.value?.subscription_start
    appNotFound.value = false

    const [
      capgoVersionResult,
      updatesCount,
      devicesCount,
      bundlesCount,
      channelsCount,
      ownerAppCount,
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
      supabase
        .from('apps')
        .select('app_id', { count: 'exact', head: true })
        .eq('owner_org', dataApp.owner_org)
        .then(({ count, error: appCountError }) => appCountError ? null : count ?? 0),
    ])

    if (id.value !== appId)
      return

    app.value = dataApp
    appCount.value = ownerAppCount
    capgoVersion.value = capgoVersionResult
    updatesNb.value = updatesCount
    devicesNb.value = devicesCount
    bundlesNb.value = bundlesCount
    channelsNb.value = channelsCount
    dashboardAppsStore.upsertApp({
      app_id: appId,
      name: dataApp.name ?? null,
      ownerOrgId: dataApp.owner_org,
    })
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
          <StoreReleaseValidationModal v-if="!appNotFound && !isLoading && app && !isPendingOnboarding" :app-id="id" />
          <DeploymentBanner v-if="!appNotFound" :app-id="id" @deployed="refreshData" />
          <ReleaseBanner v-if="!appNotFound" :app-id="id" />
          <CompatibilityBanner v-if="!appNotFound" :app-id="id" />

          <!-- Capgo Builder promo banner (only for valid apps with no native build yet) -->
          <BuilderPromoBanner v-if="!appNotFound && app && showBuilderPromo" :app-id="id" />

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
              usage-kind="bundle"
              :use-billing-period="usageComponent?.useBillingPeriod ?? true"
              :accumulated="false"
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

          <div class="mb-6">
            <BundleInstallStatsPanel
              :app-id="id"
              :force-demo="appNotFound"
            />
          </div>
        </div>

        <!-- App not found overlay -->
        <AppNotFoundModal v-if="appNotFound" />
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
