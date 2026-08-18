import type { RealtimeChannel } from '@supabase/supabase-js'
import { useEventBus } from '@vueuse/core'
import { onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { shouldShowCLIActivity } from '~/services/cliActivity'
import { useSupabase } from '~/services/supabase'
import { isUploadReplicationEvent, showUploadReplicationToast } from '~/services/updateReplicationToast'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

interface CLIActivityPayload {
  event: string
  channel: string
  description?: string
  icon?: string
  app_id?: string
  org_id: string
  channel_name?: string
  bundle_name?: string
  timestamp: string
}

function getRouteForEvent(payload: CLIActivityPayload): string | null {
  const appId = payload.app_id
  if (!appId)
    return null

  const evt = payload.event.toLowerCase()

  if (evt.includes('deleted') && (evt.includes('app') && !evt.includes('bundle')))
    return '/apps'
  if (evt.includes('upload') || evt.includes('bundle') || evt.includes('external') || evt.includes('unlink'))
    return `/app/${appId}/bundles`
  if (evt.includes('channel'))
    return `/app/${appId}/channels`
  if (evt.includes('app'))
    return `/app/${appId}`

  return `/app/${appId}`
}

export function useRealtimeCLIFeed() {
  const supabase = useSupabase()
  const main = useMainStore()
  const orgStore = useOrganizationStore()
  const router = useRouter()
  const { t } = useI18n()
  const bundleUploadedEvent = useEventBus<string>('bundle-uploaded')

  let currentChannel: RealtimeChannel | null = null
  const isConnected = ref(false)

  function isEnabled(): boolean {
    const prefs = main.user?.email_preferences
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))
      return true
    const feedPref = (prefs as Record<string, unknown>).cli_realtime_feed
    return typeof feedPref === 'boolean' ? feedPref : true
  }

  function subscribe(orgId: string) {
    unsubscribe()
    if (!isEnabled())
      return

    const channelName = `cli-events:org:${orgId}`
    currentChannel = supabase.channel(channelName)

    currentChannel
      .on('broadcast', { event: 'cli-activity' }, (message) => {
        const payload = message.payload as CLIActivityPayload
        showToast(payload)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          isConnected.value = true
          await currentChannel?.track({
            user_id: main.user?.id,
            online_at: new Date().toISOString(),
          })
        }
        else {
          isConnected.value = false
        }
      })
  }

  function unsubscribe() {
    if (currentChannel) {
      supabase.removeChannel(currentChannel)
      currentChannel = null
      isConnected.value = false
    }
  }

  function showToast(payload: CLIActivityPayload) {
    if (!shouldShowCLIActivity(payload))
      return

    const route = getRouteForEvent(payload)
    const icon = payload.icon ?? '📡'
    const title = `${icon} ${payload.event}`
    const description = payload.description
      ?? (payload.app_id ? `App: ${payload.app_id}` : undefined)
    const actionLabel = t('view')
    const onAction = route ? () => router.push(route) : undefined

    if (isUploadReplicationEvent(payload.event)) {
      if (payload.app_id)
        bundleUploadedEvent.emit(payload.app_id)

      showUploadReplicationToast({
        eventLabel: payload.event,
        route,
        actionLabel,
        onAction,
      })
      return
    }

    if (route) {
      toast(title, {
        description,
        duration: 15000,
        action: {
          label: actionLabel,
          onClick: () => router.push(route),
        },
      })
    }
    else {
      toast(title, {
        description,
        duration: 10000,
      })
    }
  }

  // Re-subscribe when org changes
  watch(
    () => orgStore.currentOrganization?.gid,
    (orgId) => {
      if (orgId)
        subscribe(orgId)
      else
        unsubscribe()
    },
    { immediate: true },
  )

  // React to user toggling the setting
  watch(
    () => {
      const prefs = main.user?.email_preferences
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))
        return undefined
      return (prefs as Record<string, unknown>).cli_realtime_feed
    },
    (enabled) => {
      const orgId = orgStore.currentOrganization?.gid
      if (enabled === false) {
        unsubscribe()
      }
      else if (orgId && !currentChannel) {
        subscribe(orgId)
      }
    },
  )

  onUnmounted(() => unsubscribe())

  return { isConnected }
}
