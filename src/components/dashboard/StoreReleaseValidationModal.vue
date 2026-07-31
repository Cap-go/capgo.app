<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconBell from '~icons/lucide/bell'
import IconCheck from '~icons/lucide/check'
import IconCircleDot from '~icons/lucide/circle-dot'
import IconSettings from '~icons/lucide/settings-2'
import IconSmartphone from '~icons/lucide/smartphone'
import IconStore from '~icons/lucide/store'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { sendEvent } from '~/services/tracking'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  appId: string
}>()

const RELEASE_INSTALL_SOURCES = ['app_store']
const TEST_INSTALL_SOURCES = ['testflight']
const TRACK_UNKNOWN_INSTALL_SOURCES = ['google_play', 'amazon_appstore', 'samsung_galaxy_store', 'huawei_appgallery']
const REMINDER_EVENT = 'store-release-validation-needed'
const DOWNLOAD_PLATFORMS = ['ios', 'android', 'electron'] as const
const DEVICE_COUNT_RETRY_MS = 30_000
const INSTALL_SOURCE_COUNTS_CACHE_MS = 1000 * 60 * 60 * 24 * 30
const INSTALL_SOURCE_COUNTS_CACHE_PREFIX = 'capgo-store-release-install-source-counts'

type DownloadPlatform = typeof DOWNLOAD_PLATFORMS[number]
type InstallSourceCounts = Record<string, number>
type ChannelRow = Database['public']['Tables']['channels']['Row']
type ReleaseChannelKey = 'allow_dev' | 'allow_device' | 'allow_emulator' | 'allow_prod' | 'android' | 'app_id' | 'electron' | 'id' | 'ios' | 'name' | 'public'
type ReleaseChannel = Pick<ChannelRow, ReleaseChannelKey>
type ChannelUpdate = Database['public']['Tables']['channels']['Update']

const { t } = useI18n()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()

const isLoading = ref(true)
const isOpen = ref(false)
const isLoadingChannels = ref(false)
const isApplyingSetup = ref(false)
const hasConfirmedPublished = ref(false)
const hasDismissedPrompt = ref(false)
const hasQueuedReminder = ref(false)
const hasLiveUpdateBundle = ref(false)
const hasStoreInstalledDevice = ref(false)
const hasTestFlightDevice = ref(false)
const hasTrackUnknownDevice = ref(false)
const hasDeviceCountError = ref(false)
const channels = ref<ReleaseChannel[]>([])
const selectedChannelId = ref<number | null>(null)
const setupError = ref('')
const setupSuccess = ref('')
const setupForm = ref({
  allowProd: true,
  allowDevice: true,
  blockDev: true,
  blockEmulator: true,
  makeDefault: true,
})
let loadStatusRequestId = 0
let statusRetryTimer: ReturnType<typeof setTimeout> | undefined

function resetStatus() {
  hasLiveUpdateBundle.value = false
  hasStoreInstalledDevice.value = false
  hasTestFlightDevice.value = false
  hasTrackUnknownDevice.value = false
  hasDeviceCountError.value = false
  hasConfirmedPublished.value = false
  hasQueuedReminder.value = false
  channels.value = []
  selectedChannelId.value = null
  setupError.value = ''
  setupSuccess.value = ''
}

function clearStatusRetry() {
  if (!statusRetryTimer)
    return

  clearTimeout(statusRetryTimer)
  statusRetryTimer = undefined
}

function scheduleStatusRetry(appId: string, requestId: number) {
  clearStatusRetry()
  statusRetryTimer = setTimeout(() => {
    statusRetryTimer = undefined
    if (props.appId === appId && requestId === loadStatusRequestId)
      void loadStatus()
  }, DEVICE_COUNT_RETRY_MS)
}

function getInstallSourceCountsCacheKey(appId: string) {
  return `${INSTALL_SOURCE_COUNTS_CACHE_PREFIX}:${appId}`
}

function readCachedInstallSourceCounts(appId: string): InstallSourceCounts | null {
  if (typeof localStorage === 'undefined')
    return null

  const raw = localStorage.getItem(getInstallSourceCountsCacheKey(appId))
  if (!raw)
    return null

  try {
    const cached = JSON.parse(raw) as { expiresAt?: number, counts?: InstallSourceCounts }
    if (!cached.expiresAt || cached.expiresAt <= Date.now() || !cached.counts)
      return null
    return cached.counts
  }
  catch {
    localStorage.removeItem(getInstallSourceCountsCacheKey(appId))
    return null
  }
}

function writeCachedInstallSourceCounts(appId: string, counts: InstallSourceCounts) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem(getInstallSourceCountsCacheKey(appId), JSON.stringify({
    expiresAt: Date.now() + INSTALL_SOURCE_COUNTS_CACHE_MS,
    counts,
  }))
}

async function getInstallSourceCounts(appId: string) {
  const cached = readCachedInstallSourceCounts(appId)
  if (cached)
    return cached

  const { data: currentSession } = await supabase.auth.getSession()
  const currentJwt = currentSession.session?.access_token
  if (!currentJwt)
    throw new Error('Cannot count install sources without a session')

  const response = await fetch(`${defaultApiHost}/private/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${currentJwt}`,
    },
    body: JSON.stringify({
      installSourceCounts: true,
      appId,
    }),
  })

  if (!response.ok)
    throw new Error(`Cannot count install sources: ${response.status}`)

  const data = await response.json() as { installSources: InstallSourceCounts }
  const counts = data.installSources ?? {}
  writeCachedInstallSourceCounts(appId, counts)
  return counts
}

function countInstallSources(counts: InstallSourceCounts, installSources: string[]) {
  return installSources.reduce((total, source) => total + (counts[source] ?? 0), 0)
}
const shouldPrompt = computed(() => {
  return !isLoading.value && hasLiveUpdateBundle.value && !hasStoreInstalledDevice.value && !hasDeviceCountError.value && !hasDismissedPrompt.value
})

const title = computed(() => {
  return hasTrackUnknownDevice.value
    ? t('store-release-validation-title-track-unknown')
    : hasTestFlightDevice.value
      ? t('store-release-validation-title-testflight')
      : t('store-release-validation-title')
})

const body = computed(() => {
  return hasTrackUnknownDevice.value
    ? t('store-release-validation-body-track-unknown')
    : hasTestFlightDevice.value
      ? t('store-release-validation-body-testflight')
      : t('store-release-validation-body')
})

const storeSignal = computed(() => {
  return hasTrackUnknownDevice.value
    ? t('store-release-validation-signal-android-store')
    : hasTestFlightDevice.value
      ? t('store-release-validation-signal-testflight')
      : t('store-release-validation-signal-no-store')
})

const validationItems = computed(() => [
  {
    key: 'make-default',
    label: t('store-release-validation-check-production-channel'),
    enabled: setupForm.value.makeDefault,
  },
  {
    key: 'allow-prod',
    label: t('store-release-validation-check-production-setup'),
    enabled: setupForm.value.allowProd && setupForm.value.allowDevice,
  },
  {
    key: 'block-dev',
    label: t('store-release-validation-check-non-production'),
    enabled: setupForm.value.blockDev,
  },
  {
    key: 'block-emulator',
    label: t('store-release-validation-check-emulator'),
    enabled: setupForm.value.blockEmulator,
  },
  {
    key: 'development-setup',
    label: t('store-release-validation-check-development-setup'),
    enabled: true,
  },
])

const selectedChannel = computed(() => {
  return channels.value.find(channel => channel.id === selectedChannelId.value) ?? null
})

const selectedChannelPlatforms = computed<DownloadPlatform[]>(() => {
  const channel = selectedChannel.value
  if (!channel)
    return []
  return DOWNLOAD_PLATFORMS.filter(platform => channel[platform])
})

const selectedChannelPlatformLabel = computed(() => {
  const channel = selectedChannel.value
  return channel ? channelPlatformLabel(channel) : t('store-release-validation-no-platforms')
})

function channelPlatformLabel(channel: ReleaseChannel) {
  const platforms = DOWNLOAD_PLATFORMS
    .filter(platform => channel[platform])
    .map(platform => t(`platform-${platform}`))
  if (!platforms.length)
    return t('store-release-validation-no-platforms')
  return platforms.join(', ')
}

function channelHasDownloadPlatform(channel: ReleaseChannel) {
  return DOWNLOAD_PLATFORMS.some(platform => channel[platform])
}

function pickDefaultChannel(list: ReleaseChannel[]) {
  return list.find(channel => channel.name.toLowerCase() === 'default')
    ?? list.find(channel => channel.public && channelHasDownloadPlatform(channel) && channel.allow_prod)
    ?? list.find(channel => channel.public && channelHasDownloadPlatform(channel))
    ?? list.find(channel => channel.name.toLowerCase() === 'production')
    ?? list.find(channel => channel.name.toLowerCase().includes('prod'))
    ?? list.find(channel => channelHasDownloadPlatform(channel))
    ?? list[0]
    ?? null
}

async function queueReminder() {
  if (hasQueuedReminder.value)
    return

  const orgId = organizationStore.getOrgByAppId(props.appId)?.gid ?? organizationStore.currentOrganization?.gid
  if (!orgId)
    return

  await sendEvent({
    channel: 'app',
    event: REMINDER_EVENT,
    description: `Store release validation is still pending for ${props.appId}`,
    org_id: orgId,
    tracking_version: 2,
    tags: {
      app_id: props.appId,
      has_testflight_device: hasTestFlightDevice.value,
      has_android_store_device: hasTrackUnknownDevice.value,
    },
  })
  hasQueuedReminder.value = true
}

async function loadStatus() {
  const requestId = ++loadStatusRequestId
  const appId = props.appId

  if (!appId) {
    resetStatus()
    isLoading.value = false
    return
  }

  isLoading.value = true
  try {
    await organizationStore.awaitInitialLoad()

    const bundleResult = await supabase
      .from('app_versions')
      .select('id')
      .eq('app_id', appId)
      .eq('deleted', false)
      .neq('name', 'unknown')
      .neq('name', 'builtin')
      .limit(1)

    if (requestId !== loadStatusRequestId)
      return

    if (bundleResult.error) {
      console.error('Cannot load store release validation status', {
        bundleError: bundleResult.error,
      })
      resetStatus()
      return
    }

    hasLiveUpdateBundle.value = (bundleResult.data?.length ?? 0) > 0
    if (!hasLiveUpdateBundle.value) {
      hasStoreInstalledDevice.value = false
      hasTestFlightDevice.value = false
      hasTrackUnknownDevice.value = false
      return
    }

    let installSourceCounts: InstallSourceCounts
    hasDeviceCountError.value = false
    try {
      installSourceCounts = await getInstallSourceCounts(appId)
    }
    catch (error) {
      if (requestId !== loadStatusRequestId)
        return
      console.error('Cannot count store release validation install sources', error)
      hasDeviceCountError.value = true
      scheduleStatusRetry(appId, requestId)
      return
    }

    if (requestId !== loadStatusRequestId)
      return

    clearStatusRetry()
    hasStoreInstalledDevice.value = countInstallSources(installSourceCounts, RELEASE_INSTALL_SOURCES) > 0
    hasTestFlightDevice.value = countInstallSources(installSourceCounts, TEST_INSTALL_SOURCES) > 0
    hasTrackUnknownDevice.value = countInstallSources(installSourceCounts, TRACK_UNKNOWN_INSTALL_SOURCES) > 0
  }
  catch (error) {
    if (requestId !== loadStatusRequestId)
      return
    console.error('Cannot load store release validation status', error)
    resetStatus()
  }
  finally {
    if (requestId === loadStatusRequestId)
      isLoading.value = false
  }
}
function closeModal() {
  isOpen.value = false
  hasConfirmedPublished.value = false
  setupError.value = ''
  setupSuccess.value = ''
}

function dismissPrompt() {
  closeModal()
  hasDismissedPrompt.value = true
}

function openModal() {
  isOpen.value = true
  void queueReminder()
}

function confirmPublished() {
  hasConfirmedPublished.value = true
  void loadChannels()
}

async function loadChannels() {
  isLoadingChannels.value = true
  setupError.value = ''
  setupSuccess.value = ''
  try {
    const { data, error } = await supabase
      .from('channels')
      .select('id,name,public,app_id,allow_emulator,allow_device,allow_dev,allow_prod,ios,android,electron')
      .eq('app_id', props.appId)
      .order('name')

    if (error) {
      console.error('Cannot load release validation channels', error)
      setupError.value = t('store-release-validation-setup-load-error')
      return
    }

    channels.value = data ?? []
    if (!selectedChannelId.value || !channels.value.some(channel => channel.id === selectedChannelId.value))
      selectedChannelId.value = pickDefaultChannel(channels.value)?.id ?? null
  }
  finally {
    isLoadingChannels.value = false
  }
}

async function applyProductionSetup() {
  const channel = selectedChannel.value
  if (!channel) {
    setupError.value = t('store-release-validation-setup-empty')
    return
  }

  if (setupForm.value.makeDefault && selectedChannelPlatforms.value.length === 0) {
    setupError.value = t('store-release-validation-setup-no-platform')
    return
  }

  setupError.value = ''
  setupSuccess.value = ''
  isApplyingSetup.value = true
  try {
    const selectedPlatformSet = new Set(selectedChannelPlatforms.value)
    const selectedUpdate: ChannelUpdate = {
      allow_dev: !setupForm.value.blockDev,
      allow_device: setupForm.value.allowDevice,
      allow_emulator: !setupForm.value.blockEmulator,
      allow_prod: setupForm.value.allowProd,
      ...(setupForm.value.makeDefault ? { public: true } : {}),
    }

    const { error: selectedError } = await supabase
      .from('channels')
      .update(selectedUpdate)
      .eq('app_id', props.appId)
      .eq('id', channel.id)

    if (selectedError) {
      console.error('Cannot apply release validation channel setup', selectedError)
      setupError.value = t('store-release-validation-setup-apply-error')
      return
    }

    const disablePublicChannelIds = setupForm.value.makeDefault
      ? channels.value
          .filter((current) => {
            if (current.id === channel.id)
              return false
            const currentPlatforms = DOWNLOAD_PLATFORMS.filter(platform => current[platform])
            return currentPlatforms.length === 0 || currentPlatforms.some(platform => selectedPlatformSet.has(platform))
          })
          .map(current => current.id)
      : []

    if (disablePublicChannelIds.length > 0) {
      const { error: publicError } = await supabase
        .from('channels')
        .update({ public: false })
        .eq('app_id', props.appId)
        .in('id', disablePublicChannelIds)

      if (publicError) {
        console.error('Cannot update release validation default channel setup', publicError)
        setupError.value = t('store-release-validation-setup-apply-error')
        return
      }
    }

    channels.value = channels.value.map((current) => {
      const isSelected = current.id === channel.id
      const shouldDisablePublic = disablePublicChannelIds.includes(current.id)
      if (isSelected) {
        return {
          ...current,
          allow_dev: selectedUpdate.allow_dev ?? current.allow_dev,
          allow_device: selectedUpdate.allow_device ?? current.allow_device,
          allow_emulator: selectedUpdate.allow_emulator ?? current.allow_emulator,
          allow_prod: selectedUpdate.allow_prod ?? current.allow_prod,
          public: setupForm.value.makeDefault ? true : current.public,
        }
      }

      return {
        ...current,
        public: shouldDisablePublic ? false : current.public,
      }
    })
    setupSuccess.value = t('store-release-validation-setup-applied')
  }
  finally {
    isApplyingSetup.value = false
  }
}

watch(() => [props.appId, organizationStore.currentOrganization?.gid], () => {
  clearStatusRetry()
  isOpen.value = false
  hasConfirmedPublished.value = false
  hasDismissedPrompt.value = false
  hasQueuedReminder.value = false
  void loadStatus()
}, { immediate: true })

watch(shouldPrompt, (value) => {
  if (!value)
    return

  void queueReminder()
}, { immediate: true })

onUnmounted(() => {
  clearStatusRetry()
})
</script>

<template>
  <div
    v-if="shouldPrompt && !isOpen"
    data-test="store-release-validation-alert"
    class="mb-4 rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950"
  >
    <div class="flex flex-col gap-3 border-l-4 border-azure-500 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div class="flex min-w-0 gap-2.5">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <IconStore class="h-4 w-4" />
        </span>

        <div class="min-w-0">
          <p class="text-sm font-semibold leading-5 text-slate-950 dark:text-white">
            {{ t('store-release-validation-badge') }}
          </p>
          <p class="mt-0.5 max-w-3xl text-sm leading-5 text-slate-600 dark:text-slate-300">
            {{ body }}
          </p>
          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs leading-4 text-slate-500 dark:text-slate-400">
            <span class="inline-flex items-center gap-1.5">
              <IconCheck class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
              {{ t('store-release-validation-signal-live-update') }}
            </span>
            <span class="inline-flex items-center gap-1.5">
              <IconSmartphone class="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
              {{ storeSignal }}
            </span>
            <span class="inline-flex items-center gap-1.5">
              <IconBell class="h-3.5 w-3.5 text-amber-600 dark:text-amber-300" />
              {{ t('store-release-validation-signal-reminder') }}
            </span>
          </div>
        </div>
      </div>

      <div class="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          class="d-btn d-btn-ghost d-btn-sm h-9 min-h-9 px-3 text-slate-600 dark:text-slate-300"
          data-test="store-release-validation-dismiss"
          @click="dismissPrompt"
        >
          {{ t('store-release-validation-dismiss') }}
        </button>
        <button
          type="button"
          class="d-btn d-btn-primary d-btn-sm h-9 min-h-9 px-3"
          data-test="store-release-validation-open"
          @click="openModal"
        >
          {{ t('store-release-validation-open') }}
          <IconArrowRight class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
  <Teleport to="body">
    <div
      v-if="shouldPrompt && isOpen"
      class="d-modal d-modal-open"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="hasConfirmedPublished ? 'store-release-validation-checklist-title' : 'store-release-validation-title'"
    >
      <div class="d-modal-box w-[calc(100vw-2rem)] max-w-2xl rounded-lg border border-slate-200 bg-white p-0 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div class="border-b border-slate-100 px-5 py-4 dark:border-slate-800 sm:px-6">
          <div class="flex items-start gap-3">
            <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-200 dark:ring-slate-700">
              <IconStore class="h-5 w-5" />
            </span>
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-normal text-slate-500 dark:text-slate-400">
                {{ t('store-release-validation-badge') }}
              </p>
              <h2
                v-if="!hasConfirmedPublished"
                id="store-release-validation-title"
                class="mt-1 text-lg font-semibold leading-7 text-slate-950 dark:text-white"
              >
                {{ title }}
              </h2>
              <h2
                v-else
                id="store-release-validation-checklist-title"
                class="mt-1 text-lg font-semibold leading-7 text-slate-950 dark:text-white"
              >
                {{ t('store-release-validation-checklist-title') }}
              </h2>
            </div>
          </div>
        </div>

        <div v-if="!hasConfirmedPublished" class="px-5 py-5 dark:text-slate-200 sm:px-6">
          <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ body }}
          </p>

          <div class="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/40">
            <p class="text-sm font-medium text-slate-900 dark:text-white">
              {{ t('store-release-validation-checklist-title') }}
            </p>
            <ul class="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300">
              <li class="flex gap-2">
                <IconCheck class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
                <span>{{ t('store-release-validation-signal-live-update') }}</span>
              </li>
              <li class="flex gap-2">
                <IconSmartphone class="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
                <span>{{ storeSignal }}</span>
              </li>
              <li class="flex gap-2">
                <IconBell class="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                <span>{{ t('store-release-validation-signal-reminder') }}</span>
              </li>
            </ul>
          </div>
        </div>

        <div v-else class="px-5 py-5 sm:px-6">
          <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('store-release-validation-checklist-body') }}
          </p>

          <div class="mt-5 space-y-4">
            <div>
              <label for="store-release-validation-channel" class="text-sm font-medium text-slate-800 dark:text-slate-100">
                {{ t('store-release-validation-setup-channel-label') }}
              </label>
              <select
                id="store-release-validation-channel"
                v-model.number="selectedChannelId"
                class="d-select d-select-bordered mt-2 min-h-11 w-full bg-white text-slate-950 dark:bg-slate-950 dark:text-white"
                :disabled="isLoadingChannels || isApplyingSetup || !channels.length"
              >
                <option v-for="channel in channels" :key="channel.id" :value="channel.id">
                  {{ channel.name }} - {{ channelPlatformLabel(channel) }}
                </option>
              </select>
              <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {{ isLoadingChannels ? t('store-release-validation-setup-loading') : t('store-release-validation-setup-channel-help') }}
              </p>
            </div>

            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/40">
              <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p class="text-sm font-semibold text-slate-900 dark:text-white">
                    {{ selectedChannel?.name ?? t('store-release-validation-setup-empty') }}
                  </p>
                  <p class="text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {{ selectedChannelPlatformLabel }}
                  </p>
                </div>
                <span v-if="selectedChannel?.public" class="mt-2 w-fit rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200 sm:mt-0">
                  {{ t('store-release-validation-current-default') }}
                </span>
              </div>

              <div class="mt-4 grid gap-3 sm:grid-cols-2">
                <label class="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  <input v-model="setupForm.makeDefault" type="checkbox" class="d-toggle d-toggle-sm d-toggle-primary" :disabled="isApplyingSetup">
                  <span>{{ t('store-release-validation-setup-make-default') }}</span>
                </label>
                <label class="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  <input v-model="setupForm.allowProd" type="checkbox" class="d-toggle d-toggle-sm d-toggle-primary" :disabled="isApplyingSetup">
                  <span>{{ t('store-release-validation-setup-allow-prod') }}</span>
                </label>
                <label class="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  <input v-model="setupForm.allowDevice" type="checkbox" class="d-toggle d-toggle-sm d-toggle-primary" :disabled="isApplyingSetup">
                  <span>{{ t('store-release-validation-setup-allow-device') }}</span>
                </label>
                <label class="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  <input v-model="setupForm.blockDev" type="checkbox" class="d-toggle d-toggle-sm d-toggle-primary" :disabled="isApplyingSetup">
                  <span>{{ t('store-release-validation-setup-block-dev') }}</span>
                </label>
                <label class="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 sm:col-span-2">
                  <input v-model="setupForm.blockEmulator" type="checkbox" class="d-toggle d-toggle-sm d-toggle-primary" :disabled="isApplyingSetup">
                  <span>{{ t('store-release-validation-setup-block-emulator') }}</span>
                </label>
              </div>
            </div>

            <ul class="space-y-3 text-sm text-slate-700 dark:text-slate-200">
              <li v-for="item in validationItems" :key="item.key" class="flex gap-3">
                <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" :class="item.enabled ? 'bg-azure-50 text-azure-600 dark:bg-azure-400/15 dark:text-azure-200' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'">
                  <IconCheck v-if="item.enabled" class="h-3.5 w-3.5" />
                  <IconCircleDot v-else class="h-3.5 w-3.5" />
                </span>
                <span class="leading-6">{{ item.label }}</span>
              </li>
            </ul>

            <p v-if="setupError" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
              {{ setupError }}
            </p>
            <p v-if="setupSuccess" class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100">
              {{ setupSuccess }}
            </p>
          </div>
        </div>

        <div class="flex flex-col-reverse gap-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800 sm:flex-row sm:justify-end sm:px-6">
          <template v-if="!hasConfirmedPublished">
            <button class="d-btn d-btn-ghost min-h-11" type="button" data-test="store-release-validation-later" @click="closeModal">
              {{ t('store-release-validation-later') }}
            </button>
            <button class="d-btn d-btn-primary min-h-11" type="button" @click="confirmPublished">
              {{ t('store-release-validation-confirm') }}
              <IconArrowRight class="h-4 w-4" />
            </button>
          </template>
          <template v-else>
            <button class="d-btn d-btn-ghost min-h-11" type="button" @click="closeModal">
              {{ t('store-release-validation-close') }}
            </button>
            <button class="d-btn d-btn-primary min-h-11" type="button" :disabled="isLoadingChannels || isApplyingSetup || !selectedChannel" @click="applyProductionSetup">
              <IconSettings class="h-4 w-4" />
              {{ isApplyingSetup ? t('store-release-validation-setup-applying') : t('store-release-validation-setup-apply') }}
            </button>
          </template>
        </div>
      </div>
      <form method="dialog" class="d-modal-backdrop">
        <button type="button" :aria-label="t('store-release-validation-close')" @click="closeModal" />
      </form>
    </div>
  </Teleport>
</template>
