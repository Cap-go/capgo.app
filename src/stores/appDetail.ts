import type { Database } from '~/types/database.types'
import { defineStore } from 'pinia'
import { ref } from 'vue'

type App = Database['public']['Tables']['apps']['Row']
type Bundle = Database['public']['Tables']['app_versions']['Row']
type Channel = Database['public']['Tables']['channels']['Row']
type Device = Database['public']['Tables']['devices']['Row']

export const useAppDetailStore = defineStore('appDetail', () => {
  // Current app data
  const currentApp = ref<App | null>(null)
  const currentAppId = ref<string>('')

  // Current bundle data
  const currentBundle = ref<Bundle | null>(null)
  const currentBundleId = ref<number | null>(null)

  // Current channel data
  const currentChannel = ref<Channel | null>(null)
  const currentChannelId = ref<number | null>(null)

  // Current device data
  const currentDevice = ref<Device | null>(null)
  const currentDeviceId = ref<string>('')

  function setApp(appId: string, app: App | null) {
    currentAppId.value = appId
    currentApp.value = app
  }

  function setBundle(bundleId: number, bundle: Bundle | null) {
    currentBundleId.value = bundleId
    currentBundle.value = bundle
  }

  function setChannel(channelId: number, channel: Channel | null) {
    currentChannelId.value = channelId
    currentChannel.value = channel
  }

  function setDevice(deviceId: string, device: Device | null) {
    currentDeviceId.value = deviceId
    currentDevice.value = device
  }

  function clearApp() {
    currentApp.value = null
    currentAppId.value = ''
  }

  function clearBundle() {
    currentBundle.value = null
    currentBundleId.value = null
  }

  function clearChannel() {
    currentChannel.value = null
    currentChannelId.value = null
  }

  function clearDevice() {
    currentDevice.value = null
    currentDeviceId.value = ''
  }

  function clearAll() {
    clearApp()
    clearBundle()
    clearChannel()
    clearDevice()
  }

  return {
    // App
    currentApp,
    currentAppId,
    setApp,
    clearApp,

    // Bundle
    currentBundle,
    currentBundleId,
    setBundle,
    clearBundle,

    // Channel
    currentChannel,
    currentChannelId,
    setChannel,
    clearChannel,

    // Device
    currentDevice,
    currentDeviceId,
    setDevice,
    clearDevice,

    // Clear all
    clearAll,
  }
})
