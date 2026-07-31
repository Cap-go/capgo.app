import type { Database } from '~/types/supabase.types'
import { ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

interface UseAppPageOptions {
  routeName: '/app/[app].settings' | '/app/[app].settings.access' | '/app/[app].observe.logs'
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

  async function loadAppInfo() {
    try {
      const { data: dataApp } = await supabase
        .from('apps')
        .select()
        .eq('app_id', id.value)
        .single()
      app.value = dataApp || app.value
    }
    catch (error) {
      console.error(error)
    }
  }

  async function refreshData() {
    isLoading.value = true
    try {
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
      displayStore.NavTitle = options.navTitle ?? ''
      displayStore.defaultBack = '/apps'
    }
  })

  return { id, app, isLoading }
}
