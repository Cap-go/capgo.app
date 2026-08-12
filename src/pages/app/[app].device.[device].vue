<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { greaterThan, parse } from '@std/semver'
import { computedAsync, onClickOutside } from '@vueuse/core'
import { ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconExternalLink from '~icons/heroicons/arrow-top-right-on-square'
import IconCopy from '~icons/heroicons/clipboard-document-check'
import IconCode from '~icons/heroicons/code-bracket'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconDown from '~icons/material-symbols/keyboard-arrow-down-rounded'
import ChannelOverrideRetentionNotice from '~/components/ChannelOverrideRetentionNotice.vue'
import { useDeviceUpdateFormat } from '~/composables/useDeviceUpdateFormat'
import { formatDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDisplayStore } from '~/stores/display'

interface Channel {
  version: Database['public']['Tables']['app_versions']['Row']
}

const displayStore = useDisplayStore()
const { t } = useI18n()
const router = useRouter()
const route = useRoute('/app/[app].device.[device]')
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<string>()
const isLoading = ref(true)
const appDetailStore = useAppDetailStore()

const device = ref<Database['public']['Tables']['devices']['Row']>()
const channels = ref<(Database['public']['Tables']['channels']['Row'] & Channel)[]>([])
const channelDevice = ref<Database['public']['Tables']['channels']['Row']>()
const reloadCount = ref(0)

const canManageDevices = computedAsync(async () => {
  if (!packageId.value)
    return false
  return await checkPermissions('app.manage_devices', { appId: packageId.value })
}, false)

// Channel dropdown state
const channelDropdown = ref<HTMLDetailsElement>()

// Device update format composable
const { transformDeviceToUpdateRequest } = useDeviceUpdateFormat()
const showDebugSection = ref(false)

onClickOutside(channelDropdown, () => closeChannelDropdown())

async function getChannels() {
  try {
    const { data } = await supabase
      .from('channels')
      .select(`
        id,
        name,
        created_at,
        updated_at,
        public
      `)
      .eq('app_id', packageId.value)
      .throwOnError()
    channels.value = (data ?? []) as (Database['public']['Tables']['channels']['Row'] & Channel)[]
  }
  catch (error) {
    console.error(error)
    channels.value = []
  }
}

async function getChannelOverride() {
  try {
    const { data, error } = await supabase
      .from('channel_devices')
      .select(`
        device_id,
        app_id,
        channel_id (
          name,
          id,
          version:app_versions!channels_version_fkey(
            name,
            id
          )
        ),
        created_at,
        updated_at
      `)
      .eq('app_id', packageId.value)
      .eq('device_id', id.value as string)
      .single()
      .throwOnError()
    if (error) {
      console.error('getChannelOverride', error)
      return
    }
    channelDevice.value = data.channel_id as any as Database['public']['Tables']['channels']['Row']
  }
  catch {
    channelDevice.value = undefined
  }
}

async function getVersionInfo() {
  if (device.value?.version && !device.value?.version_name) {
    const { data: dataVersion } = await supabase
      .from('app_versions')
      .select(`
          name
      `)
      .eq('id', device.value!.version)
      .single()

    if (dataVersion)
      device.value.version_name = dataVersion.name
  }
  if (!device.value?.version && device.value?.version_name) {
    const { data: dataVersion } = await supabase
      .from('app_versions')
      .select(`
          id
      `)
      .eq('name', device.value!.version_name)
      .single()

    if (dataVersion)
      device.value.version = dataVersion.id
  }
}
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
      await getVersionInfo()
    }
    catch (err) {
      console.log('Cannot get device', err)
    }
  }
  catch (error) {
    console.error('no devices', error)
  }
}

function minVersion(val: string, min = '4.6.99') {
  return greaterThan(parse(val), parse(min))
}

async function loadData() {
  isLoading.value = true
  await Promise.all([
    getDevice(),
    getChannelOverride(),
    getChannels(),
  ])
  reloadCount.value += 1
  isLoading.value = false
}

async function upsertDevChannel(device: string, channelId: number) {
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
      device_id: device.toLowerCase(),
      channel_id: channelId,
      app_id: packageId.value,
    }),
  })
  if (!response.ok)
    throw new Error(`Cannot set channel override: HTTP ${response.status}`)
}

async function delDevChannel(device: string) {
  const { data: currentSession } = await supabase.auth.getSession()!
  const currentJwt = currentSession.session?.access_token
  if (!currentJwt)
    throw new Error('Missing session')

  const response = await fetch(`${defaultApiHost}/private/channel_device`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${currentJwt}`,
    },
    body: JSON.stringify({
      device_id: device.toLowerCase(),
      app_id: packageId.value,
    }),
  })
  if (!response.ok)
    throw new Error(`Cannot delete channel override: HTTP ${response.status}`)
}

function closeChannelDropdown() {
  if (channelDropdown.value) {
    channelDropdown.value.removeAttribute('open')
  }
}

function isPublicChannelSelection(value: string) {
  if (value === 'none')
    return false
  const selectedChannel = channels.value.find(ch => ch.id === Number(value))
  return selectedChannel?.public === true
}

async function handlePublicChannelSelection() {
  const deviceId = device.value?.device_id
  if (channelDevice.value && deviceId) {
    await delDevChannel(deviceId)
    await loadData()
  }
  toast.info(t('channel-override-ignored-default'))
}

async function unlinkDeviceChannel() {
  const deviceId = device.value?.device_id
  if (deviceId)
    await delDevChannel(deviceId)
  toast.success(t('unlink-channel'))
  toast.info(t('cloud-replication-delay'))
  await loadData()
}

async function linkDeviceChannel(value: string) {
  const deviceId = device.value?.device_id
  if (deviceId) {
    try {
      await upsertDevChannel(deviceId, Number(value))
      toast.success(t('channel-linked'))
      toast.info(t('cloud-replication-delay'))
      await loadData()
    }
    catch (error) {
      console.error(error)
      toast.error(t('channel-link-fail'))
    }
  }
  else {
    toast.error(t('channel-link-fail'))
  }
}

async function onSelectChannel(value: string) {
  if (!canManageDevices.value) {
    toast.error(t('no-permission'))
    return
  }

  try {
    if (isPublicChannelSelection(value)) {
      await handlePublicChannelSelection()
    }
    else if (channelDevice.value && value === 'none') {
      await unlinkDeviceChannel()
    }
    else if (value !== 'none') {
      await linkDeviceChannel(value)
    }
    else {
      toast.error(t('channel-link-fail'))
    }
  }
  catch (error) {
    console.error(error)
    toast.error(t('channel-link-fail'))
  }
  finally {
    closeChannelDropdown()
  }
}

watchEffect(async () => {
  if (route.path.includes('/device/') && !route.path.includes('/deployments') && !route.path.includes('/logs')) {
    packageId.value = route.params.app as string
    id.value = route.params.device as string
    id.value = id.value!.toLowerCase()
    await loadData()
    if (!displayStore.NavTitle)
      displayStore.NavTitle = t('device')
    displayStore.defaultBack = `/app/${route.params.app}/devices`
  }
})

function openChannel() {
  if (packageId.value && channelDevice.value?.id)
    router.push(`/app/${packageId.value}/channel/${channelDevice.value.id}`)
}
function openDefaultChannel() {
  if (packageId.value && device.value?.default_channel) {
    const defaultChannel = channels.value.find(ch => ch.name === device.value?.default_channel)
    if (defaultChannel)
      router.push(`/app/${packageId.value}/channel/${defaultChannel.id}`)
  }
}
function openBundle() {
  if (packageId.value && device.value?.version)
    router.push(`/app/${packageId.value}/bundle/${device.value.version}`)
}

function getCurlCommand() {
  if (!device.value)
    return ''

  const defaultChannel = device.value.default_channel || ''
  const requestBody = transformDeviceToUpdateRequest(device.value, packageId.value, defaultChannel, channelDevice.value?.name)
  const jsonBody = JSON.stringify(requestBody, null, 2)

  return String.raw`curl -X POST '${defaultApiHost}/updates' \
  -H 'Content-Type: application/json' \
  -d '${jsonBody}'`
}

async function copyCurlCommand() {
  try {
    const curl = getCurlCommand()
    await navigator.clipboard.writeText(curl)
    toast.success(t('copy-success'))
  }
  catch (error) {
    console.error('Failed to copy curl command:', error)
    toast.error(t('copy-fail'))
  }
}
</script>

<template>
  <div>
    <PageLoader v-if="isLoading" />
    <div v-else-if="device" id="devices" class="mt-0 md:mt-8">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div v-if="device.plugin_version === '0.0.0'" class="my-2 mr-auto ml-auto text-center text-white rounded-2xl border-8 bg-[#ef4444] w-fit border-[#ef4444]">
          {{ t('device-injected') }}
          <br>
          {{ t('device-injected-2') }}
        </div>
        <div class="flex flex-col bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
          <dl :key="reloadCount" class="divide-y divide-slate-200 dark:divide-slate-500">
            <InfoRow :label="t('device-id')">
              {{ device.device_id }}
            </InfoRow>
            <InfoRow v-if="device.custom_id" :label="t('custom-id')">
              {{ device.custom_id }}
            </InfoRow>
            <InfoRow v-if="device.updated_at" :label="t('last-update')">
              {{ formatDate(device.updated_at) }}
            </InfoRow>
            <InfoRow v-if="device.platform" :label="t('platform')">
              {{ device.platform }}
            </InfoRow>
            <InfoRow v-if="device.plugin_version" :label="t('plugin-version')">
              {{ device.plugin_version }}
            </InfoRow>
            <InfoRow v-if="device.version_name" :label="t('version')" is-link @click="openBundle()">
              {{ device.version_name }}
            </InfoRow>
            <InfoRow v-if="device.version_build" :label="t('version-builtin')">
              {{ device.version_build }}
            </InfoRow>
            <InfoRow v-if="device.os_version" :label="t('os-version')">
              {{ device.os_version }}
            </InfoRow>
            <InfoRow v-if="minVersion(device.plugin_version) && device.is_emulator != null" :label="t('is-emulator')">
              {{ device.is_emulator ? t('yes') : t('no') }}
            </InfoRow>
            <InfoRow v-if="minVersion(device.plugin_version) && device.is_prod != null" :label="t('is-production-app')">
              {{ device.is_prod ? t('yes') : t('no') }}
            </InfoRow>
            <InfoRow v-if="device.key_id" :label="t('public-key-prefix')">
              {{ device.key_id }}
            </InfoRow>
            <InfoRow v-if="device.country_code" :label="t('country')">
              {{ device.country_code }}
            </InfoRow>
            <InfoRow v-if="device.default_channel" :label="t('default-channel')">
              <div class="flex items-center gap-2">
                <span class="font-medium text-gray-900 dark:text-white">
                  {{ device.default_channel }}
                </span>
                <IconExternalLink class="w-4 h-4 text-blue-600 cursor-pointer dark:text-blue-400" @click="openDefaultChannel()" />
              </div>
            </InfoRow>
            <InfoRow :label="t('channel-link')">
              <div class="flex flex-col items-end gap-1">
                <div class="flex items-center gap-2">
                  <ChannelOverrideRetentionNotice />
                  <details ref="channelDropdown" class="relative d-dropdown d-dropdown-end" @click.stop>
                    <summary class="d-btn d-btn-outline d-btn-sm">
                      <span>{{ channelDevice?.name ?? t('none') }}</span>
                      <IconDown class="w-4 h-4 ml-1 fill-current" />
                    </summary>
                    <ul class="absolute right-0 z-50 w-48 p-2 mt-1 bg-white shadow-lg top-full d-dropdown-content dark:bg-base-200 rounded-box">
                      <li class="block px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600">
                        <a
                          class="block px-3 py-2 text-gray-900 dark:text-white"
                          @click="onSelectChannel('none')"
                        >
                          {{ t('none') }}
                        </a>
                      </li>
                      <li v-for="ch in channels" :key="ch.id" class="block px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600">
                        <a
                          class="block px-3 py-2 text-gray-900 dark:text-white"
                          @click="onSelectChannel(ch.id.toString())"
                        >
                          {{ ch.name }}
                        </a>
                      </li>
                    </ul>
                  </details>
                  <IconExternalLink v-if="channelDevice" class="w-4 h-4 text-blue-600 cursor-pointer dark:text-blue-400" @click="openChannel()" />
                </div>
                <span v-if="channelDevice" class="text-xs text-gray-500 dark:text-gray-400">
                  {{ t('overriding-default-channel') }}
                </span>
              </div>
            </InfoRow>
          </dl>

          <!-- Debug API Section -->
          <div class="border-t border-slate-300 dark:border-slate-700">
            <button
              class="flex items-center justify-between w-full px-6 py-4 transition-colors dark:hover:bg-slate-700/50 hover:bg-slate-50"
              @click="showDebugSection = !showDebugSection"
            >
              <div class="flex items-center gap-2">
                <IconCode class="w-5 h-5 text-slate-600 dark:text-slate-300" />
                <span class="font-medium text-slate-700 dark:text-slate-200">{{ t('debug-api-request') }}</span>
              </div>
              <IconDown
                class="w-5 h-5 transition-transform text-slate-600 dark:text-slate-300"
                :class="{ 'rotate-180': showDebugSection }"
              />
            </button>

            <div v-if="showDebugSection" class="px-6 pb-4">
              <div class="relative">
                <pre class="p-4 overflow-x-auto text-sm rounded-lg bg-slate-900 text-slate-100"><code>{{ getCurlCommand() }}</code></pre>
                <button
                  class="absolute p-2 transition-colors rounded top-2 right-2 hover:bg-slate-700"
                  :title="t('copy-curl')"
                  @click="copyCurlCommand"
                >
                  <IconCopy class="w-4 h-4 text-slate-300" />
                </button>
              </div>
              <p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
                {{ t('debug-api-description') }}
              </p>
            </div>
          </div>
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
      <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/devices`)">
        {{ t('back-to-devices') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
