<script setup lang="ts">
import type { TableColumn } from '../comp_def'
import type { Database } from '~/types/supabase.types'
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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
type PlatformOs = Database['public']['Enums']['platform_os']

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
const selectedPlatform = ref<'' | PlatformOs>('')
const selectedVersionName = ref(props.versionName ?? '')
const bundleNames = ref<string[]>([])
const skipFilterReload = ref(false)
const offset = 10
const activeExtraFilters = computed(() =>
  (selectedPlatform.value ? 1 : 0) + (selectedVersionName.value.trim() ? 1 : 0),
)
const platformOptions = computed(() => [
  { value: '' as const, label: t('all-platforms') },
  { value: 'ios' as const, label: t('platform-ios') },
  { value: 'android' as const, label: t('platform-android') },
  { value: 'electron' as const, label: t('platform-electron') },
])

function clearExtraFilters() {
  // Values only — DataTable clear emits a filters update that triggers the single reload.
  // Keep skipFilterReload true until the next tick so platform/bundle watchers do not
  // schedule a second reload in the same clear action.
  skipFilterReload.value = true
  selectedPlatform.value = ''
  selectedVersionName.value = ''
  nextTick(() => {
    skipFilterReload.value = false
  })
}
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

function getVersionNameFilter() {
  const selected = selectedVersionName.value.trim()
  return selected || undefined
}

function getPlatformFilter(): PlatformOs | undefined {
  return selectedPlatform.value || undefined
}

function getQuerySignature() {
  return JSON.stringify({
    appId: props.appId,
    versionName: getVersionNameFilter(),
    platform: getPlatformFilter() ?? '',
    search: getSearchTerm(),
    order: getActiveOrder(columns.value),
    override: filters.value.Override,
    customIdMode: filters.value.CustomId,
    ids: props.ids ? [...props.ids].sort().join(',') : '',
  })
}

async function loadBundleNames() {
  const appId = props.appId
  if (!appId)
    return

  const { data, error } = await supabase
    .from('app_versions')
    .select('name')
    .eq('app_id', appId)
    .eq('deleted', false)
    .order('created_at', { ascending: false })
    .limit(200)

  // Ignore stale responses if the user switched apps while the query was in flight.
  if (appId !== props.appId)
    return

  if (error || !data) {
    bundleNames.value = []
    return
  }

  const names = [...new Set(data.map(row => row.name).filter(Boolean))]
  const selected = getVersionNameFilter()
  if (selected && !names.includes(selected))
    names.unshift(selected)
  bundleNames.value = names
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
        versionName: getVersionNameFilter(),
        platform: getPlatformFilter(),
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

let reloadTimer: ReturnType<typeof setTimeout> | undefined

function cancelScheduledReload() {
  if (!reloadTimer)
    return
  clearTimeout(reloadTimer)
  reloadTimer = undefined
}

function debouncedReload() {
  cancelScheduledReload()
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined
    reload()
  }, 300)
}

onUnmounted(() => {
  cancelScheduledReload()
})

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
      versionName: getVersionNameFilter(),
      platform: getPlatformFilter(),
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

onMounted(async () => {
  await loadBundleNames()
})

watch(() => props.appId, async (appId) => {
  cancelScheduledReload()
  // Invalidate in-flight reloads from the previous app before awaiting.
  activeLoadId.value += 1
  skipFilterReload.value = true
  selectedPlatform.value = ''
  selectedVersionName.value = props.versionName ?? ''
  await loadBundleNames()
  if (appId !== props.appId)
    return
  skipFilterReload.value = false
  await refreshData()
})

watch(() => props.versionName, (value) => {
  cancelScheduledReload()
  skipFilterReload.value = true
  selectedVersionName.value = value ?? ''
  skipFilterReload.value = false
  debouncedReload()
})

watch([selectedPlatform, selectedVersionName], () => {
  if (skipFilterReload.value)
    return
  debouncedReload()
})
</script>

<template>
  <DataTable
    v-model:filters="filters" v-model:columns="columns" v-model:current-page="currentPage" v-model:search="search"
    :total="total" :offset="offset" :element-list="elements"
    filter-text="Filters"
    :extra-filter-count="activeExtraFilters"
    :show-add="showAddButton"
    :is-loading="isLoading"
    :search-placeholder="t('search-by-device-id')"
    @add="handleAddDevice"
    @reload="reload()"
    @reset="refreshData()"
    @clear-extra-filters="clearExtraFilters"
  >
    <template #filter-extras>
      <fieldset>
        <legend class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {{ t('platform') }}
        </legend>
        <div
          id="device-table-platform-filter"
          class="grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="group"
          :aria-label="t('platform')"
          data-test="device-platform-filter"
        >
          <button
            v-for="option in platformOptions"
            :key="option.value || 'all'"
            type="button"
            class="min-h-11 rounded-md border px-2 text-sm font-medium transition-colors duration-150 focus:outline-hidden focus:ring-2 focus:ring-azure-500"
            :class="selectedPlatform === option.value
              ? 'border-azure-500 bg-azure-500/10 text-azure-700 dark:border-azure-400 dark:bg-azure-400/10 dark:text-azure-200'
              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800'"
            :aria-pressed="selectedPlatform === option.value"
            :data-test="`device-platform-${option.value || 'all'}`"
            @click="selectedPlatform = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </fieldset>
      <div class="flex w-full flex-col gap-2">
        <label for="device-table-bundle-filter" class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {{ t('bundle') }}
        </label>
        <input
          id="device-table-bundle-filter"
          v-model="selectedVersionName"
          list="device-table-bundle-options"
          type="text"
          class="d-input d-input-bordered min-h-11 w-full border-slate-200 bg-white text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          :placeholder="t('all-bundles')"
          :aria-label="t('bundle')"
          data-test="device-bundle-filter"
          autocomplete="off"
        >
        <datalist id="device-table-bundle-options">
          <option
            v-for="name in bundleNames"
            :key="name"
            :value="name"
          />
        </datalist>
      </div>
    </template>
  </DataTable>
</template>
