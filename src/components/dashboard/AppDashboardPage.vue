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
import { useSupabase } from '~/services/supabase'
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
const main = useMainStore()
const organizationStore = useOrganizationStore()
const dashboardAppsStore = useDashboardAppsStore()
const isLoading = ref(false)
const supabase = useSupabase()
const displayStore = useDisplayStore()
const app = ref<Database['public']['Tables']['apps']['Row']>()
const usageComponent = ref<{
  useBillingPeriod: boolean
  showCumulative: boolean
  reloadTrigger: number
} | null>(null)
const appNotFound = ref(false)
let loadGeneration = 0

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

async function loadAppInfo(requestedId: string, generation: number) {
  app.value = undefined
  try {
    await organizationStore.awaitInitialLoad()
    if (generation !== loadGeneration || id.value !== requestedId)
      return

    const { data: dataApp, error } = await supabase
      .from('apps')
      .select()
      .eq('app_id', requestedId)
      .single()

    if (generation !== loadGeneration || id.value !== requestedId)
      return

    if (error || !dataApp) {
      appNotFound.value = true
      return
    }

    appNotFound.value = false
    app.value = dataApp
    dashboardAppsStore.upsertApp({
      app_id: requestedId,
      name: dataApp.name ?? null,
      ownerOrgId: dataApp.owner_org,
    })
  }
  catch (error) {
    if (generation !== loadGeneration || id.value !== requestedId)
      return
    console.error(error)
    appNotFound.value = true
    app.value = undefined
  }
}

async function refreshData() {
  const requestedId = id.value
  const generation = ++loadGeneration
  isLoading.value = true
  try {
    await main.awaitInitialLoad()
    if (generation !== loadGeneration || id.value !== requestedId)
      return
    await loadAppInfo(requestedId, generation)
  }
  catch (error) {
    if (generation !== loadGeneration || id.value !== requestedId)
      return
    console.error(error)
  }
  finally {
    if (generation === loadGeneration)
      isLoading.value = false
  }
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

          <!-- Version mix is operational history, not billed usage. Default last 1 day. -->
          <div v-else-if="!lacksSecurityAccess && props.section === 'native'" class="grid grid-cols-1 gap-6 mb-6">
            <DevicesStats
              :app-id="id"
              usage-kind="native"
              :use-billing-period="false"
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

          <!-- Same period selector as Native. Default last 1 day. -->
          <div v-else-if="!lacksSecurityAccess && props.section === 'active-bundle'" class="grid grid-cols-1 gap-6 mb-6">
            <DevicesStats
              :app-id="id"
              usage-kind="bundle"
              :use-billing-period="false"
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
