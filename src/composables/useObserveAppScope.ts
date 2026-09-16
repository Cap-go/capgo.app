import type { Database } from '~/types/supabase.types'
import { computed, ref, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

export function useObserveAppScope() {
  const route = useRoute()
  const router = useRouter()
  const supabase = useSupabase()
  const displayStore = useDisplayStore()

  const id = ref('')
  const lastAppParam = ref('')
  const isLoading = ref(false)
  let latestRefreshRequest = 0
  const selectedVersionName = ref('')
  const bundleNames = ref<string[]>([])
  const app = ref<Database['public']['Tables']['apps']['Row']>()
  const publicChannels = ref<{ id: number, name: string, versionName: string }[]>([])

  const appRouteSegment = computed(() => {
    const match = route.path.match(/^\/app\/([^/]+)/)
    return match ? match[1] : encodeURIComponent(id.value)
  })

  function ensureBundleName(name: string) {
    if (name && !bundleNames.value.includes(name))
      bundleNames.value = [name, ...bundleNames.value]
  }

  async function loadBundleNames() {
    if (!id.value)
      return

    const appId = id.value
    const { data, error } = await supabase
      .from('app_versions')
      .select('name')
      .eq('app_id', appId)
      .eq('deleted', false)
      .order('created_at', { ascending: false })
      .limit(200)

    if (appId !== id.value)
      return

    if (error || !data) {
      bundleNames.value = selectedVersionName.value ? [selectedVersionName.value] : []
      return
    }

    bundleNames.value = [...new Set(data.map(row => row.name).filter(Boolean))]
    ensureBundleName(selectedVersionName.value)
  }

  async function loadAppInfo() {
    const appId = id.value
    if (!appId) {
      app.value = undefined
      publicChannels.value = []
      return
    }
    try {
      const { data: dataApp } = await supabase
        .from('apps')
        .select()
        .eq('app_id', appId)
        .single()
      if (appId !== id.value)
        return
      app.value = dataApp ?? undefined

      const { data: channelsData } = await supabase
        .from('channels')
        .select(`
        id,
        name,
        version:app_versions!channels_version_fkey(id, name)
      `)
        .eq('app_id', appId)
        .eq('public', true)
        .order('id', { ascending: true })

      if (appId !== id.value)
        return

      const uniqueByVersion = new Map<string, { id: number, name: string, versionName: string }>()
      for (const channel of channelsData ?? []) {
        const version = channel.version as { id?: number, name?: string } | { id?: number, name?: string }[] | null | undefined
        const versionRow = Array.isArray(version) ? version[0] : version
        const versionName = versionRow?.name
        if (!versionName || uniqueByVersion.has(versionName))
          continue
        uniqueByVersion.set(versionName, { id: channel.id, name: channel.name, versionName })
      }
      publicChannels.value = [...uniqueByVersion.values()]
    }
    catch (error) {
      if (appId !== id.value)
        return
      console.error(error)
      app.value = undefined
      publicChannels.value = []
    }
  }

  async function refreshAppScope() {
    const refreshId = ++latestRefreshRequest
    isLoading.value = true
    try {
      await Promise.all([loadAppInfo(), loadBundleNames()])
    }
    catch (error) {
      console.error(error)
    }
    finally {
      if (refreshId === latestRefreshRequest)
        isLoading.value = false
    }
  }

  async function applyVersionFilter(name: string) {
    if (selectedVersionName.value === name)
      return
    ensureBundleName(name)
    selectedVersionName.value = name
    const query = { ...route.query }
    if (name)
      query.version = name
    else
      delete query.version
    await router.replace({ query })
  }

  watchEffect(async () => {
    const rawApp = 'app' in route.params ? route.params.app : undefined
    const appParam = typeof rawApp === 'string' ? rawApp : Array.isArray(rawApp) ? rawApp[0] : undefined
    if (appParam && lastAppParam.value !== appParam) {
      lastAppParam.value = appParam
      id.value = appParam
      app.value = undefined
      publicChannels.value = []
      bundleNames.value = []
      selectedVersionName.value = typeof route.query.version === 'string' ? route.query.version : ''
      await refreshAppScope()
      displayStore.NavTitle = ''
      displayStore.defaultBack = '/apps'
    }
  })

  watchEffect(() => {
    const version = typeof route.query.version === 'string' ? route.query.version : ''
    if (selectedVersionName.value !== version) {
      ensureBundleName(version)
      selectedVersionName.value = version
    }
  })

  return {
    id,
    app,
    isLoading,
    selectedVersionName,
    bundleNames,
    publicChannels,
    appRouteSegment,
    ensureBundleName,
    applyVersionFilter,
    refreshAppScope,
  }
}
