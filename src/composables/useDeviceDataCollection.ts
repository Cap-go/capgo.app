import type { MaybeRefOrGetter } from 'vue'
import type { DeviceDataCollection } from '~/services/deviceDataCollection'
import { ref, toValue, watch } from 'vue'
import { useConsole } from '~/services/console'
import { DEVICE_DATA_COLLECTION_KEYS, parseAppRowDeviceDataCollection } from '~/services/deviceDataCollection'

function hiddenDeviceDataCollection(): DeviceDataCollection {
  return Object.fromEntries(
    DEVICE_DATA_COLLECTION_KEYS.map(key => [key, false]),
  ) as DeviceDataCollection
}

export function useDeviceDataCollection(appId: MaybeRefOrGetter<string>) {
  const capgo = useConsole()
  const collection = ref<DeviceDataCollection>(hiddenDeviceDataCollection())
  let loadGeneration = 0

  async function load() {
    const generation = ++loadGeneration
    const id = toValue(appId)
    if (!id)
      return
    collection.value = hiddenDeviceDataCollection()
    const { data, error } = await capgo
      .from('apps')
      .select('device_data_collection')
      .eq('app_id', id)
      .maybeSingle()
    if (generation !== loadGeneration)
      return
    if (error || !data)
      return
    collection.value = parseAppRowDeviceDataCollection(data as unknown)
  }

  watch(() => toValue(appId), () => {
    void load()
  }, { immediate: true })

  return { collection, load }
}
