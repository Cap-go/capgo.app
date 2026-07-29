<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import type { LinkedChannel } from '~/services/bundleLinkedChannels'
import type { ChannelPromotionTarget } from '~/services/channelPromotion'
import type { Database } from '~/types/supabase.types'
import { Capacitor } from '@capacitor/core'
import { computedAsync } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconSettings from '~icons/heroicons/cog-8-tooth'
import IconTrash from '~icons/heroicons/trash'
import { fetchLinkedChannelsForVersion, formatLinkedChannel, unlinkLinkedChannels } from '~/services/bundleLinkedChannels'
import { findChannelsWithoutPromotionPermission, formatChannelPromotionTargets } from '~/services/channelPromotion'
import { formatBytes } from '~/services/conversion'
import { formatDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'

const props = defineProps<{
  appId: string
}>()

type Element = Database['public']['Tables']['app_versions']['Row'] & Database['public']['Tables']['app_versions_meta']['Row']

const canDeleteBundle = computedAsync(async () => {
  if (!props.appId)
    return false
  return await checkPermissions('bundle.delete', { appId: props.appId })
}, false)

const isMobile = Capacitor.isNativePlatform()
const offset = 10
const { t } = useI18n()
const dialogStore = useDialogV2Store()
const supabase = useSupabase()
const router = useRouter()
const total = ref(0)
const totalAllBundles = ref<number | null>(null)
const search = ref('')
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const elements = ref<Element[]>([])
const selectedElements = ref<Element[]>([])
const isLoading = ref(true)
const currentPage = ref(1)
const filters = ref({
  'external-storage': false,
  'deleted': false,
  'encrypted': false,
})
const channelCache = ref<Record<number, { name: string, id?: number }>>({})

const currentVersionsNumber = computed(() => {
  return (currentPage.value - 1) * offset
})

type DeletionMethod = 'normal' | 'unsafe' | null

async function showDeletionMethodDialog(): Promise<DeletionMethod> {
  let method: DeletionMethod = null

  dialogStore.openDialog({
    title: t('select-style-of-deletion'),
    description: t('select-style-of-deletion-msg'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
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

  const cancelled = await dialogStore.onDialogDismiss()
  return cancelled ? null : method
}

async function showDeleteConfirmationDialog(name: string, isPlural = false, askForMethod = true, _method: 'normal' | 'unsafe' = 'unsafe'): Promise<boolean> {
  let message: string

  if (isPlural) {
    message = `${t('alert-not-reverse-message')} ${t('alert-delete-message-plural')} ${t('bundles').toLowerCase()}?`
  }
  else if (askForMethod) {
    message = `${t('alert-not-reverse-message')} ${t('alert-delete-message')} ${name} ${t('you-cannot-reuse')}.`
  }
  else {
    const baseMessage = `${t('alert-not-reverse-message')} ${t('alert-delete-message')} ${name}?`
    const unsafeWarning = isPlural
      ? t('you-are-deleting-unsafely-plural')
      : t('you-are-deleting-unsafely')
    const formattedWarning = unsafeWarning
      .replace('$1', '<b><u>')
      .replace('$2', '</u></b>')
      .replace('$3', '<a href="https://capgo.app/docs/webapp/bundles/#delete-a-bundle">')
      .replace('$4', '</a>')
    message = `${baseMessage}\n${formattedWarning}.`
  }

  dialogStore.openDialog({
    title: t('alert-confirm-delete'),
    description: message,
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

  return !await dialogStore.onDialogDismiss()
}

async function didCancel(name: string, isPlural = false, askForMethod = true): Promise<boolean | 'normal' | 'unsafe'> {
  let method: 'normal' | 'unsafe' | null = null

  if (askForMethod) {
    method = await showDeletionMethodDialog()
    if (!method)
      return true // User cancelled
  }
  else {
    method = 'unsafe'
  }

  const confirmed = await showDeleteConfirmationDialog(name, isPlural, askForMethod, method)
  if (!confirmed)
    return true // User cancelled

  return method
}

async function showUnlinkDialog(message: string): Promise<boolean> {
  let shouldUnlink = false

  dialogStore.openDialog({
    title: t('want-to-unlink'),
    description: message,
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
        },
      },
    ],
  })

  const cancelled = await dialogStore.onDialogDismiss()
  return !cancelled && shouldUnlink
}

function showChannelUnlinkPermissionError(deniedChannels: ChannelPromotionTarget[]) {
  toast.error(t('channel-permission-unlink-required', {
    channels: formatChannelPromotionTargets(deniedChannels),
  }))
}

async function enhanceVersionElems(dataVersions: Database['public']['Tables']['app_versions']['Row'][]) {
  const { data: dataVersionsMeta } = await supabase
    .from('app_versions_meta')
    .select()
    .in('id', dataVersions.map(({ id }) => id))
  const newVersions = dataVersions.map(({ id, ...rest }) => {
    const version = dataVersionsMeta ? dataVersionsMeta.find(({ id: idMeta }) => idMeta === id) : { size: 0, checksum: '' }
    return { id, ...rest, ...version } as Element
  })
  return newVersions
}

async function getData() {
  isLoading.value = true
  try {
    let channelsToSearch = null

    // If search term might be a channel name, find versions linked to channels with that name
    if (search.value) {
      const { data: channels } = await supabase
        .from('channels')
        .select('id, version')
        .eq('app_id', props.appId)
        .ilike('name', `%${search.value}%`)

      if (channels && channels.length > 0) {
        channelsToSearch = channels.map(c => c.version)
      }
    }

    let req = supabase
      .from('app_versions')
      .select('*', { count: 'exact' })
      .eq('app_id', props.appId)
      .neq('storage_provider', 'revert_to_builtin')
      .range(currentVersionsNumber.value, currentVersionsNumber.value + offset - 1)

    if (search.value) {
      if (channelsToSearch && channelsToSearch.length > 0) {
        // Search by both version name or linked channel
        req = req.or(`name.ilike.%${search.value}%,id.in.(${channelsToSearch.join(',')})`)
      }
      else {
        // Search by version name only
        req = req.like('name', `%${search.value}%`)
      }
    }

    req = req.eq('deleted', filters.value.deleted)
    if (filters.value['external-storage'])
      req = req.neq('external_url', null)
    if (filters.value.encrypted)
      req = req.neq('session_key', null)
    if (columns.value.length) {
      columns.value.forEach((col) => {
        if (col.sortable && typeof col.sortable === 'string')
          req = req.order(col.key as any, { ascending: col.sortable === 'asc' })
      })
    }
    const { data: dataVersions, count } = await req
    if (!dataVersions)
      return
    total.value = count ?? 0
    const maxPage = Math.max(1, Math.ceil(total.value / offset))
    if (currentPage.value > maxPage) {
      currentPage.value = maxPage
      // Re-fetch the clamped page so pagination stays aligned with the new total
      // (e.g. after deletes shrink the last page away).
      return getData()
    }
    const enhancedVersions = await enhanceVersionElems(dataVersions)
    await fetchChannelsForVersions(enhancedVersions)
    elements.value = enhancedVersions as any
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}

async function fetchChannelsForVersions(versions: Element[]) {
  const versionIds = versions.map(v => v.id)
  if (versionIds.length === 0)
    return

  const [stableResult, rolloutResult] = await Promise.all([
    supabase
      .from('channels')
      .select('name, version, rollout_version, id')
      .eq('app_id', props.appId)
      .in('version', versionIds),
    supabase
      .from('channels')
      .select('name, version, rollout_version, id')
      .eq('app_id', props.appId)
      .in('rollout_version', versionIds),
  ])
  const error = stableResult.error ?? rolloutResult.error
  if (error) {
    console.error('Error fetching channels:', error)
    return
  }
  const channelData = [...(stableResult.data ?? []), ...(rolloutResult.data ?? [])]
  versionIds.forEach((id) => {
    const channel = channelData?.find(c => c.version === id || c.rollout_version === id)
    channelCache.value[id] = channel ? { name: channel.name, id: channel.id } : { name: '' }
  })
}

async function refreshData() {
  isLoading.value = true
  try {
    currentPage.value = 1
    elements.value.length = 0
    selectedElements.value.length = 0
    channelCache.value = {} // Clear cache on refresh
    await Promise.all([getData(), updateOverallBundlesCount()])
  }
  catch (error) {
    console.error(error)
  }
  finally {
    // getData normally resets this, but guard against early failures
    isLoading.value = false
  }
}

async function unlinkChannels(_appId: string, unlink: LinkedChannel[]) {
  const updateError = await unlinkLinkedChannels(unlink)
  if (updateError) {
    toast.error(t('unlink-error'))
    console.error('unlink error (updateError)', updateError)
    return Promise.reject(new Error('Unlink error'))
  }
}

async function deleteOne(one: Element) {
  try {
    // Check for linked channels
    const { data: channelFound, error: errorChannel } = await fetchLinkedChannelsForVersion(one.app_id, one.id)

    let unlink = [] as LinkedChannel[]
    if (errorChannel) {
      console.error('Error checking channels:', errorChannel)
      toast.error(t('error-checking-channels'))
      return
    }

    if (channelFound && channelFound.length > 0) {
      const linkedChannels = channelFound as LinkedChannel[]
      const deniedChannels = await findChannelsWithoutPromotionPermission(one.app_id, linkedChannels)
      if (deniedChannels.length > 0) {
        showChannelUnlinkPermissionError(deniedChannels)
        return
      }

      const channelsList = linkedChannels.map(formatLinkedChannel).join(', ')
      const message = t('channel-bundle-linked', { channels: channelsList })
      const shouldUnlink = await showUnlinkDialog(message)

      if (!shouldUnlink) {
        toast.error(t('canceled-delete'))
        return
      }

      unlink = linkedChannels
    }

    if (one.name === 'unknown' || one.name === 'builtin') {
      return
    }

    const didCancelRes = await didCancel(t('version'), false, !one.deleted)
    if (typeof didCancelRes === 'boolean' && didCancelRes === true)
      return

    try {
      await unlinkChannels(one.app_id, unlink)
    }
    catch {
      return
    }

    const { error: delAppError } = await (didCancelRes === 'normal'
      ? supabase
          .from('app_versions')
          .update({ deleted: true })
          .eq('app_id', one.app_id)
          .eq('id', one.id)
      : supabase
          .from('app_versions')
          .delete()
          .eq('app_id', one.app_id)
          .eq('id', one.id)
    )

    if (delAppError) {
      toast.error(t('cannot-delete-bundle'))
      return
    }
    toast.success(t('bundle-deleted'))
    await refreshData()
  }
  catch (error) {
    console.error(error)
    toast.error(t('cannot-delete-bundle'))
  }
}

columns.value = [
  {
    label: t('name'),
    key: 'name',
    mobile: true,
    sortable: true,
    head: true,
    onClick: (elem: Element) => openOne(elem),
  },
  {
    label: t('created-at'),
    key: 'created_at',
    mobile: true,
    sortable: 'desc',
    displayFunction: (elem: Element) => formatDate(elem.created_at ?? ''),
  },
  {
    label: t('channel'),
    key: 'channel',
    mobile: false,
    sortable: false,
    displayFunction: (elem: Element) => {
      if (elem.deleted)
        return t('deleted')
      return channelCache.value[elem.id]?.name ?? ''
    },
    onClick: async (elem: Element) => {
      if (elem.deleted || !channelCache.value[elem.id] || !channelCache.value[elem.id].id)
        return
      router.push(`/app/${props.appId}/channel/${channelCache.value[elem.id].id}`)
    },
  },
  {
    label: t('size'),
    mobile: false,
    key: 'size',
    sortable: true,
    displayFunction: (elem: Element) => {
      if (elem.size)
        return formatBytes(elem.size)
      else if (elem.external_url)
        return t('stored-externally')
      else if (elem.deleted)
        return t('deleted')
      else
        return t('size-not-found')
    },
  },
  {
    key: 'actions',
    label: t('action'),
    mobile: true,
    actions: [
      {
        icon: IconSettings,
        onClick: (elem: Element) => openOne(elem),
      },
      {
        icon: IconTrash,
        visible: () => canDeleteBundle.value,
        onClick: (elem: Element) => deleteOne(elem),
      },
    ],
  },
]

async function reload() {
  isLoading.value = true
  elements.value.length = 0
  try {
    await Promise.all([getData(), updateOverallBundlesCount()])
  }
  catch (error) {
    console.error(error)
  }
  finally {
    // getData normally resets this, but guard against early failures
    isLoading.value = false
  }
}

async function massDelete() {
  console.log('massDelete')
  if (!canDeleteBundle.value) {
    toast.error(t('no-permission'))
    return
  }

  if (selectedElements.value.length > 0 && !!(selectedElements.value as any).find((val: Element) => val.name === 'unknown' || val.name === 'builtin')) {
    toast.error(t('cannot-delete-unknown-or-builtin'))
    return
  }

  const didCancelRes = await didCancel(t('version'), true, !filters.value.deleted)
  if (typeof didCancelRes === 'boolean' && didCancelRes === true)
    return

  const linkedChannels = (await Promise.all((selectedElements.value as any).map(async (element: Element) => {
    return {
      data: await fetchLinkedChannelsForVersion(element.app_id, element.id),
      element,
    }
  }))).map(({ data: { data, error }, element }) => {
    if (error) {
      throw new Error('Cannot find channel')
    }
    return {
      element,
      channelFound: (data?.length ?? 0) > 0,
      rawChannel: data,
    }
  })
  const linkedChannelsList = linkedChannels.filter(({ channelFound }) => channelFound)
  let unlink = [] as LinkedChannel[]

  if (linkedChannelsList.length > 0) {
    const selectedVersionIds = new Set((selectedElements.value as any).map((val: Element) => val.id))
    unlink = linkedChannelsList.flatMap(val => ((val.rawChannel ?? []) as LinkedChannel[]).map(channel => ({
      ...channel,
      stable_linked: selectedVersionIds.has(channel.version),
      rollout_linked: selectedVersionIds.has(channel.rollout_version),
    })))
    const deniedChannels = await findChannelsWithoutPromotionPermission(props.appId, unlink)
    if (deniedChannels.length > 0) {
      showChannelUnlinkPermissionError(deniedChannels)
      return
    }

    const channelsList = linkedChannelsList
      .map(val => val.rawChannel?.map((ch: LinkedChannel) => formatLinkedChannel(ch)).join(', '))
      .join(', ')
    const message = t('channel-bundle-linked', { channels: channelsList })
    const shouldUnlink = await showUnlinkDialog(message)

    if (!shouldUnlink) {
      toast.error(t('canceled-delete'))
      return
    }
  }

  try {
    await unlinkChannels(props.appId, unlink)
  }
  catch {
    return
  }

  const { error: delAppError } = await (didCancelRes === 'normal'
    ? supabase
        .from('app_versions')
        .update({ deleted: true })
        .eq('app_id', props.appId)
        .in('id', (selectedElements.value as any).map((val: Element) => val.id))
    : supabase
        .from('app_versions')
        .delete()
        .eq('app_id', props.appId)
        .in('id', (selectedElements.value as any).map((val: Element) => val.id))
  )

  if (delAppError) {
    toast.error(t('cannot-delete-bundles'))
  }
  else {
    toast.success(t('bundles-deleted'))
    await refreshData()
  }
}

function selectedElementsFilter(val: boolean[]) {
  console.log('selectedElementsFilter', val)
  selectedElements.value = (elements.value as any).filter((_: any, i: number) => val[i])
}

async function addOne() {
  router.push(`/app/${encodeURIComponent(props.appId)}/bundles/new`)
}

async function openOne(one: Element) {
  if (one.deleted)
    return
  router.push(`/app/${props.appId}/bundle/${one.id}`)
}

async function updateOverallBundlesCount() {
  try {
    const { count } = await supabase
      .from('app_versions')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', props.appId)
      .eq('deleted', false)
      .neq('storage_provider', 'revert_to_builtin')
    totalAllBundles.value = count ?? 0
  }
  catch (error) {
    console.error(error)
  }
}

watch(props, async () => {
  await refreshData()
})
</script>

<template>
  <div>
    <div
      v-if="totalAllBundles !== null && totalAllBundles === 0 && !search"
      class="p-6 mb-6 bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900"
    >
      <h2 class="text-xl font-semibold text-slate-900 dark:text-slate-50">
        {{ t('feel-magic-of-capgo') }} <span class="font-prompt">Capgo</span> !
      </h2>
      <p class="mt-2 text-slate-600 dark:text-slate-200">
        {{ t('add-your-first-bundle') }}
      </p>
      <button class="mt-4 d-btn d-btn-primary" @click="addOne()">
        {{ t('add-another-bundle') }}
      </button>
    </div>

    <div class="flex overflow-hidden overflow-y-auto flex-col bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <DataTable
        v-model:filters="filters" v-model:columns="columns" v-model:current-page="currentPage" v-model:search="search"
        :total="total"
        :offset="offset"
        :show-add="!isMobile"
        :element-list="elements"
        filter-text="Filters"
        mass-select
        :is-loading="isLoading"
        :search-placeholder="t('search-by-name')"
        @select-row="selectedElementsFilter"
        @mass-delete="massDelete()"
        @add="addOne()"
        @reload="reload()"
        @reset="refreshData()"
      />
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
  </div>
</template>
