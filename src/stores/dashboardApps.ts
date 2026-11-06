import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useConsole } from '~/services/console'
import { readAllConsoleRows } from '~/services/consoleRows'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from './organization'

export const useDashboardAppsStore = defineStore('dashboardApps', () => {
  const apps = ref<{ app_id: string, name: string | null }[]>([])
  const isLoading = ref(false)
  const isLoaded = ref(false)
  const currentOrgId = ref<string | null>(null)
  let loadPromise: Promise<void> | null = null
  let loadGeneration = 0

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
    }
    catch (error) {
      console.error('Error preparing organization data for apps fetch:', error)
      return
    }
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      reset()
      isLoaded.value = true
      return
    }

    if (currentOrgId.value === orgId && loadPromise)
      return loadPromise

    if (!force && isLoaded.value && currentOrgId.value === orgId)
      return

    // Reset if organization changed
    if (currentOrgId.value !== orgId) {
      reset()
      currentOrgId.value = orgId
    }

    isLoading.value = true

    const capgo = useConsole()
    const generation = loadGeneration
    const isCurrent = () => generation === loadGeneration && organizationStore.currentOrganization?.gid === orgId
    const request = (async () => {
      try {
        const { data, error } = await readAllConsoleRows<{ app_id: string, name: string | null }>((from, to) => {
          if (!isCurrent())
            return Promise.resolve({ data: [], error: null })
          return capgo
            .from('apps')
            .select('app_id, name')
            .eq('owner_org', orgId)
            .order('app_id')
            .range(from, to)
        })

        if (!isCurrent())
          return
        if (error)
          throw error

        apps.value = data || []
        isLoaded.value = true
        const display = useDisplayStore()
        display.setAppNameResolver(appId => appNames.value[appId])
      }
      catch (error) {
        if (!isCurrent())
          return
        console.error('Error fetching apps:', error)
      }
    })()

    loadPromise = request
    try {
      await request
    }
    finally {
      if (loadPromise === request) {
        isLoading.value = false
        loadPromise = null
      }
    }
  }

  function upsertApp(app: { app_id: string, name: string | null, ownerOrgId?: string | null }) {
    const organizationStore = useOrganizationStore()
    const ownerOrgId = app.ownerOrgId ?? organizationStore.currentOrganization?.gid ?? null
    if (ownerOrgId && currentOrgId.value && ownerOrgId !== currentOrgId.value)
      return
    if (ownerOrgId && !currentOrgId.value)
      currentOrgId.value = ownerOrgId

    const nextApp = { app_id: app.app_id, name: app.name }
    const existingIndex = apps.value.findIndex(item => item.app_id === nextApp.app_id)
    if (existingIndex >= 0) {
      apps.value[existingIndex] = { ...apps.value[existingIndex], ...nextApp }
      return
    }

    apps.value = [...apps.value, nextApp]
  }

  function reset() {
    loadGeneration += 1
    loadPromise = null
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
