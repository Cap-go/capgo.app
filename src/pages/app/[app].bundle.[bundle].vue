<script setup lang="ts">
import type { LinkedChannel } from '~/services/bundleLinkedChannels'
import type { ChannelPromotionTarget } from '~/services/channelPromotion'
import type { Database } from '~/types/supabase.types'
import { Capacitor } from '@capacitor/core'
import { FormKit } from '@formkit/vue'
import { parse } from '@std/semver'
import { computedAsync } from '@vueuse/core'
import { computed, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconArchiveBoxArrowDown from '~icons/heroicons/archive-box-arrow-down'
import Settings from '~icons/heroicons/cog-8-tooth'
import IconDocumentDuplicate from '~icons/heroicons/document-duplicate'
import IconTrash from '~icons/heroicons/trash'
import IconSearch from '~icons/ic/round-search?raw'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconPencil from '~icons/lucide/pencil'
import { fetchLinkedChannelsForVersion, formatLinkedChannel, unlinkLinkedChannels } from '~/services/bundleLinkedChannels'
import { findChannelsWithoutPromotionPermission, formatChannelPromotionTargets } from '~/services/channelPromotion'
import { formatBytes, getChecksumInfo } from '~/services/conversion'
import { formatDate, formatLocalDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { checkCompatibilityNativePackages, isCompatible, useSupabase } from '~/services/supabase'
import { openVersion } from '~/services/versions'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const route = useRoute('/app/[app].bundle.[bundle]')
const router = useRouter()
const dialogStore = useDialogV2Store()
const displayStore = useDisplayStore()
const main = useMainStore()
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<number>()
const loading = ref(true)
const version = ref<Database['public']['Tables']['app_versions']['Row']>()
const channels = ref<(Database['public']['Tables']['channels']['Row'])[]>([])
const channel = ref<(Database['public']['Tables']['channels']['Row'])>()
const version_meta = ref<Database['public']['Tables']['app_versions_meta']['Row']>()
const showBundleMetadataInput = ref<boolean>(false)
const hasManifest = ref<boolean>(false)
const showChecksumTooltip = ref(false)
const metadataLink = ref('')
const metadataComment = ref('')

// Channel chooser state
const selectedChannelForLink = ref<Database['public']['Tables']['channels']['Row'] | null>(null)
const currentChannelAction = ref<'set' | 'open' | 'unlink' | null>(null)
const channelSearchVal = ref('')
const filteredChannels = ref<(Database['public']['Tables']['channels']['Row'])[]>([])
const promotableChannelIds = ref<Set<number>>(new Set())

function canPromoteChannel(channelId: number) {
  return promotableChannelIds.value.has(channelId)
}

function getPromotableChannels() {
  return channels.value.filter(channel => canPromoteChannel(channel.id))
}

function showChannelUnlinkPermissionError(deniedChannels: ChannelPromotionTarget[]) {
  toast.error(t('channel-permission-unlink-required', {
    channels: formatChannelPromotionTargets(deniedChannels),
  }))
}

// Watch for search changes
watch(() => channelSearchVal.value, () => {
  const promotableChannels = getPromotableChannels()
  if (channelSearchVal.value.trim()) {
    filteredChannels.value = promotableChannels.filter(channel =>
      channel.name.toLowerCase().includes(channelSearchVal.value.toLowerCase()),
    )
  }
  else {
    filteredChannels.value = promotableChannels
  }
})

// Update filtered channels when channels change
watch([() => channels.value, () => promotableChannelIds.value], () => {
  const promotableChannels = getPromotableChannels()
  if (channelSearchVal.value.trim()) {
    filteredChannels.value = promotableChannels.filter(channel =>
      channel.name.toLowerCase().includes(channelSearchVal.value.toLowerCase()),
    )
  }
  else {
    filteredChannels.value = promotableChannels
  }
}, { immediate: true })

const canPromoteBundle = computed(() => promotableChannelIds.value.size > 0)

const canEditBundleMetadata = computedAsync(async () => {
  if (!version.value?.app_id)
    return false
  return await checkPermissions('app.upload_bundle', { appId: version.value.app_id })
}, false)

const selectableChannels = computed(() => {
  return filteredChannels.value.filter(channel => canPromoteChannel(channel.id))
})

const canDeleteBundle = computedAsync(async () => {
  if (!version.value?.app_id)
    return false
  return await checkPermissions('bundle.delete', { appId: version.value.app_id })
}, false)

const canUpdateBundleMetadata = computedAsync(async () => {
  if (!version.value?.app_id)
    return false
  return await checkPermissions('app.update_settings', { appId: version.value.app_id })
}, false)

// Function to open link in a new tab
function openLink(url?: string): void {
  if (!url)
    return

  try {
    const parsedUrl = new URL(url, globalThis.location.origin)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      console.warn('Blocked unsafe bundle link protocol')
      return
    }

    globalThis.open(parsedUrl.toString(), '_blank', 'noopener,noreferrer')
  }
  catch {
    console.warn('Cannot open invalid bundle link')
  }
}

async function copyToast(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    console.log('displayStore.messageToast', displayStore.messageToast)
    toast.success(t('copied-to-clipboard'))
  }
  catch (err) {
    console.error('Failed to copy: ', err)
    // Display a modal with the copied key
    dialogStore.openDialog({
      title: t('cannot-copy'),
      description: text,
      buttons: [
        {
          text: t('ok'),
          role: 'primary',
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
}

async function getChannels() {
  if (!version.value)
    return
  channel.value = undefined
  const appId = version.value.app_id
  const { data: dataChannel, error: channelsError } = await supabase
    .from('channels')
    .select()
    .eq('app_id', appId)
    // .eq('version', version.value.id)
    .order('updated_at', { ascending: false })

  if (channelsError) {
    console.error('Cannot load channels:', channelsError)
    channels.value = []
    filteredChannels.value = []
    promotableChannelIds.value = new Set()
    return
  }

  channels.value = dataChannel ?? []
  const channelPermissions = await Promise.all(channels.value.map(async (channel) => {
    try {
      const allowed = await checkPermissions('channel.promote_bundle', { appId, channelId: channel.id })
      return { channelId: channel.id, allowed }
    }
    catch (error) {
      console.error('Cannot check channel promotion permission:', error)
      return { channelId: channel.id, allowed: false }
    }
  }))
  promotableChannelIds.value = new Set(channelPermissions.filter(result => result.allowed).map(result => result.channelId))
  showBundleMetadataInput.value = channels.value.some(c => c.disable_auto_update === 'version_number')
}

async function openChannelLink() {
  if (!version.value || !channel.value)
    return
  router.push(`/app/${version.value.app_id}/channel/${channel.value?.id}`)
}

const hasZip = computed(() => {
  return Boolean(version.value?.r2_path || version.value?.external_url)
})

const zipSizeLabel = computed(() => {
  if (version_meta.value?.size)
    return formatBytes(version_meta.value.size)
  if (version.value?.external_url)
    return t('stored-externally')
  return t('metadata-not-found')
})

const checksumInfo = computed(() => {
  return getChecksumInfo(version.value?.checksum)
})

// add check compatibility here
async function setChannel(channel: Database['public']['Tables']['channels']['Row'], id: number | null) {
  if (!canPromoteChannel(channel.id)) {
    toast.error(t('no-permission'))
    throw new Error('No permission')
  }

  if (id !== null && typeof id !== 'number') {
    console.error('Invalid version ID:', id)
    toast.error(t('error-invalid-version'))
    throw new Error('Invalid version ID')
  }

  if (!(await checkPermissions('channel.promote_bundle', { channelId: channel.id }))) {
    toast.error(t('no-permission'))
    throw new Error('No permission to update channel version')
  }

  return supabase
    .from('channels')
    .update({
      version: id,
    })
    .eq('id', channel.id)
    .throwOnError()
}

async function ASChannelChooser() {
  if (!version.value)
    return
  if (!canPromoteBundle.value) {
    toast.error(t('no-permission'))
    return
  }

  selectedChannelForLink.value = null
  currentChannelAction.value = 'set'
  channelSearchVal.value = ''
  filteredChannels.value = getPromotableChannels()

  dialogStore.openDialog({
    title: t('channel-linking'),
    size: 'lg',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('set-bundle'),
        role: 'primary',
        handler: async () => {
          if (!selectedChannelForLink.value) {
            toast.error(t('please-select-channel'))
            return false
          }
          await handleChannelLink(selectedChannelForLink.value)
          return true
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function handleChannelLink(chan: Database['public']['Tables']['channels']['Row']) {
  if (!version.value)
    return
  if (!canPromoteChannel(chan.id)) {
    toast.error(t('no-permission'))
    return
  }

  try {
    const {
      finalCompatibility,
      localDependencies,
    } = await checkCompatibilityNativePackages(version.value.app_id, chan.name, (version.value.native_packages as any) ?? [])

    // Check if any package is incompatible
    if (localDependencies.length > 0 && finalCompatibility.some(x => !isCompatible(x))) {
      toast.error(t('bundle-not-compatible-with-channel', { channel: chan.name }))

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
              const compareQuery = chan.version ? `?compare=${chan.version}` : ''
              router.push(`/app/${packageId.value}/bundle/${version.value!.id}/dependencies${compareQuery}`)
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
      toast.info(t('bundle-compatible-with-channel', { channel: chan.name }))
    }
    await setChannel(chan, version.value.id)
    await getChannels()
    toast.success(t('linked-bundle'))
    toast.info(t('cloud-replication-delay'))
  }
  catch (error) {
    console.error(error)
    toast.error(t('cannot-test-app-some'))
  }
}

async function openChannel(selChannel: Database['public']['Tables']['channels']['Row']) {
  channel.value = selChannel
  if (!version.value || !main.auth)
    return
  if (!channel.value)
    return ASChannelChooser()

  // Direct navigation to channel
  await openChannelLink()
}

async function openChannelSettings(selChannel: Database['public']['Tables']['channels']['Row']) {
  channel.value = selChannel
  if (!version.value || !main.auth)
    return
  if (!channel.value)
    return ASChannelChooser()

  selectedChannelForLink.value = selChannel
  currentChannelAction.value = 'open'

  dialogStore.openDialog({
    title: t('channel-actions'),
    size: 'lg',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function handleChannelAction(action: 'set' | 'open' | 'unlink') {
  if (!channel.value)
    return

  // Close the channel actions modal before performing actions
  dialogStore.closeDialog()

  if (action === 'set') {
    await ASChannelChooser()
  }
  else if (action === 'open') {
    await openChannelLink()
  }
  else if (action === 'unlink') {
    try {
      await setChannel(channel.value, null)
      await getChannels()
      toast.success(t('channels-unlinked-successfully'))
      toast.info(t('cloud-replication-delay'))
    }
    catch (error) {
      console.error(error)
      toast.error(t('cannot-test-app-some'))
    }
  }
}

async function downloadNow() {
  if (!version.value)
    return
  if (version.value.session_key) {
    const filename = version.value.r2_path?.replace('/', '_')
    const localPath = `./${filename}`
    const command = `npx @capgo/cli@latest bundle decrypt ${localPath}  ${version.value.session_key} --key ./.capgo_key`

    dialogStore.openDialog({
      title: t('to-open-encrypted-bu'),
      buttons: [
        {
          text: t('copy-command'),
          role: 'primary',
          handler: () => {
            copyToast(command)
          },
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
  openVersion(version.value)
}

async function openDownload() {
  if (!version.value || !main.auth)
    return
  dialogStore.openDialog({
    title: t('are-you-sure-you-want-to-download'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: Capacitor.isNativePlatform() ? t('launch-bundle') : t('download'),
        role: 'primary',
        handler: async () => {
          await downloadNow()
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

function normalizeOptionalMetadata(value: string) {
  const trimmedValue = value.trim()
  return trimmedValue.length > 0 ? trimmedValue : null
}

async function saveBundleMetadata() {
  if (!version.value)
    return false

  if (!canUpdateBundleMetadata.value) {
    toast.error(t('no-permission'))
    return false
  }

  const { data, error } = await supabase
    .from('app_versions')
    .update({
      link: normalizeOptionalMetadata(metadataLink.value),
      comment: normalizeOptionalMetadata(metadataComment.value),
    })
    .eq('app_id', version.value.app_id)
    .eq('id', version.value.id)
    .select()
    .single()

  if (error || !data) {
    console.error('Cannot update bundle metadata', error)
    toast.error(t('cannot-update-bundle-metadata'))
    return false
  }

  version.value = data
  toast.success(t('bundle-metadata-updated'))
  return true
}

async function openBundleMetadataDialog() {
  if (!version.value)
    return

  if (!canUpdateBundleMetadata.value) {
    toast.error(t('no-permission'))
    return
  }

  metadataLink.value = version.value.link ?? ''
  metadataComment.value = version.value.comment ?? ''

  dialogStore.openDialog({
    title: t('edit-bundle-metadata'),
    size: 'lg',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('update'),
        role: 'primary',
        handler: saveBundleMetadata,
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function getVersion() {
  if (!id.value)
    return
  try {
    const { data } = await supabase
      .from('app_versions')
      .select()
      .eq('app_id', packageId.value)
      .eq('id', id.value)
      .single()
    const { data: dataVersionsMeta } = await supabase
      .from('app_versions_meta')
      .select()
      .eq('id', id.value)
      .single()
    if (!data) {
      console.error('no version found')
      return
    }
    if (dataVersionsMeta)
      version_meta.value = dataVersionsMeta

    hasManifest.value = data.manifest_count > 0
    version.value = data
    if (version.value?.name)
      displayStore.setBundleName(String(version.value.id), version.value.name)
    displayStore.NavTitle = version.value?.name ?? t('bundle')
  }
  catch (error) {
    console.error(error)
  }
}

watchEffect(async () => {
  if (route.path.includes('/bundle/')) {
    loading.value = true
    packageId.value = route.params.app as string
    id.value = Number(route.params.bundle as string)
    await getVersion()
    await getChannels()
    loading.value = false
    if (!version.value?.name)
      displayStore.NavTitle = t('bundle')
    displayStore.defaultBack = `/app/${route.params.app}/bundles`
  }
})

function hideString(str: string) {
  const first = str.slice(0, 5)
  const last = str.slice(-5)
  return `${first}...${last}`
}

async function saveCustomId(input: string) {
  if (!id.value)
    return

  if (!canEditBundleMetadata.value) {
    toast.error(t('no-permission'))
    return
  }

  if (input.length === 0) {
    const { error: errorNull } = await supabase
      .from('app_versions')
      .update({
        min_update_version: null,
      })
      .eq('id', id.value)

    if (errorNull) {
      console.log('Cannot set min update version to null', errorNull)
      return
    }

    toast.success(t('updated-min-version'))
    return
  }

  if (!parse(input)) {
    toast.error(t('invalid-version'))
    return
  }

  const { error } = await supabase
    .from('app_versions')
    .update({
      min_update_version: input,
    })
    .eq('id', id.value)

  if (error) {
    console.log('Cannot set min update version', error)
    return
  }

  toast.success(t('updated-min-version'))
}

function guardMinAutoUpdate(event: Event) {
  if (!canEditBundleMetadata.value) {
    toast.error(t('no-permission'))
    event.preventDefault()
    return false
  }
}

function preventInputChangePerm(event: Event) {
  if (!canEditBundleMetadata.value) {
    event.preventDefault()
    return false
  }
}

// Replicated logic from BundleTable.vue for deletion
async function didCancel(name: string, askForMethod = true): Promise<boolean | 'normal' | 'unsafe'> {
  let method: 'normal' | 'unsafe' | null = null
  if (askForMethod) {
    dialogStore.openDialog({
      title: t('select-style-of-deletion'),
      description: t('select-style-of-deletion-msg'),
      buttons: [
        {
          text: t('normal'),
          role: 'secondary',
          handler: () => {
            method = 'normal'
          },
        },
        {
          text: t('unsafe'),
          role: 'danger',
          handler: async () => {
            if (!canDeleteBundle.value) {
              toast.error(t('no-permission-ask-super-admin'))
              return false
            }
            method = 'unsafe'
          },
        },
      ],
    })
    if (await dialogStore.onDialogDismiss() || !method)
      return true
  }
  else {
    method = 'unsafe' // If not asking, assume unsafe (used for already soft-deleted)
  }

  const description = askForMethod
    ? `${t('alert-not-reverse-message')} ${t('alert-delete-message')} ${name} ${t('you-cannot-reuse')}.`
    : `${t('alert-not-reverse-message')} ${t('alert-delete-message')} ${name}?`

  dialogStore.openDialog({
    title: t('alert-confirm-delete'),
    description,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-delete'),
        role: 'danger',
      },
    ],
  })

  if (await dialogStore.onDialogDismiss())
    return true
  if (method === null)
    throw new Error('Unreachable, method = null')

  return method
}

async function unlinkChannels(_appId: string, unlink: LinkedChannel[]) {
  // Unlink channels if confirmed
  const updateError = await unlinkLinkedChannels(unlink)
  if (updateError) {
    toast.error(t('unlink-error'))
    console.error('Channel unlink error:', updateError)
    return Promise.reject(new Error('Channel unlink error'))
  }
  toast.success(t('channels-unlinked-successfully')) // Add translation key
}

async function deleteBundle() {
  if (!version.value)
    return

  if (!canDeleteBundle.value) {
    toast.error(t('no-permission'))
    return
  }

  try {
    const { data: channelFound, error: errorChannel } = await fetchLinkedChannelsForVersion(version.value.app_id, version.value.id)

    let unlink = [] as LinkedChannel[]
    if (errorChannel) {
      console.error('Error checking channels:', errorChannel)
      toast.error(t('error-checking-channels'))
      return
    }

    if (channelFound && channelFound.length > 0) {
      const linkedChannels = channelFound as LinkedChannel[]
      const deniedChannels = await findChannelsWithoutPromotionPermission(version.value.app_id, linkedChannels)
      if (deniedChannels.length > 0) {
        showChannelUnlinkPermissionError(deniedChannels)
        return
      }

      let shouldUnlink = false

      dialogStore.openDialog({
        title: t('want-to-unlink'),
        description: t('channel-bundle-linked', {
          channels: linkedChannels.map(formatLinkedChannel).join(', '),
        }),
        buttons: [
          {
            text: t('no'),
            role: 'cancel',
          },
          {
            text: t('yes'),
            role: 'primary',
            handler: () => {
              shouldUnlink = true
              unlink = linkedChannels
            },
          },
        ],
      })

      const cancelled = await dialogStore.onDialogDismiss()
      if (cancelled || !shouldUnlink) {
        toast.info(t('canceled-delete')) // Use info for cancellation
        return
      }
    }

    // Prevent deletion of essential bundles
    if (version.value.name === 'unknown' || version.value.name === 'builtin') {
      toast.error(t('cannot-delete-unknown-or-builtin'))
      return
    }

    const didCancelRes = await didCancel(t('bundle'), !version.value.deleted)
    if (typeof didCancelRes === 'boolean' && didCancelRes === true) {
      toast.info(t('canceled-delete'))
      return
    }

    await unlinkChannels(version.value.app_id, unlink)

    // Perform deletion (soft or hard)
    const deleteQuery = didCancelRes === 'normal'
      ? supabase
          .from('app_versions')
          .update({ deleted: true })
          .eq('id', version.value.id)
          .eq('app_id', version.value.app_id)
      : supabase
          .from('app_versions')
          .delete()
          .eq('id', version.value.id)
          .eq('app_id', version.value.app_id)

    const { error: deleteError } = await deleteQuery

    if (deleteError) {
      toast.error(t('cannot-delete-bundle'))
      console.error('Bundle deletion error:', deleteError)
    }
    else {
      toast.success(t('bundle-deleted'))
      // Navigate back to the bundle list
      router.push(`/app/${packageId.value}/bundles/`)
    }
  }
  catch (error) {
    console.error('Unexpected error during deletion:', error)
    toast.error(t('cannot-delete-bundle'))
  }
}
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="version">
      <div id="devices" class="mt-0 md:mt-8">
        <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
          <div
            class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg border-slate-300 dark:border-slate-900 dark:bg-slate-800"
          >
            <dl class="divide-y divide-slate-200 dark:divide-slate-500">
              <InfoRow :label="t('bundle-number')">
                {{ version.name }}
              </InfoRow>
              <InfoRow :label="t('id')">
                {{ version.id.toString() }}
              </InfoRow>
              <InfoRow v-if="version.created_at" :label="t('created-at')">
                {{ formatDate(version.created_at) }}
              </InfoRow>
              <InfoRow v-if="version.updated_at" :label="t('updated-at')">
                {{ formatDate(version.updated_at) }}
              </InfoRow>
              <!-- Checksum -->
              <InfoRow
                v-if="version.checksum" :label="t('checksum')"
              >
                <span class="flex items-center gap-2">
                  {{ hideString(version.checksum) }}
                  <!-- Checksum type badge with tooltip -->
                  <div class="relative">
                    <button
                      type="button"
                      class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full cursor-help"
                      :class="{
                        'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200': checksumInfo.type === 'sha256',
                        'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200': checksumInfo.type === 'crc32',
                        'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200': checksumInfo.type === 'unknown',
                      }"
                      @click="showChecksumTooltip = !showChecksumTooltip"
                      @mouseenter="showChecksumTooltip = true"
                      @mouseleave="showChecksumTooltip = false"
                    >
                      {{ checksumInfo.label }}
                    </button>
                    <!-- Tooltip -->
                    <div
                      v-show="showChecksumTooltip"
                      class="absolute right-0 z-50 px-3 py-2 mb-2 text-xs text-white bg-gray-900 rounded-lg shadow-lg bottom-full dark:bg-gray-700 min-w-max"
                    >
                      <div class="mb-1 font-medium">{{ t('checksum-type-info') }}</div>
                      <div>{{ t('min-plugin-version') }}: {{ checksumInfo.minPluginVersion }}</div>
                      <div v-if="checksumInfo.type === 'sha256'" class="mt-1 text-blue-300">{{ t('checksum-sha256-desc') }}</div>
                      <div v-else-if="checksumInfo.type === 'crc32'" class="mt-1 text-green-300">{{ t('checksum-crc32-desc') }}</div>
                      <!-- Tooltip arrow -->
                      <div class="absolute -mt-px border-4 border-transparent right-4 top-full border-t-gray-900 dark:border-t-gray-700" />
                    </div>
                  </div>
                  <button
                    class="p-1 transition-colors border border-gray-200 rounded-md dark:border-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800"
                    @click="copyToast(version?.checksum ?? '')"
                  >
                    <IconDocumentDuplicate class="w-4 h-4 text-gray-500 cursor-pointer dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400" />
                  </button>
                </span>
              </InfoRow>
              <!-- Min update version -->
              <InfoRow
                v-if="showBundleMetadataInput" id="metadata-bundle"
                :label="t('min-update-version')" editable
                :readonly="!canEditBundleMetadata"
                @click="guardMinAutoUpdate" @update:value="(saveCustomId as any)" @keydown="preventInputChangePerm"
              >
                {{ version.min_update_version }}
              </InfoRow>

              <InfoRow v-if="channels && channels.length > 0 && version && channels.filter(c => c.version === version!.id).length > 0" :label="t('channel')">
                <div class="flex flex-wrap justify-end w-full gap-3">
                  <div v-for="chn in channels.filter(c => c.version === version!.id)" :id="`open-channel-${chn.id}`" :key="chn.id" class="flex items-center gap-2">
                    <span
                      class="font-bold text-blue-600 underline cursor-pointer dark:text-blue-500 hover:text-blue-700 underline-offset-4 dark:hover:text-blue-400"
                      @click="openChannel(chn)"
                    >
                      {{ chn!.name }}
                    </span>
                    <button
                      class="p-1 transition-colors border border-gray-200 rounded-md dark:border-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800"
                      @click="openChannelSettings(chn)"
                    >
                      <Settings class="w-4 h-4 text-gray-500 cursor-pointer dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400" />
                    </button>
                  </div>
                </div>
              </InfoRow>
              <InfoRow
                v-else id="open-channel" :label="t('channel')" :is-link="true"
                @click="ASChannelChooser()"
              >
                {{ t('set-bundle') }}
              </InfoRow>
              <InfoRow
                v-if="version.session_key" :label="t('encryption')"
              >
                {{ t('encrypted') }}
              </InfoRow>
              <InfoRow
                v-else :label="t('encryption')"
              >
                {{ t('not-encrypted-bundle') }}
              </InfoRow>
              <!-- session_key -->
              <InfoRow
                v-if="version.session_key" :label="t('session_key')" :is-link="true"
                @click="copyToast(version?.session_key ?? '')"
              >
                {{ hideString(version.session_key) }}
              </InfoRow>
              <!-- key_id (public key prefix) -->
              <InfoRow
                v-if="version.key_id" :label="t('public-key-prefix')"
              >
                {{ version.key_id }}
              </InfoRow>
              <!-- cli_version -->
              <InfoRow
                v-if="version.cli_version" :label="t('cli-version')"
              >
                {{ version.cli_version }}
              </InfoRow>
              <!-- version.external_url -->
              <InfoRow
                v-if="version.external_url" :label="t('url')" :is-link="true"
                @click="copyToast(version?.external_url ?? '')"
              >
                {{ version.external_url }}
              </InfoRow>
              <!-- Bundle Link -->
              <InfoRow
                v-if="version.link || !version.deleted" :label="t('bundle-link')"
                @click="version.link ? openLink(version.link) : null"
              >
                <div class="flex items-center justify-end w-full gap-3 text-right">
                  <span
                    :class="{
                      'cursor-pointer font-bold text-blue-600 underline underline-offset-4 dark:text-blue-500': version.link,
                      'text-gray-500 dark:text-gray-400': !version.link,
                    }"
                  >
                    {{ version.link || t('bundle-link-empty') }}
                  </span>
                  <button
                    v-if="!version.deleted"
                    type="button"
                    class="p-1 transition-colors border border-gray-200 rounded-md dark:border-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800"
                    :disabled="!canUpdateBundleMetadata"
                    :title="t('edit-bundle-metadata')"
                    :aria-label="t('edit-bundle-metadata')"
                    @click.stop="openBundleMetadataDialog"
                  >
                    <IconPencil class="w-4 h-4 text-gray-500 cursor-pointer dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400" />
                  </button>
                </div>
              </InfoRow>
              <!-- Bundle Comment -->
              <InfoRow
                v-if="version.comment || !version.deleted" :label="t('bundle-comment')"
                @click="version.comment ? copyToast(version.comment) : null"
              >
                <div class="flex items-center justify-end w-full gap-3 text-right">
                  <span :class="{ 'text-gray-500 dark:text-gray-400': !version.comment }">
                    {{ version.comment || t('bundle-comment-empty') }}
                  </span>
                  <button
                    v-if="!version.deleted"
                    type="button"
                    class="p-1 transition-colors border border-gray-200 rounded-md dark:border-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800"
                    :disabled="!canUpdateBundleMetadata"
                    :title="t('edit-bundle-metadata')"
                    :aria-label="t('edit-bundle-metadata')"
                    @click.stop="openBundleMetadataDialog"
                  >
                    <IconPencil class="w-4 h-4 text-gray-500 cursor-pointer dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400" />
                  </button>
                </div>
              </InfoRow>
              <!-- zip -->
              <InfoRow :label="t('zip-bundle')">
                <span class="flex items-center gap-2">
                  <template v-if="hasZip">
                    {{ zipSizeLabel }}
                    <button
                      class="p-1 transition-colors border border-gray-200 rounded-md dark:border-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800"
                      @click="openDownload()"
                    >
                      <IconArchiveBoxArrowDown class="w-4 h-4 text-gray-500 cursor-pointer dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400" />
                    </button>
                  </template>
                  <template v-else>
                    {{ t('no-zip-bundle') }}
                  </template>
                </span>
              </InfoRow>
              <!-- manifest -->
              <InfoRow :label="t('manifest')" :is-link="hasManifest" @click="hasManifest ? router.push(`/app/${packageId}/bundle/${version?.id}/manifest`) : null">
                <span class="flex items-center gap-2">
                  <template v-if="hasManifest">
                    {{ t('open') }}
                  </template>
                  <template v-else>
                    {{ t('no-manifest-bundle') }}
                  </template>
                </span>
              </InfoRow>

              <!-- Delete Bundle Action -->
              <InfoRow
                v-if="!version.deleted"
                :label="t('status')"
                :icon="IconTrash"
                :disabled="!canDeleteBundle"
              >
                <span class="flex items-center gap-2">
                  {{ t('bundle-active') }}
                  <button
                    class="p-1 transition-colors border border-gray-200 rounded-md dark:border-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800"
                    @click="deleteBundle"
                  >
                    <IconTrash class="w-4 h-4 text-red-500 transition-colors cursor-pointer dark:text-red-400 hover:text-red-600" />
                  </button>
                </span>
              </InfoRow>

              <!-- Show deleted status if applicable -->
              <InfoRow v-if="version.deleted" :label="t('status')">
                {{ t('bundle-deleted') }}
              </InfoRow>
            </dl>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('bundle-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('bundle-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/bundles/`)">
        {{ t('back-to-bundles') }}
      </button>
    </div>

    <!-- Teleport Content for Deletion Style Modal -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('select-style-of-deletion')" defer to="#dialog-v2-content">
      <div class="mt-4 space-y-3">
        <p class="text-sm text-gray-600 dark:text-gray-400">
          {{ t('select-style-of-deletion-recommendation') }}
        </p>
        <p class="text-sm">
          {{ t('select-style-of-deletion-link') }}
          <a
            href="https://capgo.app/docs/webapp/bundles/#delete-a-bundle"
            target="_blank"
            class="ml-1 text-blue-500 underline hover:text-blue-600"
          >
            {{ t('here') }}
          </a>
        </p>
      </div>
    </Teleport>

    <!-- Teleport Content for Encrypted Command Display -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('to-open-encrypted-bu')" defer to="#dialog-v2-content">
      <div class="mt-4">
        <div class="p-3 bg-gray-100 rounded-lg dark:bg-gray-800">
          <code class="text-sm break-all">
            npx @capgo/cli@latest bundle decrypt ./{{ version?.r2_path?.replace('/', '_') }} {{ version?.session_key }} --key ./.capgo_key
          </code>
        </div>
      </div>
    </Teleport>

    <!-- Teleport Content for Unsafe Deletion Warning -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('alert-confirm-delete') && version?.deleted" defer to="#dialog-v2-content">
      <div class="p-3 mt-4 border border-red-200 rounded-lg bg-red-50 dark:border-red-800 dark:bg-red-900/20">
        <p class="text-sm text-red-800 dark:text-red-200">
          <strong class="underline">{{ t('you-are-deleting-unsafely') }}</strong>
        </p>
        <p class="mt-2 text-sm text-red-600 dark:text-red-300">
          {{ t('select-style-of-deletion-link') }}
          <a
            href="https://capgo.app/docs/webapp/bundles/#delete-a-bundle"
            target="_blank"
            class="ml-1 text-blue-500 underline hover:text-blue-600"
          >
            {{ t('here') }}
          </a>
        </p>
      </div>
    </Teleport>

    <!-- Teleport Content for Bundle Metadata Editor -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('edit-bundle-metadata')" defer to="#dialog-v2-content">
      <div class="w-full space-y-4">
        <div>
          <label for="bundle-link-input" class="text-sm font-medium text-gray-700 dark:text-gray-200">
            {{ t('bundle-link') }}
          </label>
          <input
            id="bundle-link-input"
            v-model="metadataLink"
            type="url"
            class="d-input d-input-bordered mt-2 w-full text-sm"
            :placeholder="t('bundle-link-placeholder')"
          >
        </div>
        <div>
          <label for="bundle-comment-input" class="text-sm font-medium text-gray-700 dark:text-gray-200">
            {{ t('bundle-comment') }}
          </label>
          <textarea
            id="bundle-comment-input"
            v-model="metadataComment"
            rows="4"
            class="d-textarea d-textarea-bordered mt-2 w-full resize-y text-sm"
            :placeholder="t('bundle-comment-placeholder')"
          />
        </div>
      </div>
    </Teleport>

    <!-- Teleport Content for Channel Linking (Set Bundle) -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('channel-linking') && currentChannelAction === 'set'" defer to="#dialog-v2-content">
      <div class="w-full space-y-4">
        <div class="text-center">
          <h3 class="mb-2 text-lg font-medium">
            {{ t('select-channel-to-link') }}
          </h3>
          <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
            {{ t('choose-which-channel-to-link-this-bundle-to') }}
          </p>
        </div>

        <!-- Search Input -->
        <div class="mb-6">
          <FormKit
            v-model="channelSearchVal"
            :prefix-icon="IconSearch"
            enterkeyhint="send"
            :placeholder="t('search-channels')"
            :classes="{
              outer: 'mb-0! w-full',
            }"
          />
        </div>

        <div class="space-y-3">
          <!-- Current Bundle Info -->
          <div v-if="version" class="p-3 border border-blue-300 rounded-lg bg-blue-50 dark:border-blue-600 dark:bg-blue-900/20">
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium text-blue-800 dark:text-blue-200">
                  {{ t('current-bundle') }}
                </div>
                <div class="text-sm text-blue-600 dark:text-blue-300">
                  {{ version.name }}
                </div>
              </div>
              <div class="text-xl text-blue-600 dark:text-blue-400">
                📦
              </div>
            </div>
          </div>

          <!-- Available Channels -->
          <div v-if="selectableChannels.length > 0" class="space-y-2">
            <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
              {{ t('available-channels') }}
            </h4>
            <div
              v-for="chan in selectableChannels"
              :key="chan.id"
              class="p-3 transition-colors border rounded-lg cursor-pointer"
              :class="{
                'border-blue-500 bg-blue-50 dark:bg-blue-900/20': selectedChannelForLink?.id === chan.id,
                'border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700': selectedChannelForLink?.id !== chan.id,
                'border-green-500 bg-green-50 dark:bg-green-900/20': version && chan.version === version.id,
              }"
              @click="selectedChannelForLink = chan"
            >
              <div class="flex items-center justify-between">
                <div>
                  <div class="flex items-center gap-2 font-medium">
                    {{ chan.name }}
                    <span v-if="version && chan.version === version.id" class="px-2 py-1 text-xs text-green-800 bg-green-100 rounded-full dark:text-green-200 dark:bg-green-800">
                      {{ t('current') }}
                    </span>
                  </div>
                  <div class="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {{ t('channel-id') }}: {{ chan.id }}
                    <span v-if="chan.public" class="ml-2 text-blue-600 dark:text-blue-400">• {{ t('public') }}</span>
                    <span v-else class="ml-2 text-gray-500 dark:text-gray-400">• {{ t('private') }}</span>
                  </div>
                  <div v-if="chan.ios || chan.android" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    <span v-if="chan.ios" class="mr-2">📱 iOS</span>
                    <span v-if="chan.android">🤖 Android</span>
                  </div>
                  <div v-if="chan.created_at" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {{ t('created') }}: {{ formatLocalDate(chan.created_at) }}
                  </div>
                </div>
                <div class="text-2xl">
                  <span v-if="selectedChannelForLink?.id === chan.id" class="text-blue-600 dark:text-blue-400">✓</span>
                  <span v-else-if="version && chan.version === version.id" class="text-green-600 dark:text-green-400">🔗</span>
                  <span v-else class="text-gray-300 dark:text-gray-600">○</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Empty states -->
          <div v-if="channels.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            <div class="mb-2 text-4xl">
              📱
            </div>
            <div class="font-medium">
              {{ t('no-channels-available') }}
            </div>
            <div class="mt-1 text-sm">
              {{ t('create-a-channel-first-to-link-bundles') }}
            </div>
          </div>

          <div v-else-if="filteredChannels.length === 0 && channelSearchVal.trim()" class="py-8 text-center text-gray-500 dark:text-gray-400">
            <div class="mb-2 text-4xl">
              🔍
            </div>
            <div class="font-medium">
              {{ t('no-channels-found') }}
            </div>
            <div class="mt-1 text-sm">
              {{ t('try-a-different-search-term') }}
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Teleport Content for Channel Actions (Settings) -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('channel-actions') && currentChannelAction === 'open'" defer to="#dialog-v2-content">
      <div class="w-full space-y-4">
        <div class="text-left">
          <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
            {{ t('select-action-for-channel', { channel: selectedChannelForLink?.name || '' }) }}
          </p>
        </div>

        <div class="space-y-3">
          <!-- Set Bundle (if user has permissions) -->
          <div
            v-if="canPromoteBundle"
            class="p-3 border border-gray-300 rounded-lg cursor-pointer dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
            @click="handleChannelAction('set')"
          >
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium">
                  {{ t('set-bundle') }}
                </div>
                <div class="text-sm text-gray-600 dark:text-gray-400">
                  {{ t('link-this-bundle-to-another-channel') }}
                </div>
              </div>
              <div class="text-green-600 dark:text-green-400">
                ⚡
              </div>
            </div>
          </div>

          <!-- Unlink Channel (if user has permissions) -->
          <div
            v-if="selectedChannelForLink && canPromoteChannel(selectedChannelForLink.id)"
            class="p-3 border border-red-300 rounded-lg cursor-pointer dark:border-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            @click="handleChannelAction('unlink')"
          >
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium text-red-600 dark:text-red-400">
                  {{ t('unlink-channel') }}
                </div>
                <div class="text-sm text-red-500 dark:text-red-300">
                  {{ t('remove-bundle-from-channel') }}
                </div>
              </div>
              <div class="text-red-600 dark:text-red-400">
                🔗⚡
              </div>
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
