import type { MaybeRefOrGetter, Ref } from 'vue'
import { ref, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { defaultApiHost, useSupabase } from '~/services/supabase'

export function useNativeObserveStats<T>(
  appId: MaybeRefOrGetter<string>,
  params: () => Record<string, unknown>,
  logContext: string,
) {
  const supabase = useSupabase()
  const { t } = useI18n()
  const stats = ref<T | null>(null) as Ref<T | null>
  const statsLoading = ref(false)
  let latestRequest = 0

  async function fetchStats() {
    const currentAppId = toValue(appId)
    if (!currentAppId)
      return

    const requestId = ++latestRequest
    statsLoading.value = true
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session) {
        if (requestId === latestRequest)
          toast.error(t('not-authenticated'))
        return
      }

      const response = await fetch(`${defaultApiHost}/private/native_observe_stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify({
          app_id: currentAppId,
          ...params(),
        }),
      })

      if (requestId !== latestRequest)
        return

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error(`Failed to fetch ${logContext}:`, errorData)
        toast.error(t('failed-to-fetch-native-observe-stats'))
        return
      }

      stats.value = await response.json() as T
    }
    catch (error) {
      if (requestId !== latestRequest)
        return
      console.error(`Error fetching ${logContext}:`, error)
      toast.error(t('failed-to-fetch-native-observe-stats'))
    }
    finally {
      if (requestId === latestRequest)
        statsLoading.value = false
    }
  }

  return { stats, statsLoading, fetchStats }
}
