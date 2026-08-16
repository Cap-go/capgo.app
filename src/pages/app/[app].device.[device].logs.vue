<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDisplayStore } from '~/stores/display'

const displayStore = useDisplayStore()
const { t } = useI18n()
const router = useRouter()
const route = useRoute('/app/[app].device.[device].logs')
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<string>()
const isLoading = ref(true)
const appDetailStore = useAppDetailStore()

const device = ref<Database['public']['Tables']['devices']['Row']>()

async function getDevice() {
  if (!id.value)
    return

  // Check if we already have this device in the store
  if (appDetailStore.currentDeviceId === id.value && appDetailStore.currentDevice) {
    device.value = appDetailStore.currentDevice
    if (device.value) {
      const pretty = device.value.device_id
      if (pretty)
        displayStore.setDeviceName(device.value.device_id, pretty)
      displayStore.NavTitle = pretty || t('device')
    }
    return
  }

  try {
    const { data: currentSession } = await supabase.auth.getSession()!
    if (!currentSession.session)
      return
    const currentJwt = currentSession.session.access_token

    try {
      const response = await fetch(`${defaultApiHost}/private/devices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${currentJwt ?? ''}`,
        },
        body: JSON.stringify({
          appId: packageId.value,
          deviceIds: [id.value],
          limit: 1,
        }),
      })

      if (!response.ok) {
        console.log('Cannot get device', response.status)
        return
      }

      const dataD = await response.json() as { data: Database['public']['Tables']['devices']['Row'][], nextCursor?: string, hasMore: boolean }
      const data = dataD.data?.[0]
      device.value = data

      // Store in appDetailStore
      if (device.value) {
        appDetailStore.setDevice(id.value, device.value)

        const pretty = device.value.device_id
        if (pretty)
          displayStore.setDeviceName(device.value.device_id, pretty)
        displayStore.NavTitle = pretty || t('device')
      }
    }
    catch (err) {
      console.log('Cannot get device', err)
    }
  }
  catch (error) {
    console.error('no devices', error)
  }
}

watchEffect(async () => {
  if (route.path.includes('/device/') && route.path.includes('/logs')) {
    isLoading.value = true
    packageId.value = route.params.app as string
    id.value = route.params.device as string
    id.value = id.value!.toLowerCase()
    await getDevice()
    isLoading.value = false
    if (!displayStore.NavTitle)
      displayStore.NavTitle = t('device')
    displayStore.defaultBack = `/app/${route.params.app}/devices`
  }
})
</script>

<template>
  <div>
    <PageLoader v-if="isLoading" />
    <div v-else-if="device" id="logs">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
          <LogTable
            class="p-3"
            :device-id="id"
            :app-id="packageId"
          />
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('device-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('device-not-found-description') }}
      </p>
      <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/devices`)">
        {{ t('back-to-devices') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
