<script setup lang="ts">
import type { AppDashboardSection } from '~/constants/appDashboardTabs'
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
import UpdateStatsCard from '~/components/dashboard/UpdateStatsCard.vue'
import { getCapgoVersion, useSupabase } from '~/services/supabase'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  section: AppDashboardSection
}>()

const id = ref('')
const route = useRoute()
const lastAppId = ref('')
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
const usageComponent = ref()
const appNotFound = ref(false)
const appOrganization = computed(() => {
  if (!id.value)
    return undefined
  return organizationStore.getOrgByAppId(id.value) ?? organizationStore.currentOrganization
})

const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

const chartPeriodProps = computed(() => {
  const useBillingPeriod = usageComponent.value?.useBillingPeriod ?? true
  return {
    useBillingPeriod,
    accumulated: useBillingPeriod && (usageComponent.value?.showCumulative ?? false),
    reloadTrigger: usageComponent.value?.reloadTrigger ?? 0,
  }
})

async function loadAppInfo() {
  app.value = undefined
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

    app.value = dataApp
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
  const appParam = 'app' in route.params ? route.params.app : undefined
  const nextId = Array.isArray(appParam) ? appParam[0] ?? '' : String(appParam ?? '')
  if (nextId && lastAppId.value !== nextId) {
    lastAppId.value = nextId
    id.value = nextId
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
        <FailedCard v-if="lacksSecurityAccess" />

        <div :class="{ 'blur-sm pointer-events-none select-none': appNotFound }">
          <DeploymentBanner v-if="!appNotFound" :app-id="id" @deployed="refreshData" />
          <ReleaseBanner v-if="!appNotFound" :app-id="id" />
          <CompatibilityBanner v-if="!appNotFound" :app-id="id" />

          <template v-if="!lacksSecurityAccess && props.section === 'usage'">
            <Usage
              ref="usageComponent"
              :app-id="id"
              :app-stats-updated-at="app?.stats_updated_at ?? null"
              :app-stats-refresh-requested-at="app?.stats_refresh_requested_at ?? null"
              :force-demo="appNotFound"
            />

            <div class="grid grid-cols-1 gap-6 mb-6 sm:grid-cols-12">
              <BundleUploadsCard
                :app-id="id"
                :use-billing-period="chartPeriodProps.useBillingPeriod"
                :accumulated="chartPeriodProps.accumulated"
                :reload-trigger="chartPeriodProps.reloadTrigger"
                :force-demo="appNotFound"
                class="col-span-full sm:col-span-6 xl:col-span-4"
              />
              <UpdateStatsCard
                :app-id="id"
                :use-billing-period="chartPeriodProps.useBillingPeriod"
                :accumulated="chartPeriodProps.accumulated"
                :reload-trigger="chartPeriodProps.reloadTrigger"
                :force-demo="appNotFound"
                class="col-span-full sm:col-span-6 xl:col-span-4"
              />
              <DeploymentStatsCard
                :app-id="id"
                :use-billing-period="chartPeriodProps.useBillingPeriod"
                :accumulated="chartPeriodProps.accumulated"
                :reload-trigger="chartPeriodProps.reloadTrigger"
                :force-demo="appNotFound"
                class="col-span-full sm:col-span-6 xl:col-span-4"
              />
            </div>
          </template>

          <div v-else-if="!lacksSecurityAccess && props.section === 'native'" class="grid grid-cols-1 gap-6 mb-6">
            <DevicesStats
              :app-id="id"
              usage-kind="native"
              :use-billing-period="true"
              :accumulated="false"
              :force-demo="appNotFound"
              class="col-span-full"
            />
          </div>

          <div v-else-if="!lacksSecurityAccess && props.section === 'installs'" class="mb-6">
            <BundleInstallStatsPanel
              :app-id="id"
              :force-demo="appNotFound"
            />
          </div>

          <div v-else-if="!lacksSecurityAccess && props.section === 'active-bundle'" class="grid grid-cols-1 gap-6 mb-6">
            <DevicesStats
              :app-id="id"
              usage-kind="bundle"
              :use-billing-period="true"
              :accumulated="false"
              :force-demo="appNotFound"
              class="col-span-full"
            />
          </div>
        </div>

        <AppNotFoundModal v-if="appNotFound" />
      </div>
    </div>
  </div>
</template>
