import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDisplayStore } from '~/stores/display'

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
  /** Reads the channel row; null when it cannot be read. */
  read: (channelId: number) => Promise<unknown>
  /** Turns a cached or freshly read row into the page value. */
  normalize?: (row: any) => T
}) {
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
      const row = await options.read(channelId)
      if (!row || generation !== readGeneration)
        return
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
