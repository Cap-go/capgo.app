import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConsole } from '~/services/console'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDisplayStore } from '~/stores/display'

// Columns every channel page reads (information, devices, statistics, history).
const CHANNEL_PAGE_COLUMNS = `
    id,
    name,
    public,
    owner_org,
    version:app_versions!channels_version_fkey(
      id,
      name,
      app_id,
      created_at,
      min_update_version,
      storage_provider,
      link,
      comment
    ),
    rollout_version,
    rollout_percentage_bps,
    rollout_enabled,
    rollout_id,
    rollout_paused_at,
    rollout_pause_reason,
    rollout_cache_ttl_seconds,
    paused_at,
    auto_pause_enabled,
    auto_pause_window_minutes,
    auto_pause_failure_rate_bps,
    auto_pause_confidence,
    auto_pause_min_attempts,
    auto_pause_min_failures,
    auto_pause_action,
    auto_pause_cooldown_minutes,
    auto_pause_last_triggered_at,
    rollout_version_info:app_versions!channels_rollout_version_fkey(
      id,
      name
    ),
    created_at,
    app_id,
    allow_emulator,
    allow_device,
    allow_dev,
    allow_prod,
    allow_device_self_set,
    disable_auto_update_under_native,
    disable_auto_update,
    update_package,
    ios,
    android,
    electron,
    updated_at
`

async function readChannelRow(channelId: number) {
  const { data, error } = await useConsole()
    .from('channels')
    .select(CHANNEL_PAGE_COLUMNS)
    .eq('id', channelId)
    .single()
  if (error) {
    console.error('no channel', error)
    return null
  }
  return data
}

/**
 * The channel row a channel page shows (information, devices, statistics,
 * history).
 *
 * A row cached in the app detail store renders at once and is then refreshed in
 * the background, because the bundle may have changed since (bundle page, CLI,
 * API or a teammate). Each read gets a generation and only the newest read of a
 * still mounted page applies, so an older background read never overwrites a
 * newer forced read, nor another channel's page after navigation.
 */
export function useChannelRecord<T extends { id: number, name?: string | null }>(options: {
  /** Turns a cached or freshly read row into the page value. */
  normalize?: (row: any) => T
} = {}) {
  const { t } = useI18n()
  const appDetailStore = useAppDetailStore()
  const displayStore = useDisplayStore()
  const channel = ref<T>()
  const normalize = options.normalize ?? ((row: any) => row as T)
  let readGeneration = 0
  let navigationGeneration = 0
  onBeforeUnmount(() => {
    readGeneration++
    navigationGeneration++
  })

  function show(value: T) {
    channel.value = value as any
    if (value.name)
      displayStore.setChannelName(String(value.id), value.name)
    displayStore.NavTitle = value.name ?? t('channel')
  }

  async function load(channelId: number, force = false): Promise<void> {
    if (!channelId)
      return
    const generation = ++readGeneration
    if (!force && appDetailStore.currentChannelId === channelId && appDetailStore.currentChannel) {
      show(normalize(appDetailStore.currentChannel))
      void load(channelId, true)
      return
    }
    try {
      const row = await readChannelRow(channelId)
      if (generation !== readGeneration)
        return
      if (!row) {
        // Never leave another channel's row under this channel's URL (writes use
        // the route id). A failed refresh of the shown channel keeps its row.
        if (channel.value?.id !== channelId)
          channel.value = undefined
        return
      }
      const value = normalize(row)
      appDetailStore.setChannel(channelId, value as any)
      show(value)
    }
    catch (error) {
      console.error(error)
    }
  }

  /**
   * Starts a page load for the current route. The returned check turns false
   * once a newer navigation started or the page unmounted: test it after every
   * await before touching shared state (title, back link).
   */
  function beginNavigation() {
    const generation = ++navigationGeneration
    return () => generation === navigationGeneration
  }

  return { channel, load, beginNavigation }
}
