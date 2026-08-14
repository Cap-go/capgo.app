import type { Database } from '~/types/supabase.types'
import { ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

interface UseAppPageOptions {
  routeName: '/app/[app].settings' | '/app/[app].settings.access' | '/app/[app].observe.logs' | '/app/[app].getting-started'
  navTitle?: string
}

export function useAppPage(options: UseAppPageOptions) {
  const id = ref('')
  const route = useRoute(options.routeName)
  const lastPath = ref('')
  const isLoading = ref(false)
  const supabase = useSupabase()
  const displayStore = useDisplayStore()
  const app = ref<Database['public']['Tables']['apps']['Row']>()
  let loadGeneration = 0

  async function loadAppInfo() {
    try {
      const { data: dataApp } = await supabase
        .from('apps')
        .select()
        .eq('app_id', id.value)
        .single()
      return dataApp
    }
    catch (error) {
      console.error(error)
      return null
    }
  }

  async function refreshData(generation: number) {
    isLoading.value = true
    try {
      const dataApp = await loadAppInfo()
      if (generation !== loadGeneration)
        return
      app.value = dataApp || undefined
    }
    catch (error) {
      if (generation !== loadGeneration)
        return
      console.error(error)
      app.value = undefined
    }
    finally {
      if (generation === loadGeneration)
        isLoading.value = false
    }
  }

  watchEffect(async () => {
    if (route.params.app && lastPath.value !== route.path) {
      lastPath.value = route.path
      id.value = route.params.app as string
      const generation = ++loadGeneration
      await refreshData(generation)
      if (generation !== loadGeneration)
        return
      displayStore.NavTitle = options.navTitle ?? ''
      displayStore.defaultBack = '/apps'
    }
  })

  return { id, app, isLoading }
}
