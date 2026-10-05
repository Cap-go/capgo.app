import type { MaybeRefOrGetter } from 'vue'
import type { DeviceDataCollection } from '~/services/deviceDataCollection'
import { ref, toValue, watch } from 'vue'
import { DEFAULT_DEVICE_DATA_COLLECTION, parseAppRowDeviceDataCollection } from '~/services/deviceDataCollection'
import { useSupabase } from '~/services/supabase'

export function useDeviceDataCollection(appId: MaybeRefOrGetter<string>) {
  const supabase = useSupabase()
  const collection = ref<DeviceDataCollection>({ ...DEFAULT_DEVICE_DATA_COLLECTION })
  let loadGeneration = 0

  async function load() {
    const generation = ++loadGeneration
    const id = toValue(appId)
    if (!id)
      return
    const { data } = await supabase
      .from('apps')
      .select('device_data_collection')
      .eq('app_id', id)
      .maybeSingle()
    if (generation !== loadGeneration)
      return
    collection.value = parseAppRowDeviceDataCollection(data as unknown)
  }

  watch(() => toValue(appId), () => {
    void load()
  }, { immediate: true })

  return { collection, load }
}
