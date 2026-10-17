<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import AppNotFoundModal from '~/components/AppNotFoundModal.vue'
import LiveReleaseDashboard from '~/components/dashboard/LiveReleaseDashboard.vue'
import { useConsole } from '~/services/console'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const id = ref('')
const route = useRoute()
const lastAppId = ref('')
const main = useMainStore()
const organizationStore = useOrganizationStore()
const dashboardAppsStore = useDashboardAppsStore()
const isLoading = ref(false)
const supabase = useConsole()
const displayStore = useDisplayStore()
type AppDashboardRow = Database['public']['Tables']['apps']['Row']

const app = ref<AppDashboardRow>()
const appNotFound = ref(false)
let loadGeneration = 0

const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

async function loadAppInfo(requestedId: string, generation: number) {
  app.value = undefined
  try {
    await organizationStore.awaitInitialLoad()
    if (generation !== loadGeneration || id.value !== requestedId)
      return

    const { data: dataApp, error } = await supabase.from('apps').select().eq('app_id', requestedId).single()

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
          <LiveReleaseDashboard
            v-if="!lacksSecurityAccess && id"
            :app-id="id"
            :force-demo="appNotFound"
            @deployed="refreshData"
          />
        </div>

        <AppNotFoundModal v-if="appNotFound" />
      </div>
    </div>
  </div>
</template>
