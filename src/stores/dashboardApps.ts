import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from './organization'

export const useDashboardAppsStore = defineStore('dashboardApps', () => {
  const apps = ref<{ app_id: string, name: string | null }[]>([])
  const isLoading = ref(false)
  const isLoaded = ref(false)
  const currentOrgId = ref<string | null>(null)
  let loadPromise: Promise<void> | null = null

  const appNames = computed(() => {
    const names: { [appId: string]: string } = {}
    apps.value.forEach((app) => {
      names[app.app_id] = app.name || app.app_id
    })
    return names
  })

  const appIds = computed(() => apps.value.map(app => app.app_id))

  async function fetchApps(force = false) {
    const organizationStore = useOrganizationStore()
    const targetOrgId = organizationStore.currentOrganization?.gid

    // Quick check: if already loaded for the SAME org and not forcing, return immediately
    if (!force && isLoaded.value && currentOrgId.value === targetOrgId) {
      return
    }

    try {
      await organizationStore.dedupFetchOrganizations()
      await organizationStore.awaitInitialLoad()
    }
    catch (error) {
      console.error('Error preparing organization data for apps fetch:', error)
      return
    }
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      apps.value = []
      currentOrgId.value = null
      isLoaded.value = true
      return
    }

    if (isLoading.value) {
      if (loadPromise)
        await loadPromise
      // After waiting, check if we now have the right org's data
      if (!force && isLoaded.value && currentOrgId.value === orgId) {
        return
      }
    }

    // Reset if organization changed
    if (currentOrgId.value !== orgId) {
      reset()
      currentOrgId.value = orgId
    }

    isLoading.value = true

    const supabase = useSupabase()
    const request = (async () => {
      try {
        const { data } = await supabase
          .from('apps')
          .select('app_id, name')
          .eq('owner_org', orgId)

        apps.value = data || []
        isLoaded.value = true
      }
      catch (error) {
        console.error('Error fetching apps:', error)
        apps.value = []
      }
      finally {
        isLoading.value = false
        loadPromise = null
      }
    })()

    loadPromise = request
    await request

    // After load, publish resolver for app names
    const display = useDisplayStore()
    display.setAppNameResolver(appId => appNames.value[appId])
  }

  function upsertApp(app: { app_id: string, name: string | null }) {
    const existingIndex = apps.value.findIndex(item => item.app_id === app.app_id)
    if (existingIndex >= 0) {
      apps.value[existingIndex] = { ...apps.value[existingIndex], ...app }
      return
    }

    apps.value = [...apps.value, app]
    isLoaded.value = true
  }

  function reset() {
    apps.value = []
    isLoaded.value = false
    isLoading.value = false
    currentOrgId.value = null
  }

  return {
    // State
    apps,
    isLoading,
    isLoaded,
    currentOrgId,

    // Getters
    appNames,
    appIds,

    // Actions
    fetchApps,
    upsertApp,
    reset,
  }
})
