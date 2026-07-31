<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { Camera } from '@capacitor/camera'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { computedAsync } from '@vueuse/core'
import mime from 'mime'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ArrowDownTray from '~icons/heroicons/arrow-down-tray?raw'
import ArrowUpTray from '~icons/heroicons/arrow-up-tray?raw'
import Pencil from '~icons/heroicons/pencil-square'
import transfer from '~icons/mingcute/transfer-horizontal-line?raw&width=36&height=36'
import gearSix from '~icons/ph/gear-six?raw'
import iconName from '~icons/ph/user?raw'
import Toggle from '~/components/Toggle.vue'
import { checkPermissions } from '~/services/permissions'
import { createSignedImageUrl, getImmediateImageUrl } from '~/services/storage'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'

const props = defineProps<{ appId: string }>()
const DOWNLOAD_PLATFORMS = ['ios', 'android', 'electron'] as const
type DownloadPlatform = typeof DOWNLOAD_PLATFORMS[number]
interface DownloadChannel {
  id: number
  name: string
  ios: boolean
  android: boolean
  electron: boolean
  public: boolean
}

const isLoading = ref(false)
const isFirstLoading = ref(true)
const router = useRouter()
const supabase = useSupabase()
const appRef = ref<Database['public']['Tables']['apps']['Row'] & { owner_org: Database['public']['Tables']['orgs']['Row'] } | null>(null)
const { t } = useI18n()
const dialogStore = useDialogV2Store()
const forceBump = ref(0)
const forceDownloadBump = ref(0)
const organizationStore = useOrganizationStore()
const transferAppIdInput = ref('')
const selectedChannel = ref('')
const uploadSearch = ref('')
const channels = ref<DownloadChannel[]>([])
const selectedDownloadChannelIds = ref<Record<DownloadPlatform, number | null>>({ ios: null, android: null, electron: null })
const splitDownloadDefaults = ref(false)
const disableDownloadUpdates = ref(false)
const selectedCombinedChannelId = ref<number | null>(null)
const combinedSearch = ref('')
const downloadSearches = reactive<Record<DownloadPlatform, string>>({ ios: '', android: '', electron: '' })

const canUpdateSettings = computedAsync(async () => {
  if (!appRef.value)
    return false
  return await checkPermissions('app.update_settings', { appId: props.appId })
}, false)

const canDeleteApp = computedAsync(async () => {
  if (!appRef.value)
    return false
  return await checkPermissions('app.delete', { appId: props.appId })
}, false)

const DEFAULT_BUILD_TIMEOUT_SECONDS = 15 * 60
const MIN_BUILD_TIMEOUT_MINUTES = 5
const MAX_BUILD_TIMEOUT_MINUTES = 360

// Retention presets (value in seconds)
const RETENTION_PRESETS = [
  { value: 0, labelKey: 'retention-immediate' },
  { value: 604800, labelKey: 'retention-7-days' },
  { value: 2592000, labelKey: 'retention-30-days' },
  { value: 7776000, labelKey: 'retention-90-days' },
  { value: 15552000, labelKey: 'retention-6-months' },
  { value: 31536000, labelKey: 'retention-1-year' },
  { value: 63113904, labelKey: 'retention-never' },
  { value: -1, labelKey: 'retention-custom' },
]

const selectedRetentionPreset = ref<number>(2592000)
const customRetentionValue = ref<number>(0)
const isImportingStoreIcon = ref(false)
const isAppIconLoading = ref(false)

const isCustomRetention = computed(() => selectedRetentionPreset.value === -1)

const retentionOptions = computed(() => {
  return RETENTION_PRESETS.map(preset => ({
    label: t(preset.labelKey),
    value: preset.value,
  }))
})

const effectiveRetentionValue = computed(() => {
  return selectedRetentionPreset.value === -1
    ? customRetentionValue.value
    : selectedRetentionPreset.value
})

const buildTimeoutMinutes = computed(() => Math.trunc((appRef.value?.build_timeout_seconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS) / 60))

function initializeRetentionPreset() {
  const current = appRef.value?.retention ?? 2592000
  const preset = RETENTION_PRESETS.find(p => p.value !== -1 && p.value === current)
  if (preset) {
    selectedRetentionPreset.value = preset.value
  }
  else {
    selectedRetentionPreset.value = -1
    customRetentionValue.value = current
  }
}

let appIconLoadRun = 0
async function loadAppSettingIcon(rawIconUrl: string | null | undefined, run: number) {
  if (!rawIconUrl || getImmediateImageUrl(rawIconUrl)) {
    if (run === appIconLoadRun)
      isAppIconLoading.value = false
    return
  }

  isAppIconLoading.value = true
  try {
    const signedIconUrl = await createSignedImageUrl(rawIconUrl)
    if (!signedIconUrl || run !== appIconLoadRun || !appRef.value)
      return

    appRef.value.icon_url = signedIconUrl
  }
  catch (error) {
    console.warn('Cannot load signed app setting icon', { appId: props.appId, error })
  }
  finally {
    if (run === appIconLoadRun)
      isAppIconLoading.value = false
  }
}

onMounted(async () => {
  isLoading.value = true

  const [{ error, data }] = await Promise.all([
    supabase
      .from('apps')
      .select('*, owner_org ( name, id )')
      .eq('app_id', props.appId)
      .single(),
  ])

  if (error) {
    toast.error(t('cannot-load-app-settings'))
    return
  }

  await organizationStore.awaitInitialLoad()
  const rawIconUrl = data.icon_url
  const iconLoadRun = ++appIconLoadRun
  appRef.value = {
    ...(data as any),
    icon_url: getImmediateImageUrl(rawIconUrl) || null,
  }
  void loadAppSettingIcon(rawIconUrl, iconLoadRun)
  initializeRetentionPreset()
  await loadChannels()
  isLoading.value = false
  isFirstLoading.value = false
})

const acronym = computed(() => {
  const words = appRef.value?.name?.split(' ') ?? []
  let res = appRef.value?.name?.slice(0, 2) || 'AP'
  if (words?.length > 1)
    res = words[0][0] + words[1][0]
  return res.toUpperCase()
})

async function didCancel(name: string) {
  dialogStore.openDialog({
    title: t('alert-confirm-delete'),
    description: `${t('alert-not-reverse-message')} ${t('alert-delete-message')} ${name}?`,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-delete'),
        role: 'danger',
        id: 'confirm-button',
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function deleteApp() {
  if (await didCancel(t('app')))
    return

  if (!canDeleteApp.value) {
    toast.error(t('no-permission'))
    return
  }

  try {
    const org = organizationStore.getOrgByAppId(props.appId)
    const { error: errorIcon } = await supabase.storage
      .from(`images`)
      .remove([`org/${org?.gid}/${props.appId}/icon`])
    if (errorIcon)
      toast.error(t('cannot-delete-app-icon'))

    const { error: dbAppError } = await supabase
      .from('apps')
      .delete()
      .eq('app_id', props.appId)
    if (dbAppError)
      toast.error(t('cannot-delete-app'))

    else
      toast.success(t('app-deleted'))

    // return to home
    router.push('/apps')
  }
  catch (error) {
    console.error(error)
    toast.error(t('cannot-delete-app'))
  }
}

async function submit(form: {
  app_name: string
  ios_store_url?: string
  android_store_url?: string
  expose_metadata: boolean
  allow_preview: boolean
  allow_device_custom_id: boolean
  block_provider_infra_requests: boolean
  build_timeout_minutes?: number | string
}) {
  isLoading.value = true
  if (!canUpdateSettings.value) {
    toast.error(t('no-permission'))
    isLoading.value = false
    return
  }

  try {
    await updateAppName(form.app_name)
  }
  catch (error) {
    toast.error(error as string)
  }

  try {
    await updateStoreUrls(form.ios_store_url ?? '', form.android_store_url ?? '')
  }
  catch (error) {
    toast.error(error as string)
  }

  try {
    await updateAppRetention(effectiveRetentionValue.value)
  }
  catch (error) {
    toast.error(error as string)
  }

  try {
    await updateBuildTimeout(form.build_timeout_minutes)
  }
  catch (error) {
    toast.error(error as string)
  }

  try {
    await updateExposeMetadata(form.expose_metadata)
  }
  catch (error) {
    toast.error(error as string)
  }

  try {
    await updateAllowPreview(form.allow_preview)
  }
  catch (error) {
    toast.error(error as string)
  }

  try {
    // Defensive: avoid flipping the flag if the value is missing/invalid.
    if (typeof form.allow_device_custom_id === 'boolean')
      await updateAllowDeviceCustomId(form.allow_device_custom_id)
  }
  catch (error) {
    toast.error(error as string)
  }

  try {
    if (typeof form.block_provider_infra_requests === 'boolean')
      await updateBlockProviderInfraRequests(form.block_provider_infra_requests)
  }
  catch (error) {
    toast.error(error as string)
  }

  isLoading.value = false
}

const storeImportUrl = computed(() => appRef.value?.ios_store_url || appRef.value?.android_store_url || '')
const shouldShowStoreIconImport = computed(() => !appRef.value?.icon_url && !isAppIconLoading.value && !!storeImportUrl.value)

function normalizeStoreUrl(rawUrl: string, expectedHost: 'apps.apple.com' | 'play.google.com') {
  const trimmedUrl = rawUrl.trim()
  if (!trimmedUrl)
    return null

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmedUrl)
  }
  catch {
    throw new Error(`Please enter a valid ${expectedHost === 'apps.apple.com' ? 'App Store' : 'Google Play'} link`)
  }

  if (parsedUrl.hostname !== expectedHost)
    throw new Error(`Please use a valid ${expectedHost === 'apps.apple.com' ? 'App Store' : 'Google Play'} link`)

  return trimmedUrl
}

async function updateStoreUrls(newIosStoreUrl: string, newAndroidStoreUrl: string) {
  const iosStoreUrl = normalizeStoreUrl(newIosStoreUrl, 'apps.apple.com')
  const androidStoreUrl = normalizeStoreUrl(newAndroidStoreUrl, 'play.google.com')
  const currentIosStoreUrl = appRef.value?.ios_store_url ?? null
  const currentAndroidStoreUrl = appRef.value?.android_store_url ?? null

  if (iosStoreUrl === currentIosStoreUrl && androidStoreUrl === currentAndroidStoreUrl)
    return Promise.resolve()

  const { error } = await supabase
    .from('apps')
    .update({
      ios_store_url: iosStoreUrl,
      android_store_url: androidStoreUrl,
    })
    .eq('app_id', props.appId)

  if (error)
    return Promise.reject(new Error('Unable to update the store link'))

  if (appRef.value) {
    appRef.value.ios_store_url = iosStoreUrl
    appRef.value.android_store_url = androidStoreUrl
  }

  toast.success('Store link updated')
}

async function uploadIconFromSource(iconSourceUrl: string) {
  if (!appRef.value)
    throw new Error('App not loaded')

  const response = await fetch(iconSourceUrl)
  if (!response.ok)
    throw new Error('Unable to download the store icon')

  const blob = await response.blob()
  const contentType = blob.type || 'image/png'
  const iconPath = `org/${appRef.value.owner_org.id}/${props.appId}/icon`

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(iconPath, blob, {
      contentType,
      upsert: true,
    })

  if (uploadError) {
    console.error(uploadError)
    throw new Error(t('upload-img-error'))
  }

  const { error: updateError } = await supabase
    .from('apps')
    .update({ icon_url: iconPath })
    .eq('app_id', props.appId)

  if (updateError) {
    console.error(updateError)
    throw new Error(t('upload-img-error'))
  }

  appRef.value.icon_url = await createSignedImageUrl(iconPath)
  isAppIconLoading.value = false
}

async function importIconFromStore() {
  if (!canUpdateSettings.value) {
    toast.error(t('no-permission'))
    return
  }

  if (!storeImportUrl.value) {
    toast.error('Add a store link first')
    return
  }

  isImportingStoreIcon.value = true

  try {
    const { data, error } = await supabase.functions.invoke('app/store-metadata', {
      method: 'POST',
      body: { url: storeImportUrl.value },
    })

    if (error)
      throw new Error(error.message || 'Unable to import the store icon')

    const iconSource = data?.icon_data_url || data?.icon_url
    if (!iconSource)
      throw new Error('No icon found for this store link')

    await uploadIconFromSource(iconSource)
    toast.success('Store icon imported')
  }
  catch (error) {
    console.error(error)
    toast.error(error instanceof Error ? error.message : 'Unable to import the store icon')
  }
  finally {
    isImportingStoreIcon.value = false
  }
}

async function updateAppName(newName: string) {
  if (newName === (appRef.value?.name ?? '')) {
    return Promise.resolve()
  }
  if (newName.length > 32) {
    toast.error(t('new-name-to-long'))
    return Promise.reject(t('new-name-to-long'))
  }

  const { error } = await supabase.from('apps').update({ name: newName }).eq('app_id', props.appId)
  if (error) {
    toast.error(t('cannot-change-name'))
    console.error(error)
    return
  }

  if (appRef.value)
    appRef.value.name = newName

  toast.success(t('changed-app-name'))
}

async function updateAppRetention(newRetention: number) {
  if (newRetention === appRef.value?.retention) {
    return Promise.resolve()
  }

  if (newRetention < 0) {
    return Promise.reject(t('retention-cannot-be-negative'))
  }

  if (newRetention > 63113904) {
    return Promise.reject(t('retention-to-big'))
  }

  const { error } = await supabase.from('apps').update({ retention: newRetention }).eq('app_id', props.appId)
  if (error) {
    return Promise.reject(t('cannot-change-retention'))
  }
  toast.success(t('changed-app-retention'))
  if (appRef.value)
    appRef.value.retention = newRetention
}

async function updateBuildTimeout(rawTimeoutMinutes: number | string | undefined) {
  const timeoutMinutes = Number(rawTimeoutMinutes)
  if (!Number.isFinite(timeoutMinutes))
    throw t('build-timeout-invalid')

  const normalizedMinutes = Math.trunc(timeoutMinutes)
  if (normalizedMinutes < MIN_BUILD_TIMEOUT_MINUTES || normalizedMinutes > MAX_BUILD_TIMEOUT_MINUTES)
    throw t('build-timeout-invalid')

  const timeoutSeconds = normalizedMinutes * 60
  if (timeoutSeconds === appRef.value?.build_timeout_seconds)
    return

  const { error } = await supabase.from('apps').update({ build_timeout_seconds: timeoutSeconds }).eq('app_id', props.appId)
  if (error)
    throw t('cannot-change-build-timeout')

  toast.success(t('changed-build-timeout'))
  if (appRef.value)
    appRef.value.build_timeout_seconds = timeoutSeconds
}

async function updateExposeMetadata(newExposeMetadata: boolean) {
  if (newExposeMetadata === appRef.value?.expose_metadata) {
    return Promise.resolve()
  }

  const { error } = await supabase.from('apps').update({ expose_metadata: newExposeMetadata }).eq('app_id', props.appId)
  if (error) {
    return Promise.reject(t('cannot-change-expose-metadata'))
  }
  toast.success(t('changed-expose-metadata'))
  if (appRef.value)
    appRef.value.expose_metadata = newExposeMetadata
}

async function updateAllowPreview(newAllowPreview: boolean) {
  if (newAllowPreview === appRef.value?.allow_preview) {
    return Promise.resolve()
  }

  const { error } = await supabase.from('apps').update({ allow_preview: newAllowPreview }).eq('app_id', props.appId)
  if (error) {
    return Promise.reject(t('cannot-change-allow-preview'))
  }
  toast.success(t('changed-allow-preview'))
  if (appRef.value)
    appRef.value.allow_preview = newAllowPreview
}

async function updateAllowDeviceCustomId(newAllowDeviceCustomId: boolean) {
  // Defensive: if the backend ever returns null/undefined, treat it as false for
  // comparison so an explicit user toggle will still persist.
  const current = appRef.value?.allow_device_custom_id ?? false
  if (newAllowDeviceCustomId === current) {
    return Promise.resolve()
  }

  const { error } = await supabase.from('apps').update({ allow_device_custom_id: newAllowDeviceCustomId }).eq('app_id', props.appId)
  if (error) {
    return Promise.reject(t('cannot-change-allow-device-custom-id'))
  }
  toast.success(t('changed-allow-device-custom-id'))
  if (appRef.value)
    appRef.value.allow_device_custom_id = newAllowDeviceCustomId
}

async function updateBlockProviderInfraRequests(enabled: boolean) {
  const current = appRef.value?.block_provider_infra_requests ?? false
  if (enabled === current)
    return Promise.resolve()

  const { error } = await supabase.from('apps').update({ block_provider_infra_requests: enabled }).eq('app_id', props.appId)
  if (error)
    return Promise.reject(t('cannot-change-block-provider-infra-requests'))

  toast.success(t('changed-block-provider-infra-requests'))
  if (appRef.value)
    appRef.value.block_provider_infra_requests = enabled
}

async function loadChannels() {
  const { data, error } = await supabase
    .from('channels')
    .select('id, name, ios, android, electron, public')
    .eq('app_id', props.appId)

  if (error) {
    console.error('Cannot load channels', error)
    toast.error(t('cannot-load-channels'))
    return
  }

  channels.value = data ?? []
}

const platformOptions = computed<Record<DownloadPlatform, DownloadChannel[]>>(() => ({
  ios: channels.value.filter(channel => channel.ios),
  android: channels.value.filter(channel => channel.android),
  electron: channels.value.filter(channel => channel.electron),
}))
const availableDownloadPlatforms = computed(() => DOWNLOAD_PLATFORMS.filter(platform => platformOptions.value[platform].length > 0))
const combinedOptions = computed(() => {
  const platforms = availableDownloadPlatforms.value
  if (!platforms.length)
    return []
  return channels.value.filter(channel => platforms.every(platform => channel[platform]))
})
const uploadChannelOptions = computed(() => {
  const seen = new Set<string>()
  return channels.value
    .filter((channel) => {
      if (seen.has(channel.name))
        return false
      seen.add(channel.name)
      return true
    })
    .map(channel => ({ id: channel.id, name: channel.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const filteredUploadChannels = computed(() => filterChannels(uploadChannelOptions.value, uploadSearch.value))

const visibleUploadChannels = computed(() => {
  const list = filteredUploadChannels.value
  if (uploadSearch.value.trim())
    return list
  const primary = list.slice(0, 3)
  if (selectedChannel.value) {
    const selected = list.find(channel => channel.name === selectedChannel.value)
    if (selected && !primary.some(channel => channel.name === selected.name))
      return [...primary, selected]
  }
  return primary
})

const uploadHasHidden = computed(() => !uploadSearch.value.trim() && filteredUploadChannels.value.length > 3)

async function setDefaultChannel() {
  if (!canUpdateSettings.value) {
    toast.error(t('no-permission'))
    return
  }

  await loadChannels()

  if (!uploadChannelOptions.value.length) {
    toast.error(t('no-channels-available'))
    return
  }

  uploadSearch.value = ''
  const currentDefault = appRef.value?.default_upload_channel
  if (currentDefault && uploadChannelOptions.value.some(channel => channel.name === currentDefault))
    selectedChannel.value = currentDefault
  else
    selectedChannel.value = uploadChannelOptions.value[0]?.name ?? ''

  dialogStore.openDialog({
    title: t('select-default-upload-channel-header'),
    description: t('select-default-upload-channel'),
    size: 'lg',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        role: 'primary',
        handler: async () => {
          if (!selectedChannel.value) {
            toast.error(t('please-select-channel'))
            return false
          }

          const matchedChannel = uploadChannelOptions.value.find(channel => channel.name === selectedChannel.value)
          if (!matchedChannel) {
            toast.error(t('channel-not-found'))
            return false
          }

          const { error: appError } = await supabase.from('apps')
            .update({ default_upload_channel: selectedChannel.value })
            .eq('app_id', appRef.value?.app_id ?? '')

          if (appError) {
            toast.error(t('cannot-change-default-upload-channel'))
            console.error(appError)
            return false
          }

          if (appRef.value) {
            appRef.value.default_upload_channel = selectedChannel.value
            forceBump.value += 1
          }
          toast.success(t('updated-default-upload-channel'))
          await loadChannels()
          return true
        },
      },
    ],
  })
}

const canSplitDownloadDefaults = computed(() => availableDownloadPlatforms.value.some(platform => platformOptions.value[platform].length > 0))
const hasCombinedOptions = computed(() => combinedOptions.value.length > 0)

function filterChannels(list: Array<{ id: number, name: string }>, search: string) {
  const term = search.trim().toLowerCase()
  if (!term)
    return list
  return list.filter(channel => channel.name.toLowerCase().includes(term))
}

function getDefaultChannel(platform: DownloadPlatform) {
  return channels.value.find(channel => channel.public && channel[platform]) ?? null
}

const defaultChannelByPlatform = computed<Record<DownloadPlatform, DownloadChannel | null>>(() => ({
  ios: getDefaultChannel('ios'),
  android: getDefaultChannel('android'),
  electron: getDefaultChannel('electron'),
}))

const filteredCombinedOptions = computed(() => filterChannels(combinedOptions.value, combinedSearch.value))
const visibleCombinedOptions = computed(() => {
  const filtered = filteredCombinedOptions.value
  if (combinedSearch.value.trim())
    return filtered

  const visible = filtered.slice(0, 3)
  const selected = filtered.find(channel => channel.id === selectedCombinedChannelId.value)
  return selected && !visible.some(channel => channel.id === selected.id)
    ? [...visible, selected]
    : visible
})
const combinedHasHidden = computed(() => !combinedSearch.value.trim() && filteredCombinedOptions.value.length > visibleCombinedOptions.value.length)

function getFilteredPlatformOptions(platform: DownloadPlatform) {
  return filterChannels(platformOptions.value[platform], downloadSearches[platform])
}

function getVisiblePlatformOptions(platform: DownloadPlatform) {
  const filtered = getFilteredPlatformOptions(platform)
  if (downloadSearches[platform].trim())
    return filtered

  const visible = filtered.slice(0, 3)
  const selected = filtered.find(channel => channel.id === selectedDownloadChannelIds.value[platform])
  return selected && !visible.some(channel => channel.id === selected.id)
    ? [...visible, selected]
    : visible
}

function platformHasHidden(platform: DownloadPlatform) {
  return !downloadSearches[platform].trim() && getFilteredPlatformOptions(platform).length > getVisiblePlatformOptions(platform).length
}

const downloadChannelSections = computed(() => availableDownloadPlatforms.value.map(platform => ({
  platform,
  title: t(`default-download-channel-${platform}-only-title`),
  description: t(`default-download-channel-${platform}-only-desc`),
  empty: t(`default-download-channel-${platform}-only-empty`),
})))

function getSelectedDownloadChannelIds() {
  return Object.fromEntries(DOWNLOAD_PLATFORMS.map(platform => [
    platform,
    platformOptions.value[platform].find(channel => channel.id === defaultChannelByPlatform.value[platform]?.id)?.id ?? null,
  ])) as Record<DownloadPlatform, number | null>
}

function resetDownloadSearches() {
  for (const platform of DOWNLOAD_PLATFORMS)
    downloadSearches[platform] = ''
}

const downloadChannelWarning = computed(() => {
  for (const platform of DOWNLOAD_PLATFORMS) {
    const defaults = channels.value.filter(channel => channel.public && channel[platform])
    if (defaults.length > 1)
      return t('default-download-channel-conflict')
  }

  const platforms = availableDownloadPlatforms.value
  for (const sourcePlatform of platforms) {
    const sourceDefault = defaultChannelByPlatform.value[sourcePlatform]
    if (!sourceDefault)
      continue

    for (const targetPlatform of platforms) {
      if (sourcePlatform === targetPlatform)
        continue

      const targetDefault = defaultChannelByPlatform.value[targetPlatform]
      if (targetDefault && sourceDefault.id !== targetDefault.id && sourceDefault[targetPlatform])
        return t('default-download-channel-conflict')
    }
  }

  return ''
})

function joinPlatformLabels(platforms: readonly DownloadPlatform[]) {
  const labels = platforms.map(platform => t(`platform-${platform}`))
  if (labels.length <= 1)
    return labels[0] ?? ''
  if (labels.length === 2)
    return labels.join(' & ')
  return `${labels.slice(0, -1).join(', ')} & ${labels[labels.length - 1]}`
}

const downloadChannelLabel = computed(() => {
  if (!channels.value.length)
    return t('default-download-channel-empty')

  const platforms = availableDownloadPlatforms.value
  const defaults = platforms.map(platform => defaultChannelByPlatform.value[platform])

  if (!defaults.some(Boolean))
    return t('capgo-updates-disabled')

  const firstDefault = defaults[0]
  if (firstDefault && defaults.every(channel => channel?.id === firstDefault.id))
    return `${firstDefault.name} (${joinPlatformLabels(platforms)})`

  return platforms
    .map((platform) => {
      const channel = defaultChannelByPlatform.value[platform]
      const label = t(`platform-${platform}`)
      return `${label}: ${channel ? channel.name : t('not-set')}`
    })
    .join(' • ')
})

async function openDefaultDownloadChannelDialog() {
  if (!canUpdateSettings.value) {
    toast.error(t('no-permission'))
    return
  }

  await loadChannels()

  if (!channels.value.length) {
    toast.error(t('no-channels-available'))
    return
  }

  combinedSearch.value = ''
  resetDownloadSearches()

  const platforms = availableDownloadPlatforms.value
  const defaultChannels = platforms.map(platform => defaultChannelByPlatform.value[platform])
  const firstDefault = defaultChannels[0]
  disableDownloadUpdates.value = !defaultChannels.some(Boolean)
  const sameDefaultChannel = !!firstDefault
    && defaultChannels.every(channel => channel?.id === firstDefault.id)
    && platforms.every(platform => firstDefault[platform])

  if (hasCombinedOptions.value && (!canSplitDownloadDefaults.value || sameDefaultChannel))
    splitDownloadDefaults.value = false
  else if (!hasCombinedOptions.value && canSplitDownloadDefaults.value)
    splitDownloadDefaults.value = true
  else if (defaultChannels.filter(Boolean).some(channel => channel?.id !== firstDefault?.id))
    splitDownloadDefaults.value = true
  else
    splitDownloadDefaults.value = !hasCombinedOptions.value

  const combinedFallback = combinedOptions.value.find(channel => platforms.some(platform => channel.id === defaultChannelByPlatform.value[platform]?.id))
    ?? combinedOptions.value[0]
    ?? null
  selectedCombinedChannelId.value = combinedFallback?.id ?? null

  selectedDownloadChannelIds.value = getSelectedDownloadChannelIds()

  if (!splitDownloadDefaults.value && selectedCombinedChannelId.value == null && combinedFallback)
    selectedCombinedChannelId.value = combinedFallback.id

  dialogStore.openDialog({
    title: t('select-default-download-channel-header'),
    size: 'lg',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        role: 'primary',
        handler: async () => {
          if (disableDownloadUpdates.value) {
            const { error } = await supabase
              .from('channels')
              .update({ public: false })
              .eq('app_id', props.appId)

            if (error) {
              toast.error(t('cannot-change-default-download-channel'))
              console.error(error)
              return false
            }

            channels.value = channels.value.map(channel => ({
              ...channel,
              public: false,
            }))
            await loadChannels()
            forceDownloadBump.value += 1
            toast.success(t('disabled-capgo-updates'))
            return true
          }

          if (!hasCombinedOptions.value && !canSplitDownloadDefaults.value) {
            toast.error(t('no-compatible-download-channel'))
            return false
          }

          const selectedChannels: Record<DownloadPlatform, DownloadChannel | null> = { ios: null, android: null, electron: null }
          const activePlatforms = availableDownloadPlatforms.value

          if (!splitDownloadDefaults.value) {
            if (selectedCombinedChannelId.value == null) {
              toast.error(t('please-select-combined-channel'))
              return false
            }
            const combinedChannel = combinedOptions.value.find(channel => channel.id === selectedCombinedChannelId.value) ?? null
            if (!combinedChannel) {
              toast.error(t('please-select-combined-channel'))
              return false
            }
            for (const platform of activePlatforms)
              selectedChannels[platform] = combinedChannel
          }
          else {
            for (const platform of activePlatforms) {
              const selectedId = selectedDownloadChannelIds.value[platform]

              if (selectedId == null && platformOptions.value[platform].length) {
                toast.error(t(`please-select-channel-${platform}`))
                return false
              }

              const selectedChannel = selectedId == null
                ? null
                : channels.value.find(channel => channel.id === selectedId) ?? null

              if (selectedChannel && !selectedChannel[platform]) {
                toast.error(t(`channel-not-compatible-with-${platform}`))
                return false
              }

              selectedChannels[platform] = selectedChannel
            }
          }

          for (const sourcePlatform of activePlatforms) {
            const sourceChannel = selectedChannels[sourcePlatform]
            if (!sourceChannel)
              continue

            for (const targetPlatform of activePlatforms) {
              if (sourcePlatform === targetPlatform)
                continue

              const targetChannel = selectedChannels[targetPlatform]
              if (sourceChannel[targetPlatform] && targetChannel?.id !== sourceChannel.id) {
                toast.error(t('default-download-channel-conflict'))
                return false
              }
            }
          }

          const idsToEnable = Array.from(new Set(Object.values(selectedChannels).map(channel => channel?.id).filter((id): id is number => typeof id === 'number')))

          if (idsToEnable.length > 0) {
            const { error } = await supabase
              .from('channels')
              .update({ public: true })
              .in('id', idsToEnable)
            if (error) {
              toast.error(t('cannot-change-default-download-channel'))
              console.error(error)
              return false
            }
          }

          for (const platform of DOWNLOAD_PLATFORMS) {
            if (!platformOptions.value[platform].length)
              continue

            const selectedChannel = selectedChannels[platform]
            let platformUpdate = supabase
              .from('channels')
              .update({ public: false })
              .eq('app_id', props.appId)
              .eq(platform, true)

            if (selectedChannel)
              platformUpdate = platformUpdate.neq('id', selectedChannel.id)

            const { error } = await platformUpdate
            if (error) {
              toast.error(t('cannot-change-default-download-channel'))
              console.error(error)
              return false
            }
          }

          const { error: hiddenError } = await supabase
            .from('channels')
            .update({ public: false })
            .eq('app_id', props.appId)
            .eq('ios', false)
            .eq('android', false)
            .eq('electron', false)

          if (hiddenError) {
            toast.error(t('cannot-change-default-download-channel'))
            console.error(hiddenError)
            return false
          }

          const newPublicIds = new Set(idsToEnable)
          channels.value = channels.value.map(channel => ({
            ...channel,
            public: newPublicIds.has(channel.id),
          }))

          await loadChannels()
          forceDownloadBump.value += 1
          toast.success(t('updated-default-download-channel'))
          return true
        },
      },
    ],
  })
}

function setUnifiedDownloadMode(unified: boolean) {
  if (unified) {
    if (!hasCombinedOptions.value) {
      toast.error(t('default-download-channel-no-unified'))
      return
    }
    splitDownloadDefaults.value = false
    const fallback = combinedOptions.value.find(channel => channel.id === selectedCombinedChannelId.value)
      ?? combinedOptions.value.find(channel => availableDownloadPlatforms.value.some(platform => channel.id === defaultChannelByPlatform.value[platform]?.id))
      ?? combinedOptions.value[0]
    selectedCombinedChannelId.value = fallback?.id ?? null
  }
  else {
    if (!canSplitDownloadDefaults.value) {
      toast.error(t('default-download-channel-split-unavailable'))
      return
    }
    splitDownloadDefaults.value = true
    selectedDownloadChannelIds.value = getSelectedDownloadChannelIds()
  }
}

async function editPhoto() {
  if (!canUpdateSettings.value) {
    toast.error(t('no-permission'))
    return
  }

  dialogStore.openDialog({
    title: t('what-to-do-with-photo'),
    description: `${t('what-to-do-with-photo-dec')}`,
    size: 'sm',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('change'),
        id: 'verify',
        handler: async () => {
          const rawPhotos = await Camera.pickImages({
            limit: 1,
            quality: 100,
          }).catch(err => console.log(err))

          if (!rawPhotos || rawPhotos.photos.length === 0) {
            toast.error(t('canceled-photo-selection'))
            return false
          }

          const photos = rawPhotos.photos

          const blob = await fetch(photos[0].webPath).then(async r => await r.arrayBuffer())
          const mimeType = mime.getType(photos[0].format)

          if (!mimeType) {
            toast.error(t('unknown-mime'))
            console.error(`Unknown mime type for ${photos[0].format}`)
            return false
          }

          const iconPath = `org/${appRef.value?.owner_org.id}/${props.appId}/icon`
          const { error } = await supabase.storage
            .from('images')
            .upload(iconPath, blob, {
              contentType: mimeType,
            })

          if (error) {
            toast.error(t('upload-img-error'))
            console.error(`Cannot upload picture: ${JSON.stringify(error)}`)
            return false
          }

          const { error: appUpdateErr } = await supabase.from('apps')
            .update({ icon_url: iconPath })
            .eq('app_id', props.appId)

          if (appUpdateErr) {
            toast.error(t('upload-img-error'))
            console.error(`Cannot upload picture (appUpdateErr): ${appUpdateErr}`)
            return false
          }

          if (appRef.value) {
            appRef.value.icon_url = await createSignedImageUrl(iconPath)
            isAppIconLoading.value = false
          }

          toast.success(t('picture-uploaded'))
        },
      },
      {
        text: t('delete'),
        id: 'verify',
        role: 'danger',
        handler: async () => {
          if (!appRef.value?.icon_url) {
            toast.error(t('no-app-icon'))
            return false
          }

          const { error } = await supabase
            .storage
            .from(`images`)
            .remove([`org/${appRef.value?.owner_org.id}/${props.appId}/icon`])

          if (error) {
            console.error('Cannot remove app logo', error)
            toast.error(t('picture-delete-fail'))
            return false
          }

          const { error: setAppError } = await supabase.from('apps')
            .update({ icon_url: '' })
            .eq('app_id', props.appId)

          if (setAppError) {
            console.error('Cannot remove app logo (set app)', error)
            toast.error(t('picture-delete-fail'))
            return false
          }

          toast.success(t('app-logo-deleted'))
          appRef.value.icon_url = ''
        },
      },
    ],
  })
}

function confirmTransferAppOwnership(org: Organization) {
  // Step 3: Final confirmation with app ID input
  transferAppIdInput.value = ''

  dialogStore.openDialog({
    title: t('confirm-transfer'),
    description: `${t('app-will-be-transferred').replace('$ORG_ID', org.name).replace('$APP_ID', props.appId)}`,
    size: 'xl',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('transfer'),
        role: 'danger',
        handler: async () => {
          if (transferAppIdInput.value !== props.appId) {
            toast.error(t('incorrect-app-id'))
            return false
          }
          // Transfer logic will go here
          const { error } = await supabase.rpc('transfer_app', {
            p_app_id: props.appId,
            p_new_org_id: org.gid,
          })
          if (error) {
            toast.error(t('cannot-transfer-app'))
            console.error(error)
            return false
          }
          toast.success(t('app-transferred'))
          setTimeout(() => {
            router.push('/apps')
          }, 2500)
        },
      },
    ],
  })
}

async function transferAppOwnership() {
  const transferHistory: { transferred_at: string }[] = ((appRef.value as any)?.transfer_history as any) ?? []
  const lastTransfer = transferHistory.length > 0
    ? transferHistory.sort((a, b) =>
      new Date(b.transferred_at).getTime() - new Date(a.transferred_at).getTime(),
    )[0]
    : null
  if (lastTransfer && new Date(lastTransfer.transferred_at).getTime() + 32 * 24 * 60 * 60 * 1000 > Date.now()) {
    toast.error(t('transfer-app-ownership-too-soon'))
    return
  }

  // Check if user has permission to transfer this app
  const canTransfer = await checkPermissions('app.transfer', { appId: props.appId })
  if (!canTransfer) {
    toast.error(t('no-permission'))
    return
  }

  // Step 1: Initial confirmation
  dialogStore.openDialog({
    title: t('transfer-app-ownership'),
    description: t('transfer-app-ownership-requirements'),
    size: 'xl',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('ok'),
        role: 'danger',
      },
    ],
  })
  if (await dialogStore.onDialogDismiss())
    return

  // Step 2: Organization selection - filter orgs where user has transfer permission
  const destinationOrgs = await Promise.all(
    organizationStore.organizations
      .filter(org => org.gid !== appRef.value?.owner_org.id)
      .map(async (org) => {
        const hasTransferPermission = await checkPermissions('app.transfer', { orgId: org.gid })
        return hasTransferPermission ? org : null
      }),
  ).then(results => results.filter((org): org is NonNullable<typeof org> => org !== null))

  if (destinationOrgs.length === 0) {
    toast.error(t('no-super-admin-organizations'))
    return
  }

  dialogStore.openDialog({
    title: t('select-destination-organization'),
    description: t('select-organization-to-transfer'),
    size: 'xl',
    preventAccidentalClose: true,
    buttons: [
      ...destinationOrgs.map(org => ({
        text: org.name,
        role: 'secondary' as const,
        preventClose: true,
        handler: () => {
          confirmTransferAppOwnership(org)
        },
      })),
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
    ],
  })
}
</script>

<template>
  <div class="h-full pb-8 md:pb-0 max-h-fit grow">
    <FormKit id="update-app" type="form" :actions="false" @submit="submit">
      <!-- Panel body -->
      <div class="p-6 space-y-6">
        <h2 class="mb-5 text-2xl font-bold dark:text-white text-slate-800">
          {{ t('app-info') }}
        </h2>
        <div class="text-sm dark:text-gray-100">
          {{ t('app-info-desc') }}
        </div>
        <!-- Picture -->
        <section>
          <div class="flex items-center">
            <div class="mr-4">
              <img
                v-if="appRef?.icon_url" class="object-cover w-20 h-20 d-mask d-mask-squircle" :src="appRef?.icon_url"
                width="80" height="80" alt="User upload"
              >
              <div
                v-else-if="isAppIconLoading"
                class="flex items-center justify-center w-20 h-20 bg-gray-700 d-mask d-mask-squircle"
                :aria-label="t('loading')"
              >
                <span class="w-8 h-8 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                <span class="sr-only">{{ t('loading') }}</span>
              </div>
              <div v-else class="p-6 text-xl bg-gray-700 d-mask d-mask-squircle">
                <span class="font-medium text-gray-300">
                  {{ acronym }}
                </span>
              </div>
            </div>
            <button id="change-org-pic" type="button" class="px-3 py-2 text-xs font-medium text-center text-gray-700 border rounded-lg cursor-pointer dark:text-white hover:bg-gray-100 focus:ring-4 focus:ring-blue-300 border-slate-500 dark:hover:bg-gray-600 dark:focus:ring-blue-800 focus:outline-hidden" @click="editPhoto">
              {{ t('change') }}
            </button>
          </div>
        </section>

        <!-- Personal Info -->
        <section v-if="!isFirstLoading && !isLoading">
          <div class="mt-5 space-y-4 sm:flex sm:items-center sm:space-y-0 sm:space-x-4">
            <div class="sm:w-1/2">
              <FormKit
                type="text"
                name="app_id"
                :prefix-icon="iconName"
                :value="appRef?.app_id ?? ''"
                :label="t('app-id')"
                :disabled="true"
              />
              <FormKit
                type="text"
                name="app_name"
                :prefix-icon="iconName"
                :value="appRef?.name ?? ''"
                :label="t('app-name')"
              />
              <FormKit
                type="url"
                name="ios_store_url"
                :value="appRef?.ios_store_url ?? ''"
                label="App Store link"
                placeholder="https://apps.apple.com/..."
              />
              <FormKit
                type="url"
                name="android_store_url"
                :value="appRef?.android_store_url ?? ''"
                label="Google Play link"
                placeholder="https://play.google.com/store/apps/details?id=..."
              />
              <div v-if="shouldShowStoreIconImport" class="mb-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/70">
                <div class="text-sm font-medium text-slate-800 dark:text-slate-100">
                  Import the app icon from the store
                </div>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  Your app does not have an icon yet. We can fetch it from one of the store links above.
                </p>
                <button
                  type="button"
                  class="d-btn d-btn-sm mt-3"
                  :class="{ 'd-btn-disabled': isImportingStoreIcon }"
                  :disabled="isImportingStoreIcon"
                  @click="importIconFromStore"
                >
                  {{ isImportingStoreIcon ? 'Importing...' : 'Import icon' }}
                </button>
              </div>
              <div v-else-if="!appRef?.icon_url" class="mb-3 rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
                Add an App Store or Google Play link to auto-import the app icon if you do not want to upload one manually.
              </div>
              <div
                :key="forceBump"
                class="flex flex-row cursor-pointer"
                role="button"
                tabindex="0"
                @click="setDefaultChannel"
                @keydown.enter.prevent="setDefaultChannel"
                @keydown.space.prevent="setDefaultChannel"
              >
                <FormKit
                  type="text"
                  name="default_upload_channel"
                  class="flex-1 min-w-0"
                  :prefix-icon="ArrowUpTray"
                  :value="appRef?.default_upload_channel ?? t('not-set')"
                  :label="t('default-upload-channel')"
                  :sections-schema="{
                    suffix: {
                      children: [
                        '$slots.suffix',
                      ],
                    },
                    input: {
                      attrs: {
                        readonly: true,
                        class: 'cursor-pointer w-full truncate',
                      },
                    },
                  }"
                >
                  <template #suffix>
                    <button type="button" class="w-6 h-6 ml-auto mr-1" @click.stop="setDefaultChannel">
                      <Pencil width="24px" height="24px" />
                    </button>
                  </template>
                </FormKit>
              </div>
              <div
                :key="`download-${forceDownloadBump}`"
                class="flex flex-row mt-3 cursor-pointer"
                role="button"
                tabindex="0"
                @click="openDefaultDownloadChannelDialog"
                @keydown.enter.prevent="openDefaultDownloadChannelDialog"
                @keydown.space.prevent="openDefaultDownloadChannelDialog"
              >
                <FormKit
                  type="text"
                  name="default_download_channel"
                  class="flex-1 min-w-0"
                  :prefix-icon="ArrowDownTray"
                  :value="downloadChannelLabel"
                  :label="t('default-download-channel')"
                  :sections-schema="{
                    suffix: {
                      children: [
                        '$slots.suffix',
                      ],
                    },
                    help: {
                      children: [
                        '$slots.help',
                      ],
                    },
                    input: {
                      attrs: {
                        readonly: true,
                        class: 'cursor-pointer w-full truncate',
                      },
                    },
                  }"
                >
                  <template #suffix>
                    <button type="button" class="w-6 h-6 ml-auto mr-1" @click.stop="openDefaultDownloadChannelDialog">
                      <Pencil width="24px" height="24px" />
                    </button>
                  </template>
                  <template #help>
                    <span class="block text-xs text-slate-500 dark:text-slate-300">
                      {{ t('default-download-channel-help') }}
                    </span>
                    <span
                      v-if="downloadChannelWarning"
                      class="block mt-1 text-xs font-medium text-amber-600 dark:text-amber-400"
                    >
                      {{ downloadChannelWarning }}
                    </span>
                  </template>
                </FormKit>
              </div>
              <!-- Bundle Retention Setting -->
              <FormKit
                v-model="selectedRetentionPreset"
                type="select"
                name="retention_preset"
                :prefix-icon="gearSix"
                :label="t('retention-label')"
                :options="retentionOptions"
              />
              <div v-if="isCustomRetention">
                <FormKit
                  v-model="customRetentionValue"
                  type="number"
                  number="integer"
                  name="custom_retention"
                  :prefix-icon="gearSix"
                  :label="t('retention-custom-value')"
                  :help="t('retention-custom-help')"
                  :min="0"
                  :max="63113903"
                />
              </div>
              <p v-if="effectiveRetentionValue === 0" class="text-xs font-medium text-amber-600 dark:text-amber-400">
                {{ t('retention-immediate-warning') }}
              </p>
              <p v-if="effectiveRetentionValue >= 63113904" class="text-xs font-medium text-blue-600 dark:text-blue-400">
                {{ t('retention-never-info') }}
              </p>
              <FormKit
                type="number"
                number="integer"
                name="build_timeout_minutes"
                :prefix-icon="gearSix"
                :value="buildTimeoutMinutes"
                :label="t('build-timeout-label')"
                :help="t('build-timeout-help')"
                :min="MIN_BUILD_TIMEOUT_MINUTES"
                :max="MAX_BUILD_TIMEOUT_MINUTES"
              />
              <FormKit
                type="checkbox"
                name="expose_metadata"
                :value="appRef?.expose_metadata ?? false"
                :label="t('expose-metadata')"
                :help="t('expose-metadata-help')"
              />
              <FormKit
                type="checkbox"
                name="allow_preview"
                :value="appRef?.allow_preview ?? false"
                :label="t('allow-preview')"
                :help="t('allow-preview-help')"
              />
              <FormKit
                type="checkbox"
                name="allow_device_custom_id"
                :value="appRef?.allow_device_custom_id ?? false"
                :label="t('allow-device-custom-id')"
                :help="t('allow-device-custom-id-help')"
              />
              <FormKit
                type="checkbox"
                name="block_provider_infra_requests"
                :value="appRef?.block_provider_infra_requests ?? false"
                :label="t('block-provider-infra-requests')"
                :help="t('block-provider-infra-requests-help')"
              />
              <FormKit
                type="button"
                :label="t('transfer-app-ownership')"
                :help="t('change-app-organisation-owner')"
                :prefix-icon="transfer"
                :sections-schema="{
                  outer: {
                    $el: 'div',
                    attrs: {
                      class: 'flex flex-col-reverse',
                    },
                  },
                  help: {
                    attrs: {
                      class: 'block text-neutral-700 text-sm dark:text-neutral-300 mb-1',
                    },
                  },
                  input: {
                    attrs: {
                      class: 'inline-flex items-center px-3 py-2 text-xs font-medium text-center text-gray-700 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 dark:text-white border-slate-500 focus:ring-4 focus:outline-hidden focus:ring-blue-300 dark:focus:ring-blue-800 cursor-pointer',
                    },
                  },
                  prefix: {
                    attrs: {
                      class: 'w-4 h-4 mr-2',
                    },
                  },
                }"
                @click="transferAppOwnership"
              />
            </div>
          </div>
          <FormKitMessages />
        </section>
      </div>
      <!-- Panel footer -->
      <footer>
        <div class="flex flex-col px-6 py-5 border-t dark:border-slate-600">
          <div class="flex self-end">
            <button v-if="canDeleteApp" type="button" class="p-2 text-red-600 border border-red-400 rounded-lg hover:text-white hover:bg-red-600" @click="deleteApp()">
              {{ t('delete-app') }}
            </button>
            <button
              class="p-2 ml-3 text-white bg-blue-500 rounded-lg hover:bg-blue-600 d-btn"
              type="submit"
              color="secondary"
              shape="round"
            >
              <span v-if="!isLoading" class="rounded-4xl">
                {{ t('update') }}
              </span>
              <Spinner v-else size="w-8 h-8" class="px-4" color="fill-gray-100 text-gray-200 dark:text-gray-600" />
            </button>
          </div>
        </div>
      </footer>
    </FormKit>

    <!-- Teleport for Transfer App ID Input -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('confirm-transfer')" defer to="#dialog-v2-content">
      <div class="w-full">
        <label for="transfer-app-id-input" class="sr-only">{{ t('type-app-id-to-confirm') }}</label>
        <input
          id="transfer-app-id-input"
          v-model="transferAppIdInput"
          type="text"
          :placeholder="t('type-app-id-to-confirm')"
          :aria-label="t('type-app-id-to-confirm')"
          class="w-full p-3 border border-gray-300 rounded-lg dark:text-white dark:bg-gray-800 dark:border-gray-600"
        >
      </div>
    </Teleport>

    <!-- Teleport for Default Upload Channel Selection -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('select-default-upload-channel-header')" defer to="#dialog-v2-content">
      <div class="w-full space-y-3">
        <template v-if="uploadChannelOptions.length">
          <label for="upload-channel-search" class="sr-only">{{ t('default-upload-channel-search-placeholder') }}</label>
          <input
            id="upload-channel-search"
            v-model="uploadSearch"
            type="text"
            :placeholder="t('default-upload-channel-search-placeholder')"
            :aria-label="t('default-upload-channel-search-placeholder')"
            class="w-full px-3 py-2 text-sm bg-white border rounded-lg focus:border-blue-500 focus:ring-2 border-slate-200 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 focus:outline-hidden focus:ring-blue-500/20"
          >
          <div v-if="visibleUploadChannels.length" class="space-y-2">
            <label
              v-for="channel in visibleUploadChannels"
              :key="`upload-${channel.name}`"
              :for="`upload-channel-${channel.name}`"
              class="flex items-center gap-3 p-3 transition border rounded-lg hover:border-blue-400 border-slate-200 dark:border-slate-700 dark:hover:border-blue-500"
            >
              <input
                :id="`upload-channel-${channel.name}`"
                v-model="selectedChannel"
                type="radio"
                :value="channel.name"
                class="radio radio-primary"
              >
              <span class="text-sm font-medium">{{ channel.name }}</span>
            </label>
          </div>
          <div v-else class="px-3 py-6 text-sm text-center border border-dashed rounded-lg border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-300">
            {{ t('default-upload-channel-no-results') }}
          </div>
          <p v-if="uploadHasHidden" class="text-xs text-slate-500 dark:text-slate-300">
            {{ t('default-upload-channel-more') }}
          </p>
        </template>
        <div v-else class="py-4 text-center text-gray-500 dark:text-gray-400">
          {{ t('no-channels-available') }}
        </div>
      </div>
    </Teleport>

    <!-- Teleport for Default Download Channel Selection -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('select-default-download-channel-header')" defer to="#dialog-v2-content">
      <div class="w-full space-y-6">
        <a
          class="inline-flex items-center text-sm font-medium text-blue-600 underline transition dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
          href="https://capgo.app/docs/live-updates/channels/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t('default-download-channel-doc-link') }}
        </a>
        <p class="text-sm text-slate-500 dark:text-slate-300">
          {{ t('default-download-channel-dialog-info') }}
        </p>

        <div class="p-4 space-y-2 border rounded-lg border-slate-200 dark:border-slate-700">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {{ t('disable-capgo-updates') }}
              </h3>
              <p class="text-xs text-slate-500 dark:text-slate-300">
                {{ t('disable-capgo-updates-desc') }}
              </p>
            </div>
            <Toggle
              class="shrink-0"
              :value="disableDownloadUpdates"
              @update:value="disableDownloadUpdates = $event"
            />
          </div>
        </div>

        <template v-if="!disableDownloadUpdates">
          <div v-if="hasCombinedOptions" class="p-4 space-y-4 border rounded-lg border-slate-200 dark:border-slate-700">
            <div class="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-start">
              <div>
                <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {{ t('default-download-channel-use-unified') }}
                </h3>
                <p class="text-xs text-slate-500 dark:text-slate-300">
                  {{ t('default-download-channel-use-unified-desc') }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <Toggle
                  :value="!splitDownloadDefaults"
                  @update:value="setUnifiedDownloadMode"
                />
              </div>
            </div>

            <div v-if="!splitDownloadDefaults" class="space-y-3">
              <p class="text-xs text-slate-500 dark:text-slate-300">
                {{ t('default-download-channel-unified-hint') }}
              </p>
              <label for="combined-channel-search" class="sr-only">{{ t('default-download-channel-search-placeholder') }}</label>
              <input
                id="combined-channel-search"
                v-model="combinedSearch"
                type="text"
                :placeholder="t('default-download-channel-search-placeholder')"
                :aria-label="t('default-download-channel-search-placeholder')"
                class="w-full px-3 py-2 text-sm bg-white border rounded-lg focus:border-blue-500 focus:ring-2 border-slate-200 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 focus:outline-hidden focus:ring-blue-500/20"
              >
              <div v-if="visibleCombinedOptions.length" class="space-y-2">
                <label
                  v-for="channel in visibleCombinedOptions"
                  :key="`combined-${channel.id}`"
                  :for="`combined-channel-${channel.id}`"
                  class="flex items-start gap-3 p-3 transition border rounded-lg hover:border-blue-400 border-slate-200 dark:border-slate-700 dark:hover:border-blue-500"
                >
                  <input
                    :id="`combined-channel-${channel.id}`"
                    v-model="selectedCombinedChannelId"
                    type="radio"
                    :value="channel.id"
                    class="mt-1 radio radio-primary"
                  >
                  <div class="flex flex-col">
                    <span class="text-sm font-medium">{{ channel.name }}</span>
                  </div>
                </label>
              </div>
              <div v-else class="px-3 py-6 text-sm text-center border border-dashed rounded-lg border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-300">
                {{ combinedSearch.trim() ? t('default-download-channel-no-results') : t('default-download-channel-no-unified') }}
              </div>
              <p v-if="combinedHasHidden" class="text-xs text-slate-500 dark:text-slate-300">
                {{ t('default-download-channel-more') }}
              </p>
            </div>
          </div>

          <div v-if="splitDownloadDefaults" class="space-y-6">
            <div
              v-for="section in downloadChannelSections"
              :key="`download-${section.platform}`"
              class="space-y-3"
            >
              <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {{ section.title }}
              </h3>
              <p class="text-xs text-slate-500 dark:text-slate-300">
                {{ section.description }}
              </p>
              <input
                v-if="platformOptions[section.platform].length"
                v-model="downloadSearches[section.platform]"
                type="text"
                :name="`download-search-${section.platform}`"
                :aria-label="section.title"
                :placeholder="t('default-download-channel-search-placeholder')"
                class="w-full px-3 py-2 text-sm bg-white border rounded-lg focus:border-blue-500 focus:ring-2 border-slate-200 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 focus:outline-hidden focus:ring-blue-500/20"
              >
              <div v-if="getVisiblePlatformOptions(section.platform).length" class="space-y-2">
                <label
                  v-for="channel in getVisiblePlatformOptions(section.platform)"
                  :key="`${section.platform}-${channel.id}`"
                  :for="`${section.platform}-channel-${channel.id}`"
                  class="flex items-start gap-3 p-3 transition border rounded-lg hover:border-blue-400 border-slate-200 dark:border-slate-700 dark:hover:border-blue-500"
                >
                  <input
                    :id="`${section.platform}-channel-${channel.id}`"
                    v-model="selectedDownloadChannelIds[section.platform]"
                    type="radio"
                    :value="channel.id"
                    class="mt-1 radio radio-primary"
                  >
                  <div class="flex flex-col">
                    <span class="text-sm font-medium">{{ channel.name }}</span>
                  </div>
                </label>
              </div>
              <div v-else class="px-3 py-6 text-sm text-center border border-dashed rounded-lg border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-300">
                {{ downloadSearches[section.platform].trim() ? t('default-download-channel-no-results') : section.empty }}
              </div>
              <p v-if="platformHasHidden(section.platform)" class="text-xs text-slate-500 dark:text-slate-300">
                {{ t('default-download-channel-more') }}
              </p>
            </div>
          </div>

          <div v-if="!hasCombinedOptions && !canSplitDownloadDefaults" class="px-3 py-6 text-sm text-center border border-dashed rounded-lg border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-300">
            {{ t('no-compatible-download-channel') }}
          </div>
        </template>
      </div>
    </Teleport>
  </div>
</template>
