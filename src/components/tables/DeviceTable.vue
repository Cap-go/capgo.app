<script setup lang="ts">
import type { TableColumn } from '../comp_def'
import type { Database } from '~/types/supabase.types'
import { h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { formatDate } from '~/services/date'
import { defaultApiHost, useSupabase } from '~/services/supabase'

const props = defineProps<{
  appId: string
  ids?: string[]
  versionName?: string | undefined
  showAddButton?: boolean
  channel?: unknown
}>()

const emit = defineEmits(['addDevice'])

// TODO: delete the old version check when all devices uses the new version system
type Device = Database['public']['Tables']['devices']['Row']

const { t } = useI18n()
const supabase = useSupabase()
const router = useRouter()
const total = ref(0)
const search = ref('')
const elements = ref<Device[]>([])
const isLoading = ref(true)
const currentPage = ref(1)
const nextCursor = ref<string | undefined>(undefined)
const hasMore = ref(false)
const pageStartCursor = ref<Map<number, string | null | undefined>>(new Map([[1, undefined]]))
const activeLoadId = ref(0)
const lastQuerySignature = ref('')
const filters = ref({
  Override: false,
  CustomId: false,
})
const offset = 10
const columns = ref<TableColumn[]>([
  {
    label: t('device-id'),
    key: 'device_id',
    class: 'truncate max-w-10',
    mobile: true,
    head: true,
    sortable: false,
    onClick: (elem: Device) => openOne(elem),
    renderFunction: (item) => {
      const customId = item.custom_id?.trim()
      return h('div', { class: 'flex flex-col text-slate-800 dark:text-white' }, [
        h('div', { class: 'truncate font-medium' }, customId || item.device_id),
        customId
          ? h('div', { class: 'text-xs text-slate-500 dark:text-gray-400 truncate' }, item.device_id)
          : null,
      ])
    },
  },
  {
    label: t('updated-at'),
    key: 'updated_at',
    mobile: false,
    sortable: 'desc',
    displayFunction: (elem: Device) => formatDate(elem.updated_at ?? ''),
  },
  {
    label: t('platform'),
    key: 'platform',
    mobile: true,
    head: true,
    sortable: false,
    displayFunction: (elem: Device) => `${elem.platform} ${elem.os_version}`,
  },
  {
    label: t('bundle'),
    key: 'version_name',
    mobile: true,
    head: true,
    sortable: false,
    displayFunction: (elem: Device) => elem.version_name ?? elem.version ?? 'unknown',
    onClick: (elem: Device) => openOneVersion(elem),
  },
])

function getActiveOrder(columns: TableColumn[]) {
  return columns
    .filter(col => typeof col.sortable === 'string')
    .map(col => ({ key: col.key, sortable: col.sortable }))
}

function getSearchTerm() {
  const trimmed = search.value.trim()
  return trimmed.length ? trimmed : undefined
}

function getQuerySignature() {
  return JSON.stringify({
    appId: props.appId,
    versionName: props.versionName,
    search: getSearchTerm(),
    order: getActiveOrder(columns.value),
    override: filters.value.Override,
    customIdMode: filters.value.CustomId,
    ids: props.ids ? [...props.ids].sort().join(',') : '',
  })
}

async function getDevicesID() {
  let req = supabase
    .from('channel_devices')
    .select('device_id')
    .eq('app_id', props.appId)

  if (props.ids)
    req = req.in('device_id', props.ids)

  const { data } = await req

  const channelDev = data?.map(d => d.device_id) ?? []
  return [...channelDev]
}

async function resolveDeviceIds() {
  if (filters.value.Override)
    return await getDevicesID()
  if (props.ids)
    return props.ids
  return []
}

async function countDevices() {
  const { data: currentSession } = await supabase.auth.getSession()!
  if (!currentSession.session)
    return 0

  const currentJwt = currentSession.session.access_token
  const deviceIds = await resolveDeviceIds()
  const searchTerm = getSearchTerm()

  try {
    const response = await fetch(`${defaultApiHost}/private/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${currentJwt ?? ''}`,
      },
      body: JSON.stringify({
        count: true,
        appId: props.appId,
        versionName: props.versionName,
        devicesId: deviceIds.length > 0 ? deviceIds : undefined,
        search: searchTerm,
        order: getActiveOrder(columns.value),
        customIdMode: filters.value.CustomId,
      }),
    })

    if (!response.ok) {
      console.log('Cannot get devices', response.status)
      return 0
    }

    const dataD = await response.json() as { count: number }
    return dataD.count
  }
  catch (err) {
    console.log('Cannot get devices', err)
    return 0
  }
}

interface DevicesResponse {
  data: Device[]
  nextCursor?: string
  hasMore: boolean
}

function clearPaginationState() {
  pageStartCursor.value = new Map([[1, undefined]])
  nextCursor.value = undefined
  hasMore.value = false
}

async function reload() {
  const loadId = ++activeLoadId.value
  isLoading.value = true
  try {
    const querySignature = getQuerySignature()
    if (lastQuerySignature.value !== querySignature) {
      lastQuerySignature.value = querySignature
      currentPage.value = 1
      clearPaginationState()
      elements.value.length = 0
    }

    const newTotal = await countDevices()
    if (loadId !== activeLoadId.value)
      return

    total.value = newTotal
    await getData(loadId)
  }
  catch (error) {
    console.error(error)
  }
  finally {
    if (loadId === activeLoadId.value)
      isLoading.value = false
  }
}

async function refreshData() {
  const loadId = ++activeLoadId.value
  isLoading.value = true
  try {
    currentPage.value = 1
    lastQuerySignature.value = getQuerySignature()
    clearPaginationState()
    elements.value.length = 0
    const newTotal = await countDevices()
    if (loadId !== activeLoadId.value)
      return

    total.value = newTotal
    await getData(loadId)
  }
  catch (error) {
    console.error(error)
  }
  finally {
    if (loadId === activeLoadId.value)
      isLoading.value = false
  }
}

async function fetchDevicesPage(cursor: string | undefined | null) {
  const ids = await resolveDeviceIds()
  const searchTerm = getSearchTerm()

  const { data: currentSession } = await supabase.auth.getSession()!
  if (!currentSession.session)
    return
  const currentJwt = currentSession.session.access_token

  const response = await fetch(`${defaultApiHost}/private/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${currentJwt ?? ''}`,
    },
    body: JSON.stringify({
      appId: props.appId,
      versionName: props.versionName,
      devicesId: ids.length ? ids : undefined,
      search: searchTerm,
      order: getActiveOrder(columns.value),
      cursor: cursor ?? undefined,
      limit: offset,
      customIdMode: filters.value.CustomId,
    }),
  })

  if (!response.ok) {
    console.log('Cannot get devices', response.status)
    return
  }

  return await response.json() as DevicesResponse
}

async function getCursorForPageWithLoadId(page: number, loadId: number) {
  const target = Math.max(1, page)
  if (pageStartCursor.value.has(target))
    return pageStartCursor.value.get(target)

  while (!pageStartCursor.value.has(target)) {
    const knownPages = Array.from(pageStartCursor.value.keys())
    const lastKnownPage = Math.max(...knownPages)
    const cursor = pageStartCursor.value.get(lastKnownPage)
    if (cursor === null)
      return null
    const data = await fetchDevicesPage(cursor)
    if (loadId !== activeLoadId.value)
      return undefined
    if (!data)
      throw new Error(`Failed to resolve cursor for page ${lastKnownPage + 1}`)
    if (loadId === activeLoadId.value)
      pageStartCursor.value.set(lastKnownPage + 1, data.nextCursor ?? null)
  }

  return pageStartCursor.value.get(target)
}

async function getData(loadId: number) {
  try {
    const requestedPage = Math.max(1, currentPage.value)
    const maxPage = Math.max(1, Math.ceil(total.value / offset))
    const targetPage = Math.min(requestedPage, maxPage)

    if (targetPage !== requestedPage) {
      currentPage.value = targetPage
    }

    const cursor = await getCursorForPageWithLoadId(targetPage, loadId)

    if (loadId !== activeLoadId.value)
      return

    if (!cursor && targetPage > 1) {
      elements.value = []
      hasMore.value = false
      nextCursor.value = undefined
      return
    }

    const dataD = await fetchDevicesPage(cursor)
    if (!dataD) {
      throw new Error('Failed to fetch devices page')
    }
    if (loadId !== activeLoadId.value)
      return

    await ensureVersionNames(dataD.data)
    if (loadId !== activeLoadId.value)
      return

    elements.value = dataD.data
    pageStartCursor.value.set(targetPage + 1, dataD.nextCursor ?? null)
    nextCursor.value = dataD.nextCursor
    hasMore.value = dataD.hasMore
  }
  catch (error) {
    console.error(error)
    if (loadId === activeLoadId.value) {
      elements.value = []
      hasMore.value = false
      nextCursor.value = undefined
    }
  }
}

async function openOne(one: Device) {
  router.push(`/app/${props.appId}/device/${one.device_id}`)
}
async function openOneVersion(one: Device) {
  if (!props.appId) {
    toast.error(t('app-id-missing'))
    return
  }

  if (one.version) {
    router.push(`/app/${props.appId}/bundle/${one.version}`)
    return
  }

  const loadingToastId = toast.loading(t('loading-version'))
  const { data: versionRecord, error } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', props.appId)
    .eq('name', one.version_name)
    .single()
  toast.dismiss(loadingToastId)
  if (error || !versionRecord?.id) {
    toast.error(t('cannot-find-version'))
    return
  }
  router.push(`/app/${props.appId}/bundle/${versionRecord.id}`)
}

function handleAddDevice() {
  emit('addDevice')
}

// TODO: delete the old version check when all devices uses the new version system
async function ensureVersionNames(devices: Device[]) {
  const missingName = devices.filter(device => (!device.version_name || device.version_name === '') && typeof device.version === 'number')
  if (!missingName.length)
    return

  const versionIds = [...new Set(missingName.map(device => device.version as number))]
  if (!versionIds.length)
    return

  const { data: versionRecords, error } = await supabase
    .from('app_versions')
    .select('id, name')
    .in('id', versionIds)

  if (error || !versionRecords?.length)
    return

  const versionMap = versionRecords.reduce<Record<number, string>>((acc, record) => {
    acc[record.id] = record.name
    return acc
  }, {})

  missingName.forEach((device) => {
    const id = typeof device.version === 'number' ? device.version : null
    if (id && versionMap[id])
      device.version_name = versionMap[id]
  })
}
</script>

<template>
  <div>
    <DataTable
      v-model:filters="filters" v-model:columns="columns" v-model:current-page="currentPage" v-model:search="search"
      :total="total" :offset="offset" :element-list="elements"
      filter-text="Filters"
      :show-add="showAddButton"
      :is-loading="isLoading"
      :search-placeholder="t('search-by-device-id')"
      @add="handleAddDevice"
      @reload="reload()"
      @reset="refreshData()"
    />
  </div>
</template>
