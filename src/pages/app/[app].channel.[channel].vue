<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { greaterOrEqual, parse } from '@std/semver'
import { computedAsync, onClickOutside } from '@vueuse/core'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/heroicons/clipboard-document-check'
import IconCode from '~icons/heroicons/code-bracket'
import Settings from '~icons/heroicons/cog-8-tooth'
import IconInformation from '~icons/heroicons/information-circle'
import IconSearch from '~icons/ic/round-search?raw'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconWarning from '~icons/lucide/alert-triangle'
import IconExternalLink from '~icons/lucide/external-link'
import IconDown from '~icons/material-symbols/keyboard-arrow-down-rounded'
import { formatDate, formatLocalDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { checkCompatibilityNativePackages, defaultApiHost, isCompatible, useSupabase } from '~/services/supabase'
import { isInternalVersionName, withBuiltinChannelVersion } from '~/services/versions'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'

interface Channel {
  version: Database['public']['Tables']['app_versions']['Row']
  rollout_version_info?: Pick<Database['public']['Tables']['app_versions']['Row'], 'id' | 'name'> | null
}

interface NotificationQueueResponse {
  queued?: boolean
}

type ChannelUpdate = Database['public']['Tables']['channels']['Update']
type EditableChannelKey = 'allow_dev'
  | 'allow_device'
  | 'allow_device_self_set'
  | 'allow_emulator'
  | 'allow_prod'
  | 'android'
  | 'disable_auto_update_under_native'
  | 'electron'
  | 'ios'
  | 'rollout_cache_ttl_seconds'
  | 'rollout_enabled'
  | 'rollout_paused_at'
  | 'rollout_pause_reason'
  | 'rollout_percentage_bps'
  | 'rollout_version'
  | 'auto_pause_enabled'
  | 'auto_pause_window_minutes'
  | 'auto_pause_failure_rate_bps'
  | 'auto_pause_confidence'
  | 'auto_pause_min_attempts'
  | 'auto_pause_min_failures'
  | 'auto_pause_action'
  | 'auto_pause_cooldown_minutes'
  | 'version'

// Bundle link dialog state
const bundleLinkVersions = ref<Database['public']['Tables']['app_versions']['Row'][]>([])
const bundleLinkSearchVal = ref('')
const bundleLinkSearchMode = ref(false)
const bundleLinkMode = ref<'stable' | 'rollout'>('stable')

const main = useMainStore()
const route = useRoute('/app/[app].channel.[channel]')
const router = useRouter()
const dialogStore = useDialogV2Store()
const displayStore = useDisplayStore()
const appDetailStore = useAppDetailStore()
const { t } = useI18n()
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const channel = ref<Database['public']['Tables']['channels']['Row'] & Channel>()
const rolloutConfigured = computed(() => !!channel.value?.rollout_version)
const rolloutPercentage = computed(() => (channel.value?.rollout_percentage_bps ?? 0) / 100)
const rolloutStatusLabel = computed(() => {
  if (!rolloutConfigured.value)
    return t('not-configured')
  if (channel.value?.rollout_paused_at)
    return t('paused')
  return channel.value?.rollout_enabled ? t('enabled') : t('disabled')
})
const rolloutStatusClass = computed(() => {
  if (!rolloutConfigured.value || !channel.value?.rollout_enabled) {
    return 'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300'
  }
  if (channel.value.rollout_paused_at) {
    return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200'
  }
  return 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800/70 dark:bg-sky-950/30 dark:text-sky-200'
})
const rolloutPercentageText = computed(() => `${rolloutPercentage.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`)
const rolloutProgressClass = computed(() => {
  if (!rolloutConfigured.value || !channel.value?.rollout_enabled)
    return 'bg-slate-300 dark:bg-slate-600'
  if (channel.value.rollout_paused_at)
    return 'bg-amber-500 dark:bg-amber-400'
  return 'bg-sky-500 dark:bg-sky-400'
})
const rolloutProgressStyle = computed(() => {
  const percentage = Math.max(0, Math.min(100, rolloutPercentage.value))
  return `width: ${percentage}%`
})
const showRolloutSettings = computed(() => !!channel.value?.rollout_enabled)
const showRolloutEnableRow = computed(() => !!channel.value && !channel.value.rollout_enabled)

const canUpdateChannelSettings = computedAsync(async () => {
  if (!packageId.value || !id.value)
    return false
  return await checkPermissions('channel.update_settings', { appId: packageId.value, channelId: id.value })
}, false)
const rolloutControlsDisabled = computed(() => !canUpdateChannelSettings.value)
const rolloutActionsDisabled = computed(() => rolloutControlsDisabled.value || !rolloutConfigured.value)
const rolloutPauseDisabled = computed(() => rolloutActionsDisabled.value || !channel.value?.rollout_enabled)

const canPromoteBundle = computedAsync(async () => {
  if (!id.value)
    return false
  return await checkPermissions('channel.promote_bundle', { channelId: id.value })
}, false)
const rolloutTargetActionsDisabled = computed(() => !canPromoteBundle.value || !rolloutConfigured.value)
const rolloutEnableDisabled = computed(() => {
  if (!channel.value)
    return true
  return channel.value.rollout_version ? rolloutControlsDisabled.value : !canPromoteBundle.value
})

const showDebugSection = ref(false)

// Auto update dropdown state
const autoUpdateDropdown = useTemplateRef('autoUpdateDropdown')
onClickOutside(autoUpdateDropdown, () => closeAutoUpdateDropdown())

function openBundle() {
  if (!channel.value || channel.value.version.storage_provider === 'revert_to_builtin')
    return
  if (isInternalVersionName(channel.value.version.name))
    return
  router.push(`/app/${route.params.app}/bundle/${channel.value.version.id}`)
}

async function getChannel(force = false) {
  if (!id.value)
    return

  // Check if we already have this channel in the store
  if (!force && appDetailStore.currentChannelId === id.value && appDetailStore.currentChannel) {
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
          rollout_version,
          rollout_percentage_bps,
          rollout_enabled,
          rollout_id,
          rollout_paused_at,
          rollout_pause_reason,
          rollout_cache_ttl_seconds,
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
          ios,
          android,
          electron,
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

async function saveChannelChanges(update: ChannelUpdate) {
  const changesStableVersion = Object.prototype.hasOwnProperty.call(update, 'version')
  const changesRolloutVersion = Object.prototype.hasOwnProperty.call(update, 'rollout_version')
  const canUpdate = changesStableVersion || changesRolloutVersion
    ? canPromoteBundle.value
    : canUpdateChannelSettings.value

  if (!canUpdate) {
    toast.error(t('no-permission'))
    return false
  }

  if (!id.value || !channel.value)
    return false

  if (Object.prototype.hasOwnProperty.call(update, 'version') && (update.version === undefined || (update.version !== null && typeof update.version !== 'number'))) {
    console.error('Invalid version ID:', update.version)
    toast.error(t('error-invalid-version'))
    return false
  }
  if (Object.prototype.hasOwnProperty.call(update, 'rollout_version') && (update.rollout_version === undefined || (update.rollout_version !== null && typeof update.rollout_version !== 'number'))) {
    console.error('Invalid rollout version ID:', update.rollout_version)
    toast.error(t('error-invalid-version'))
    return false
  }

  try {
    const { error } = await supabase
      .from('channels')
      .update(update)
      .eq('id', id.value)
    if (error) {
      toast.error(t('error-update-channel'))
      console.error('no channel update', error)
      return false
    }

    await getChannel(true)
    toast.info(t('cloud-replication-delay'))
    return true
  }
  catch (error) {
    console.error(error)
    return false
  }
}

async function saveChannelChange<K extends EditableChannelKey>(key: K, val: ChannelUpdate[K]) {
  return await saveChannelChanges({ [key]: val } as ChannelUpdate)
}

async function notificationAuthHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token)
    throw new Error(t('not-authenticated'))
  return Object.fromEntries([
    ['Authorization', `Bearer ${token}`],
    ['Content-Type', 'application/json'],
  ])
}

async function notificationFetch<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${defaultApiHost}/notifications${path}`, {
    ...init,
    headers: {
      ...(await notificationAuthHeaders()),
      ...(init.headers || {}),
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string, message?: string }
    throw new Error(body.message || body.error || t('notification-action-error'))
  }
  return await response.json() as T
}

async function queueChannelUpdateNotification() {
  if (!channel.value)
    return

  const response = await notificationFetch<NotificationQueueResponse>('/update-check', {
    method: 'POST',
    body: JSON.stringify({
      appId: packageId.value,
      target: { broadcast: true },
      channel: channel.value.name,
    }),
  })
  if (!response.queued)
    throw new Error(t('notification-queue-unavailable'))
  toast.success(t('notification-update-push-success'))
}

async function askUpdateNotificationAfterBundleChange() {
  if (!channel.value)
    return

  dialogStore.openDialog({
    title: t('notification-send-update-title'),
    description: t('notification-send-update-description', { channel: channel.value.name }),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('notification-send-update-action'),
        role: 'primary',
        handler: async () => {
          try {
            await queueChannelUpdateNotification()
          }
          catch (error) {
            console.error(error)
            toast.error(error instanceof Error ? error.message : t('notification-action-error'))
          }
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}

watchEffect(async () => {
  if (route.path.includes('/channel/')) {
    loading.value = true
    packageId.value = route.params.app as string
    id.value = Number(route.params.channel as string)
    await getChannel()
    loading.value = false
    if (!channel.value?.name)
      displayStore.NavTitle = t('channel')
    displayStore.defaultBack = `/app/${route.params.app}/channels`
  }
})

function goToDefaultChannelSettings() {
  router.push(`/app/${route.params.app}/info`)
}

const currentChannelVersion = computed(() => {
  return channel.value?.version as any
})

const showSearchAndActions = computed(() => {
  return !bundleLinkSearchMode.value
})

async function handleVersionLink(appVersion: Database['public']['Tables']['app_versions']['Row']) {
  if (!channel.value)
    return
  const {
    finalCompatibility,
    localDependencies,
  } = await checkCompatibilityNativePackages(appVersion.app_id, channel.value.name, (appVersion.native_packages as any) ?? [])

  // Check if any package is incompatible
  if (localDependencies.length > 0 && finalCompatibility.some(x => !isCompatible(x))) {
    toast.error(t('bundle-not-compatible-with-channel', { channel: channel.value.name }))

    dialogStore.openDialog({
      title: t('confirm-action'),
      description: t('set-even-not-compatible'),
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
        {
          text: t('view-dependencies'),
          role: 'cancel',
          handler: () => {
            // Pre-select the channel's current bundle as the comparison baseline so the
            // Dependencies page opens already diffed against what is live on the channel.
            const channelBundleId = channel.value?.version?.id
            const compareQuery = channelBundleId ? `?compare=${channelBundleId}` : ''
            router.push(`/app/${route.params.app}/bundle/${appVersion.id}/dependencies${compareQuery}`)
          },
        },
        {
          text: t('button-confirm'),
          role: 'primary',
        },
      ],
    })
    if (await dialogStore.onDialogDismiss())
      return
  }
  else if (localDependencies.length === 0) {
    toast.info('ignore-compatibility')
  }
  else {
    toast.info(t('bundle-compatible-with-channel', { channel: channel.value.name }))
  }
  if (bundleLinkMode.value === 'rollout') {
    const saved = await saveChannelChanges({
      rollout_version: appVersion.id,
      rollout_enabled: true,
    })
    if (saved) {
      toast.success(t('rollout-target-linked'))
      await askUpdateNotificationAfterBundleChange()
    }
    return
  }

  if (await saveChannelChange('version', appVersion.id)) {
    toast.success(t('linked-bundle'))
    await askUpdateNotificationAfterBundleChange()
  }
}

async function handleUnlink() {
  if (!channel.value || !main.auth)
    return
  if (!canPromoteBundle.value) {
    toast.error(t('no-permission'))
    return
  }
  dialogStore.openDialog({
    title: `${t('unlink-bundle')} ${channel.value.version.name}`,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('continue'),
        role: 'primary',
        handler: async () => {
          if (await saveChannelChange('version', null))
            await askUpdateNotificationAfterBundleChange()
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function handleRevert() {
  if (!canPromoteBundle.value) {
    toast.error(t('no-permission'))
    return
  }
  dialogStore.openDialog({
    title: t('revert-to-builtin'),
    description: t('revert-to-builtin-confirm'),
    buttons: [
      {
        text: t('cancel'),
        role: 'cancel',
      },
      {
        text: t('confirm'),
        role: 'primary',
        handler: async () => {
          if (await saveChannelChange('version', null))
            await askUpdateNotificationAfterBundleChange()
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}

async function openSelectVersion() {
  if (!canPromoteBundle.value) {
    toast.error(t('no-permission'))
    return
  }
  if (!channel.value)
    return

  // Fetch versions when dialog opens
  const { data, error } = await supabase.from('app_versions')
    .select('*')
    .eq('app_id', channel.value.app_id)
    .eq('deleted', false)
    .neq('id', channel.value.version.id)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.error(error)
    toast.error(t('error-fetching-versions'))
    return
  }

  bundleLinkVersions.value = data ?? []
  bundleLinkSearchVal.value = ''
  bundleLinkSearchMode.value = false

  // Open the dialog
  dialogStore.openDialog({
    title: t('bundle-management'),
    size: 'lg',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
    ],
  })

  await dialogStore.onDialogDismiss()
}

async function openSelectStableVersion() {
  bundleLinkMode.value = 'stable'
  await openSelectVersion()
}

async function openSelectRolloutVersion() {
  bundleLinkMode.value = 'rollout'
  await openSelectVersion()
}

async function enableRollout() {
  if (!channel.value)
    return
  if (!channel.value.rollout_version) {
    await openSelectRolloutVersion()
    return
  }
  await saveChannelChange('rollout_enabled', true as any)
}

async function saveRolloutPercentage(value: string) {
  const percentage = Number.parseFloat(value)
  if (Number.isNaN(percentage) || percentage < 0 || percentage > 100) {
    toast.error(t('invalid-rollout-percentage'))
    return
  }
  await saveChannelChange('rollout_percentage_bps', Math.round(percentage * 100) as any)
}

async function saveIntegerField(key: EditableChannelKey, value: string, min: number, max: number, nullable = false) {
  const trimmedValue = value.trim()
  if (!trimmedValue && nullable) {
    await saveChannelChange(key, null as any)
    return
  }

  const parsedValue = Number(trimmedValue)
  if (!Number.isInteger(parsedValue) || parsedValue < min || parsedValue > max) {
    toast.error(t('error-update-channel'))
    return
  }

  await saveChannelChange(key, parsedValue as any)
}

async function saveAutoPauseFailureRate(value: string) {
  await saveIntegerField('auto_pause_failure_rate_bps', value, 0, 10000, true)
}

async function saveAutoPauseConfidence(value: string) {
  const confidence = Number(value.trim())
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    toast.error(t('error-update-channel'))
    return
  }

  await saveChannelChange('auto_pause_confidence', Number(confidence.toFixed(4)) as any)
}

async function rollbackRollout() {
  if (await saveChannelChanges({
    rollout_version: null,
    rollout_enabled: false,
    rollout_percentage_bps: 0,
    rollout_paused_at: null,
    rollout_pause_reason: null,
  })) {
    await askUpdateNotificationAfterBundleChange()
  }
}

async function promoteRollout() {
  if (!channel.value?.rollout_version)
    return
  if (await saveChannelChanges({
    version: channel.value.rollout_version,
    rollout_version: null,
    rollout_enabled: false,
    rollout_percentage_bps: 0,
    rollout_paused_at: null,
    rollout_pause_reason: null,
  })) {
    await askUpdateNotificationAfterBundleChange()
  }
}

async function toggleRolloutPause() {
  await saveChannelChanges(channel.value?.rollout_paused_at
    ? { rollout_paused_at: null, rollout_pause_reason: null }
    : { rollout_paused_at: new Date().toISOString(), rollout_pause_reason: t('manual-rollout-pause') })
}

async function refreshFilteredVersions() {
  if (!channel.value)
    return

  if (bundleLinkSearchVal.value && bundleLinkSearchVal.value.trim()) {
    const { data, error } = await supabase.from('app_versions')
      .select('*')
      .eq('app_id', channel.value.app_id)
      .eq('deleted', false)
      .neq('id', channel.value.version.id)
      .order('created_at', { ascending: false })
      .like('name', `%${bundleLinkSearchVal.value.trim()}%`)
      .limit(5)
    if (error) {
      console.error(error)
      toast.error(t('error-fetching-versions'))
    }
    bundleLinkVersions.value = data ?? []
  }
  else {
    const { data, error } = await supabase.from('app_versions')
      .select('*')
      .eq('app_id', channel.value.app_id)
      .eq('deleted', false)
      .neq('id', channel.value.version.id)
      .order('created_at', { ascending: false })
      .limit(5)
    if (error) {
      console.error(error)
      toast.error(t('error-fetching-versions'))
    }
    bundleLinkVersions.value = data ?? []
  }
}

const debouncedRefreshFilteredVersions = useDebounceFn(() => {
  refreshFilteredVersions()
}, 500)

watch(() => bundleLinkSearchVal.value, () => {
  debouncedRefreshFilteredVersions()
})

function closeAutoUpdateDropdown() {
  if (autoUpdateDropdown.value) {
    autoUpdateDropdown.value.removeAttribute('open')
  }
}

function getAutoUpdateLabel(value: string) {
  switch (value) {
    case 'major':
      return t('major')
    case 'minor':
      return t('minor')
    case 'patch':
      return t('patch')
    case 'version_number':
      return t('metadata')
    case 'none':
      return t('none')
    default:
      return t('none')
  }
}

async function onSelectAutoUpdate(value: Database['public']['Enums']['disable_update']) {
  if (!canUpdateChannelSettings.value) {
    toast.error(t('no-permission'))
    return false
  }

  if (value === 'version_number') {
    if (!channel.value?.version.min_update_version)
      toast.error(t('metadata-min-ver-not-set'))
  }

  const { error } = await supabase
    .from('channels')
    .update({ disable_auto_update: value })
    .eq('id', id.value)

  if (error) {
    console.error(error)
  }
  else {
    toast.info(t('cloud-replication-delay'))
  }

  if (channel.value?.disable_auto_update)
    channel.value.disable_auto_update = value

  closeAutoUpdateDropdown()
}

function openLink(url?: string): void {
  if (url) {
    const win = window.open(url, '_blank')
    if (win)
      win.opener = null
  }
}

// Get the platform to use for testing based on channel settings
function getTestPlatform(): 'ios' | 'android' | 'electron' {
  if (!channel.value)
    return 'ios'
  // Prefer iOS if supported, then Android, then Electron
  if (channel.value.ios)
    return 'ios'
  if (channel.value.android)
    return 'android'
  if (channel.value.electron)
    return 'electron'
  return 'ios'
}

// Check if channel can be tested with the fake device data we use
const canTestChannel = computed(() => {
  if (!channel.value)
    return false
  const platform = getTestPlatform()
  // Check if channel allows the platform we're testing with
  const allowsPlatform = platform === 'ios'
    ? channel.value.ios
    : platform === 'android'
      ? channel.value.android
      : channel.value.electron
  const allowsProd = channel.value.allow_prod
  const allowsDevice = channel.value.allow_device
  // Channel must be public OR allow device self-assignment
  const isAccessible = channel.value.public || channel.value.allow_device_self_set
  return allowsPlatform && allowsProd && allowsDevice && isAccessible
})

// Generate a compatible version_name based on channel's version and update strategy
function getCompatibleVersionName(): string {
  if (!channel.value?.version?.name || isInternalVersionName(channel.value.version.name))
    return '1.0.0'

  const channelVersion = channel.value.version.name
  let channelSemver
  try {
    channelSemver = parse(channelVersion)
  }
  catch {
    return '1.0.0'
  }

  const { major, minor, patch } = channelSemver
  const strategy = channel.value.disable_auto_update

  // Generate a version that would trigger an update based on the strategy
  // We want a version slightly lower than the channel version to simulate a device needing an update
  let candidate = channelVersion
  switch (strategy) {
    case 'major':
      // Same major, device can receive update
      candidate = `${major}.0.0`
      break
    case 'minor':
      // Same major.minor, device can receive update
      candidate = `${major}.${minor}.0`
      break
    case 'patch':
      // Same major.minor.patch, device can receive update
      candidate = channelVersion
      break
    case 'version_number':
      // Uses min_update_version, return the min_update_version or channel version
      candidate = channel.value.version.min_update_version || channelVersion
      break
    case 'none':
    default:
      // Any version works, use a lower version to show update available
      candidate = `${major}.${minor}.0`
      break
  }

  const lowerFallback = () => {
    let fallback = '0.0.0-0'
    if (patch > 0)
      fallback = `${major}.${minor}.${patch - 1}`
    else if (minor > 0)
      fallback = `${major}.${minor - 1}.0`
    else if (major > 0)
      fallback = `${major - 1}.0.0`

    try {
      if (greaterOrEqual(parse(fallback), channelSemver))
        return '0.0.0-0'
    }
    catch {
      return '0.0.0-0'
    }

    return fallback
  }

  try {
    if (greaterOrEqual(parse(candidate), channelSemver))
      return lowerFallback()
  }
  catch {
    return lowerFallback()
  }

  return candidate
}

function getChannelCurlCommand() {
  if (!channel.value)
    return ''

  const versionName = getCompatibleVersionName()
  const platform = getTestPlatform()
  const versionOs = platform === 'ios' ? '18.0' : platform === 'android' ? '14' : '10.0'

  // Generate fake device data that fits the /updates endpoint schema
  const requestBody: Record<string, unknown> = {
    app_id: packageId.value,
    device_id: '00000000-0000-0000-0000-000000000000',
    version_name: versionName,
    version_build: versionName,
    version_os: versionOs,
    is_emulator: false,
    is_prod: true,
    platform,
    plugin_version: '8.40.6',
  }

  // Only include defaultChannel if the channel is NOT public (not the default)
  if (!channel.value.public) {
    requestBody.defaultChannel = channel.value.name
  }

  const jsonBody = JSON.stringify(requestBody, null, 2)

  return `curl -X POST '${defaultApiHost}/updates' \\
  -H 'Content-Type: application/json' \\
  -d '${jsonBody}'`
}

async function copyCurlCommand() {
  try {
    const curl = getChannelCurlCommand()
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
    <PageLoader v-if="loading" />
    <div v-else-if="channel" class="mt-0 md:mt-8">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col bg-white border shadow-lg md:rounded-lg border-slate-300 dark:border-slate-900 dark:bg-slate-800">
          <dl class="divide-y divide-slate-200 dark:divide-slate-500">
            <InfoRow :label="t('name')">
              {{ channel.name }}
            </InfoRow>
            <!-- Bundle Number -->
            <InfoRow :label="t('bundle-number')" :is-link="channel && !isInternalVersionName((channel.version.name))">
              <div class="flex items-center gap-2">
                <span class="cursor-pointer" @click="openBundle()">{{ channel.version.name }}</span>
                <button
                  v-if="channel"
                  class="p-1 transition-colors border border-gray-200 rounded-md dark:border-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-gray-200 dark:disabled:hover:border-gray-700"
                  :disabled="!canPromoteBundle"
                  @click="openSelectStableVersion()"
                >
                  <Settings class="w-4 h-4 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400" />
                </button>
              </div>
            </InfoRow>
            <InfoRow v-if="channel.disable_auto_update === 'version_number'" :label="t('min-update-version')">
              {{ channel.version.min_update_version ?? t('undefined-fail') }}
            </InfoRow>
            <!-- Created At -->
            <InfoRow :label="t('created-at')">
              {{ formatDate(channel.created_at) }}
            </InfoRow>
            <!-- Last Update -->
            <InfoRow :label="t('last-update')">
              {{ formatDate(channel.updated_at) }}
            </InfoRow>
            <!-- Bundle Link -->
            <InfoRow
              v-if="channel.version.link"
              :label="t('bundle-link')"
              :is-link="channel.version.link ? true : false"
              @click="channel.version.link ? openLink(channel.version.link) : null"
            >
              {{ channel.version.link }}
            </InfoRow>
            <!-- Bundle Comment -->
            <InfoRow v-if="channel.version.comment" :label="t('bundle-comment')">
              {{ channel.version.comment }}
            </InfoRow>
            <InfoRow v-if="showRolloutEnableRow" :label="t('progressive-rollout')" :value="t('disabled')">
              <button class="d-btn d-btn-sm d-btn-outline" :disabled="rolloutEnableDisabled" @click="enableRollout()">
                {{ t('enable') }}
              </button>
            </InfoRow>
            <div v-if="showRolloutSettings" class="px-4 py-5 sm:px-6">
              <section class="space-y-6" aria-labelledby="rollout-settings-title">
                <div class="space-y-4">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0 space-y-1">
                      <h2 id="rollout-settings-title" class="text-base font-semibold text-slate-950 dark:text-white">
                        {{ t('progressive-rollout') }}
                      </h2>
                      <p v-if="channel.rollout_pause_reason" class="text-xs text-amber-700 dark:text-amber-300">
                        {{ channel.rollout_pause_reason }}
                      </p>
                    </div>
                    <span class="inline-flex min-h-9 items-center self-start rounded-md border px-3 text-xs font-semibold" :class="rolloutStatusClass">
                      {{ rolloutStatusLabel }}
                    </span>
                  </div>

                  <dl class="grid border-y border-slate-200 text-sm dark:border-slate-700 sm:grid-cols-2 sm:divide-x sm:divide-slate-200 sm:dark:divide-slate-700">
                    <div class="py-3 sm:px-4 sm:first:pl-0">
                      <dt class="text-xs font-medium text-slate-500 dark:text-slate-400">
                        {{ t('rollout-target') }}
                      </dt>
                      <dd class="mt-1 font-semibold text-slate-900 dark:text-white">
                        {{ channel?.rollout_version_info?.name ?? t('not-configured') }}
                      </dd>
                    </div>
                    <div class="border-t border-slate-200 py-3 dark:border-slate-700 sm:border-t-0 sm:px-4">
                      <dt class="text-xs font-medium text-slate-500 dark:text-slate-400">
                        {{ t('rollout-percentage') }}
                      </dt>
                      <dd class="mt-1 font-semibold text-slate-900 dark:text-white">
                        {{ rolloutPercentageText }}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div class="space-y-3">
                  <div class="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-900">
                    <div class="h-full rounded-full transition-[width] duration-200" :class="rolloutProgressClass" :style="rolloutProgressStyle" />
                  </div>

                  <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                    <div class="grid gap-3 sm:grid-cols-2">
                      <label class="space-y-1.5">
                        <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('rollout-percentage') }}</span>
                        <div class="flex min-h-11 items-center rounded-md border border-slate-200 bg-white px-3 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100 dark:border-slate-700 dark:bg-slate-900 dark:focus-within:border-sky-700 dark:focus-within:ring-sky-950">
                          <input
                            class="w-full bg-transparent text-sm font-medium text-slate-900 outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:text-white"
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            :aria-label="t('rollout-percentage')"
                            :disabled="rolloutControlsDisabled"
                            :value="rolloutPercentage"
                            @change="saveRolloutPercentage(($event.target as HTMLInputElement).value)"
                          >
                          <span class="text-sm text-slate-400 dark:text-slate-500">%</span>
                        </div>
                      </label>
                      <label class="space-y-1.5">
                        <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('cache-ttl-seconds') }}</span>
                        <input
                          class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                          type="number"
                          min="60"
                          max="31536000"
                          step="60"
                          :aria-label="t('cache-ttl-seconds')"
                          :disabled="rolloutControlsDisabled"
                          :value="channel.rollout_cache_ttl_seconds"
                          @change="saveIntegerField('rollout_cache_ttl_seconds', ($event.target as HTMLInputElement).value, 60, 31536000)"
                        >
                      </label>
                    </div>

                    <div class="flex flex-wrap gap-2 lg:justify-end">
                      <button class="min-h-11 d-btn d-btn-ghost" :disabled="!canPromoteBundle" @click="openSelectRolloutVersion()">
                        {{ t('set-rollout-target') }}
                      </button>
                      <button class="min-h-11 d-btn d-btn-outline" :disabled="rolloutActionsDisabled" @click="saveChannelChange('rollout_enabled', !channel.rollout_enabled as any)">
                        {{ channel.rollout_enabled ? t('disable') : t('enable') }}
                      </button>
                      <button class="min-h-11 d-btn d-btn-outline" :disabled="rolloutPauseDisabled" @click="toggleRolloutPause()">
                        {{ channel.rollout_paused_at ? t('resume') : t('pause') }}
                      </button>
                      <button class="min-h-11 d-btn d-btn-primary" :disabled="rolloutTargetActionsDisabled" @click="promoteRollout()">
                        {{ t('promote') }}
                      </button>
                      <button class="min-h-11 capitalize d-btn d-btn-error d-btn-ghost" :disabled="rolloutTargetActionsDisabled" @click="rollbackRollout()">
                        {{ t('rollback') }}
                      </button>
                    </div>
                  </div>
                </div>

                <div class="border-t border-slate-200 pt-5 dark:border-slate-700/80">
                  <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h3 class="text-sm font-semibold text-slate-900 dark:text-white">
                      {{ t('auto-pause') }}
                    </h3>
                    <label class="inline-flex min-h-11 items-center gap-3 text-sm font-medium text-slate-700 dark:text-slate-200">
                      <input
                        class="d-toggle d-toggle-sm"
                        type="checkbox"
                        :checked="channel.auto_pause_enabled"
                        :disabled="rolloutControlsDisabled"
                        @change="saveChannelChange('auto_pause_enabled', !channel.auto_pause_enabled as any)"
                      >
                      <span>{{ channel.auto_pause_enabled ? t('enabled') : t('disabled') }}</span>
                    </label>
                  </div>

                  <div v-if="channel.auto_pause_enabled" class="grid w-full gap-3 text-left sm:grid-cols-2 xl:grid-cols-4">
                    <label class="space-y-1.5">
                      <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('failure-rate-bps') }}</span>
                      <input
                        class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                        type="number"
                        min="0"
                        max="10000"
                        :aria-label="t('failure-rate-bps')"
                        :disabled="rolloutControlsDisabled"
                        :value="channel.auto_pause_failure_rate_bps ?? ''"
                        @change="saveAutoPauseFailureRate(($event.target as HTMLInputElement).value)"
                      >
                    </label>
                    <label class="space-y-1.5">
                      <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('auto-pause-action') }}</span>
                      <select
                        class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                        :aria-label="t('auto-pause-action')"
                        :disabled="rolloutControlsDisabled"
                        :value="channel.auto_pause_action"
                        @change="saveChannelChange('auto_pause_action', ($event.target as HTMLSelectElement).value as any)"
                      >
                        <option value="pause">
                          {{ t('pause') }}
                        </option>
                        <option value="rollback">
                          {{ t('rollback') }}
                        </option>
                        <option value="notify">
                          {{ t('notify') }}
                        </option>
                      </select>
                    </label>
                    <label class="space-y-1.5">
                      <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('window-minutes') }}</span>
                      <input
                        class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                        type="number"
                        min="1"
                        max="10080"
                        :aria-label="t('window-minutes')"
                        :disabled="rolloutControlsDisabled"
                        :value="channel.auto_pause_window_minutes"
                        @change="saveIntegerField('auto_pause_window_minutes', ($event.target as HTMLInputElement).value, 1, 10080)"
                      >
                    </label>
                    <label class="space-y-1.5">
                      <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('confidence') }}</span>
                      <input
                        class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                        type="number"
                        min="0.0001"
                        max="0.9999"
                        step="0.0001"
                        :aria-label="t('confidence')"
                        :disabled="rolloutControlsDisabled"
                        :value="channel.auto_pause_confidence"
                        @change="saveAutoPauseConfidence(($event.target as HTMLInputElement).value)"
                      >
                    </label>
                    <label class="space-y-1.5">
                      <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('min-attempts') }}</span>
                      <input
                        class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                        type="number"
                        min="0"
                        :aria-label="t('min-attempts')"
                        :disabled="rolloutControlsDisabled"
                        :value="channel.auto_pause_min_attempts ?? ''"
                        @change="saveIntegerField('auto_pause_min_attempts', ($event.target as HTMLInputElement).value, 0, Number.MAX_SAFE_INTEGER, true)"
                      >
                    </label>
                    <label class="space-y-1.5">
                      <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('min-failures') }}</span>
                      <input
                        class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                        type="number"
                        min="0"
                        :aria-label="t('min-failures')"
                        :disabled="rolloutControlsDisabled"
                        :value="channel.auto_pause_min_failures ?? ''"
                        @change="saveIntegerField('auto_pause_min_failures', ($event.target as HTMLInputElement).value, 0, Number.MAX_SAFE_INTEGER, true)"
                      >
                    </label>
                    <label class="space-y-1.5">
                      <span class="block text-xs font-medium text-slate-500 dark:text-slate-400">{{ t('cooldown-minutes') }}</span>
                      <input
                        class="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:border-sky-700 dark:focus:ring-sky-950"
                        type="number"
                        min="0"
                        max="10080"
                        :aria-label="t('cooldown-minutes')"
                        :disabled="rolloutControlsDisabled"
                        :value="channel.auto_pause_cooldown_minutes"
                        @change="saveIntegerField('auto_pause_cooldown_minutes', ($event.target as HTMLInputElement).value, 0, 10080)"
                      >
                    </label>
                  </div>
                </div>
              </section>
            </div>
            <InfoRow :label="t('channel-is-public')">
              <div class="flex items-center justify-end w-full gap-3 text-right">
                <span
                  class="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-md"
                  :class="channel?.public
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                    : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'"
                >
                  {{ channel?.public ? t('channel-default-active') : t('channel-default-inactive') }}
                </span>
                <button
                  type="button"
                  class="text-sm font-medium text-blue-600 underline dark:text-blue-400 hover:text-blue-500 decoration-dotted dark:hover:text-blue-300"
                  @click="goToDefaultChannelSettings"
                >
                  {{ t('manage-default-channel') }}
                </button>
                <div class="relative inline-flex group">
                  <IconInformation class="w-4 h-4 transition-colors text-slate-400 cursor-help dark:text-slate-400 dark:group-hover:text-slate-200 group-hover:text-slate-600" />
                  <div class="absolute right-0 w-56 px-3 py-2 mb-2 text-xs text-white transition-opacity duration-150 bg-gray-800 rounded-lg shadow-lg opacity-0 pointer-events-none bottom-full group-hover:opacity-100">
                    {{ t('channel-default-moved-info') }}
                    <div class="absolute w-2 h-2 rotate-45 bg-gray-800 -bottom-1 right-2" />
                  </div>
                </div>
              </div>
            </InfoRow>
            <InfoRow
              v-for="platform in ['ios', 'android', 'electron'] as const"
              :key="platform"
              :label="t(`platform-${platform}`)"
            >
              <Toggle
                :value="channel?.[platform]"
                @change="saveChannelChange(platform, !channel?.[platform])"
              />
            </InfoRow>
            <InfoRow :label="t('disable-auto-downgra')">
              <Toggle
                :value="channel?.disable_auto_update_under_native"
                @change="saveChannelChange('disable_auto_update_under_native', !channel?.disable_auto_update_under_native)"
              />
            </InfoRow>
            <InfoRow :label="t('disableAutoUpdateToMajor')">
              <div class="flex flex-col items-end gap-2">
                <details ref="autoUpdateDropdown" class="d-dropdown d-dropdown-end">
                  <summary class="d-btn d-btn-outline d-btn-sm">
                    <span>{{ getAutoUpdateLabel(channel.disable_auto_update) }}</span>
                    <IconDown class="w-4 h-4 ml-1 fill-current" />
                  </summary>
                  <ul class="w-48 p-2 bg-white shadow d-dropdown-content dark:bg-base-200 rounded-box z-1">
                    <li class="block px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600">
                      <a
                        class="block px-3 py-2 text-gray-900 dark:text-white"
                        @click="onSelectAutoUpdate('major')"
                      >
                        {{ t('major') }}
                      </a>
                    </li>
                    <li class="block px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600">
                      <a
                        class="block px-3 py-2 text-gray-900 dark:text-white"
                        @click="onSelectAutoUpdate('minor')"
                      >
                        {{ t('minor') }}
                      </a>
                    </li>
                    <li class="block px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600">
                      <a
                        class="block px-3 py-2 text-gray-900 dark:text-white"
                        @click="onSelectAutoUpdate('patch')"
                      >
                        {{ t('patch') }}
                      </a>
                    </li>
                    <li class="block px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600">
                      <a
                        class="block px-3 py-2 text-gray-900 dark:text-white"
                        @click="onSelectAutoUpdate('version_number')"
                      >
                        {{ t('metadata') }}
                      </a>
                    </li>
                    <li class="block px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600">
                      <a
                        class="block px-3 py-2 text-gray-900 dark:text-white"
                        @click="onSelectAutoUpdate('none')"
                      >
                        {{ t('none') }}
                      </a>
                    </li>
                  </ul>
                </details>
                <a
                  href="https://capgo.app/semver_tester/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 text-xs font-medium text-blue-600 transition-colors dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300"
                  :aria-label="t('version-rules-tester-description')"
                  :title="t('version-rules-tester-description')"
                >
                  {{ t('version-rules-tester') }}
                  <IconExternalLink class="w-3.5 h-3.5" />
                </a>
              </div>
            </InfoRow>
            <InfoRow :label="t('allow-dev-build')">
              <Toggle
                :value="channel?.allow_dev"
                @change="saveChannelChange('allow_dev', !channel?.allow_dev)"
              />
            </InfoRow>
            <InfoRow :label="t('allow-prod-build')">
              <Toggle
                :value="channel?.allow_prod"
                @change="saveChannelChange('allow_prod', !channel?.allow_prod)"
              />
            </InfoRow>
            <InfoRow :label="t('allow-emulator')">
              <Toggle
                :value="channel?.allow_emulator"
                @change="saveChannelChange('allow_emulator', !channel?.allow_emulator)"
              />
            </InfoRow>
            <InfoRow :label="t('allow-physical-device')">
              <Toggle
                :value="channel?.allow_device"
                @change="saveChannelChange('allow_device', !channel?.allow_device)"
              />
            </InfoRow>
            <InfoRow :label="t('allow-device-to-self')">
              <Toggle
                :value="channel?.allow_device_self_set"
                @change="saveChannelChange('allow_device_self_set', !channel?.allow_device_self_set)"
              />
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
                <span class="font-medium text-slate-700 dark:text-slate-200">{{ t('debug-channel-api-request') }}</span>
              </div>
              <IconDown
                class="w-5 h-5 transition-transform text-slate-600 dark:text-slate-300"
                :class="{ 'rotate-180': showDebugSection }"
              />
            </button>

            <div v-if="showDebugSection" class="px-6 pb-4">
              <!-- Warning if channel cannot be tested -->
              <div v-if="!canTestChannel" class="flex items-start gap-3 p-3 mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20">
                <IconWarning class="flex-shrink-0 w-5 h-5 mt-0.5 text-amber-600 dark:text-amber-400" />
                <p class="text-sm text-amber-800 dark:text-amber-200">
                  {{ t('debug-channel-api-warning') }}
                </p>
              </div>

              <div class="relative">
                <pre class="p-4 overflow-x-auto text-sm rounded-lg bg-slate-900 text-slate-100"><code>{{ getChannelCurlCommand() }}</code></pre>
                <button
                  class="absolute p-2 transition-colors rounded top-2 right-2 hover:bg-slate-700"
                  :title="t('copy-curl')"
                  @click="copyCurlCommand"
                >
                  <IconCopy class="w-4 h-4 text-slate-300" />
                </button>
              </div>
              <p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
                {{ t('debug-channel-api-description') }}
              </p>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-500 italic">
                {{ t('debug-channel-api-tip') }}
              </p>
            </div>
          </div>
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
    <!-- Teleport Content for Bundle Link Dialog -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('bundle-management')" defer to="#dialog-v2-content">
      <div class="w-full space-y-4">
        <div class="text-left">
          <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
            {{ t('select-bundle-action-for-channel') }}
          </p>
        </div>

        <!-- Search Input (only when in search mode) -->
        <div v-if="bundleLinkSearchMode" class="mb-6">
          <FormKit
            v-model="bundleLinkSearchVal"
            :prefix-icon="IconSearch"
            enterkeyhint="send"
            :placeholder="t('search-versions')"
            :classes="{
              outer: 'mb-0! w-full',
            }"
          />
        </div>

        <div class="space-y-3">
          <!-- Current Bundle Info -->
          <div class="flex flex-col gap-1 px-1">
            <div class="text-sm font-medium text-gray-500 dark:text-gray-400">
              {{ bundleLinkMode === 'rollout' ? t('current-rollout-target') : t('current-bundle') }}
            </div>
            <div class="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
              <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              {{ bundleLinkMode === 'rollout' ? (channel?.rollout_version_info?.name || t('not-configured')) : (currentChannelVersion?.name || t('unknown')) }}
            </div>
          </div>

          <!-- Available Versions (when in search mode) -->
          <div v-if="bundleLinkSearchMode && bundleLinkVersions.length > 0" class="space-y-2">
            <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
              {{ t('available-versions') }}
            </h4>
            <div
              v-for="version in bundleLinkVersions"
              :key="version.id"
              class="p-3 border border-gray-300 rounded-lg cursor-pointer dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              @click="handleVersionLink(version as any)"
            >
              <div class="flex items-center justify-between">
                <div>
                  <div class="font-medium">
                    {{ version.name }}
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400">
                    {{ t('created') }}: {{ version.created_at ? formatLocalDate(version.created_at) : t('unknown') }}
                  </div>
                </div>
                <div class="text-blue-600 dark:text-blue-400">
                  →
                </div>
              </div>
            </div>
          </div>

          <!-- Action Cards (when not in search mode) -->
          <div v-if="showSearchAndActions" class="space-y-3">
            <!-- Link New Bundle -->
            <div
              class="p-3 border border-gray-300 rounded-lg cursor-pointer dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              @click="bundleLinkSearchMode = true"
            >
              <div class="flex items-center justify-between">
                <div>
                  <div class="font-medium">
                    {{ t('link-new-bundle') }}
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400">
                    {{ t('search-and-select-a-different-bundle') }}
                  </div>
                </div>
                <div class="text-blue-600 dark:text-blue-400">
                  📦
                </div>
              </div>
            </div>

            <!-- Unlink Bundle -->
            <div
              class="p-3 border border-gray-300 rounded-lg cursor-pointer dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              @click="handleUnlink"
            >
              <div class="flex items-center justify-between">
                <div>
                  <div class="font-medium">
                    {{ t('unlink-bundle') }}
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400">
                    {{ t('remove-bundle-from-this-channel') }}
                  </div>
                </div>
                <div class="text-orange-600 dark:text-orange-400">
                  🔓
                </div>
              </div>
            </div>

            <!-- Revert to Built-in -->
            <div
              class="p-3 border border-red-300 rounded-lg cursor-pointer dark:border-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              @click="handleRevert"
            >
              <div class="flex items-center justify-between">
                <div>
                  <div class="font-medium text-red-600 dark:text-red-400">
                    {{ t('revert-to-builtin') }}
                  </div>
                  <div class="text-sm text-red-500 dark:text-red-300">
                    {{ t('revert-channel-to-built-in-version') }}
                  </div>
                </div>
                <div class="text-red-600 dark:text-red-400">
                  ⚠️
                </div>
              </div>
            </div>
          </div>

          <!-- Empty state for search -->
          <div v-if="bundleLinkSearchMode && bundleLinkVersions.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            <div class="mb-2 text-4xl">
              🔍
            </div>
            <div class="font-medium">
              {{ t('no-versions-found') }}
            </div>
            <div class="mt-1 text-sm">
              {{ t('try-a-different-search-term') }}
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
