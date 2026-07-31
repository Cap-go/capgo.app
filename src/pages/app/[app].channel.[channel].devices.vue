<script setup lang="ts">
import type { OrganizationRole } from '~/stores/organization'
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import plusOutline from '~icons/ion/add-outline'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { withBuiltinChannelVersion } from '~/services/versions'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

interface Channel {
  version: Database['public']['Tables']['app_versions']['Row']
}

const route = useRoute('/app/[app].channel.[channel].devices')
const router = useRouter()
const dialogStore = useDialogV2Store()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const appDetailStore = useAppDetailStore()
const { t } = useI18n()
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const deviceIds = ref<string[]>([])
const channel = ref<Database['public']['Tables']['channels']['Row'] & Channel>()
const deviceIdInput = ref('')
const role = ref<OrganizationRole | null>(null)

function countLowercaseLetters(str: string) {
  const matches = str.match(/[a-z]/g)
  return matches ? matches.length : 0
}

function countCapitalLetters(str: string) {
  const matches = str.match(/[A-Z]/g)
  return matches ? matches.length : 0
}

const deviceIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function AddDevice() {
  deviceIdInput.value = ''

  dialogStore.openDialog({
    title: t('type-device-id'),
    description: t('type-device-id-msg'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('continue'),
        role: 'primary',
        handler: async () => {
          await customDeviceOverwritePart3()
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}

async function customDeviceOverwritePart3() {
  const input = deviceIdInput.value
  const deviceId = input

  if (!deviceIdRegex.test(input)) {
    toast.error(t('invalid-uuid'))
    return false
  }

  const bigLetters = countCapitalLetters(input)
  const smallLetters = countLowercaseLetters(input)

  if (bigLetters === smallLetters) {
    toast.error(t('cannot-determine-platform'))
    return false
  }
  const platform = bigLetters > smallLetters ? 'ios' : 'android'

  await customDeviceOverwritePart4(deviceId, platform)
}

async function customDeviceOverwritePart4(
  deviceId: string,
  platform: 'ios' | 'android',
) {
  dialogStore.openDialog({
    title: t('confirm-overwrite'),
    description: t('confirm-overwrite-msg').replace('$1', deviceId).replace('$2', channel.value?.name ?? '').replace('$3', channel.value?.version?.name ?? t('channel-builtin')),
    buttons: [
      {
        text: t('no'),
        role: 'cancel',
      },
      {
        text: t('yes'),
        role: 'primary',
        handler: async () => {
          await customDeviceOverwritePart5(deviceId, platform)
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}

async function setChannelDeviceOverride(deviceId: string) {
  const { data: currentSession } = await supabase.auth.getSession()!
  const currentJwt = currentSession.session?.access_token
  if (!currentJwt)
    throw new Error('Missing session')

  const response = await fetch(`${defaultApiHost}/private/channel_device`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${currentJwt}`,
    },
    body: JSON.stringify({
      app_id: route.params.app as string,
      channel_id: Number(route.params.channel),
      device_id: deviceId.toLowerCase(),
    }),
  })
  if (!response.ok)
    throw new Error(`Cannot set channel override: HTTP ${response.status}`)
}

async function customDeviceOverwritePart5(
  deviceId: string,
  platform: 'ios' | 'android',
) {
  // Check if this channel is the public (default) channel
  if (channel.value?.public === true) {
    toast.info(t('channel-override-ignored-default'))
    return
  }

  const { error: addDeviceError } = await supabase.functions.invoke('private/create_device', {
    body: {
      device_id: deviceId,
      app_id: route.params.app as string,
      org_id: channel.value?.owner_org ?? '',
      platform,
      version_name: channel.value?.version?.name ?? 'builtin',
    },
  })

  if (addDeviceError) {
    console.error('addDeviceError', addDeviceError)
    toast.error(t('cannot-create-empty-device'))
    return
  }

  try {
    await setChannelDeviceOverride(deviceId)
  }
  catch (error) {
    console.error('overwriteError', error)
    toast.error(t('cannot-create-overwrite'))
    return
  }

  toast.info(t('cloud-replication-delay'))
  reload()
}

async function getDeviceIds() {
  if (!channel.value)
    return
  try {
    const { data: dataDevices } = await supabase
      .from('channel_devices')
      .select('device_id')
      .eq('channel_id', id.value)
      .eq('app_id', channel.value.app_id)
    if (dataDevices && dataDevices.length)
      deviceIds.value = dataDevices.map(d => d.device_id)
    else
      deviceIds.value = []
  }
  catch (error) {
    console.error(error)
  }
}

async function getChannel() {
  if (!id.value)
    return

  // Check if we already have this channel in the store
  if (appDetailStore.currentChannelId === id.value && appDetailStore.currentChannel) {
    channel.value = withBuiltinChannelVersion(appDetailStore.currentChannel as any) as any
    if (channel.value?.name)
      displayStore.setChannelName(String(channel.value.id), channel.value.name)
    displayStore.NavTitle = channel.value?.name ?? t('channel')
    return
  }

  try {
    const { data, error } = await supabase
      .from('channels')
      .select(`
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
          created_at,
          app_id,
          allow_emulator,
          allow_device,
          allow_dev,
          allow_prod,
          allow_device_self_set,
          disable_auto_update_under_native,
          disable_auto_update,
          ios,
          android,
          updated_at
        `)
      .eq('id', id.value)
      .single()
    if (error) {
      console.error('no channel', error)
      return
    }

    channel.value = withBuiltinChannelVersion(data as any) as unknown as Database['public']['Tables']['channels']['Row'] & Channel

    // Store in appDetailStore
    appDetailStore.setChannel(id.value, channel.value)

    if (channel.value?.name)
      displayStore.setChannelName(String(channel.value.id), channel.value.name)
    displayStore.NavTitle = channel.value?.name ?? t('channel')
  }
  catch (error) {
    console.error(error)
  }
}

async function reload() {
  await getChannel()
  await getDeviceIds()
}

watchEffect(async () => {
  if (route.path.includes('/channel/') && route.path.includes('/devices')) {
    loading.value = true
    packageId.value = route.params.app as string
    id.value = Number(route.params.channel as string)
    await getChannel()
    await getDeviceIds()
    loading.value = false
    if (!channel.value?.name)
      displayStore.NavTitle = t('channel')
    displayStore.defaultBack = `/app/${route.params.app}/channels`

    // Load role
    await organizationStore.awaitInitialLoad()
    role.value = await organizationStore.getCurrentRoleForApp(packageId.value)
  }
})
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="channel">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
          <DeviceTable v-if="deviceIds.length > 0" :app-id="channel.version.app_id" :ids="deviceIds" :channel="channel" show-add-button @add-device="AddDevice" />
          <template v-else-if="!dialogStore.showDialog">
            <div class="py-4 text-center">
              <div>{{ t('forced-devices-not-found') }}</div>
              <div class="mt-4 text-white cursor-pointer d-btn d-btn-primary" @click="AddDevice">
                <plusOutline />
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('channel-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('channel-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/channels`)">
        {{ t('back-to-channels') }}
      </button>
    </div>

    <!-- Teleport Content for Add Device Modal -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('type-device-id')" defer to="#dialog-v2-content">
      <div class="space-y-4">
        <FormKit
          v-model="deviceIdInput"
          type="text"
          :placeholder="t('device-id-placeholder')"
          :label="t('device-id')"
          validation="required|uuid"
        />
      </div>
    </Teleport>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
