<script setup lang="ts">
import type { TableColumn } from '../comp_def'
import type { DateRangePreset } from '~/services/dateRange'
import type { Database } from '~/types/supabase.types'
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconInfo from '~icons/lucide/info'
import IconSmartphone from '~icons/lucide/smartphone'
import DateRangePicker from '~/components/DateRangePicker.vue'
import { formatDate } from '~/services/date'
import {
  DATE_RANGE_PRESET_LABEL_KEYS,
  getDateRangeForPreset,
  getTableDateRangeSignature,
  shouldRecountOnTableReload,
  TABLE_DATE_RANGE_DEFAULT,
} from '~/services/dateRange'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import BundleMultiFilter from './BundleMultiFilter.vue'

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
interface DateRangePickerHandle {
  openPicker: (invoker?: HTMLElement) => Promise<void>
  togglePicker: (invoker?: HTMLElement) => void
}

const { t } = useI18n()
const supabase = useSupabase()
const router = useRouter()
const total = ref(0)
const unfilteredTotal = ref<number | null>(null)
const search = ref('')
const elements = ref<Device[]>([])
const isLoading = ref(true)
const currentPage = ref(1)
const previousPage = ref(1)
const nextCursor = ref<string | undefined>(undefined)
const hasMore = ref(false)
const pageStartCursor = ref<Map<number, string | null | undefined>>(new Map([[1, undefined]]))
const activeLoadId = ref(0)
const lastQuerySignature = ref('')
const filters = ref({
  Override: false,
  CustomId: false,
})
const initialRange = getDateRangeForPreset(TABLE_DATE_RANGE_DEFAULT)
const dateRange = ref<[Date, Date] | null>([initialRange.start, initialRange.end])
const dateRangeMode = ref<DateRangePreset>(TABLE_DATE_RANGE_DEFAULT)
const selectedPlatform = ref<'' | PlatformOs>('')
const selectedVersionNames = ref<string[]>(props.versionName ? [props.versionName] : [])
const bundleNames = ref<string[]>([])
const dateRangePickerRef = ref<DateRangePickerHandle>()
const skipFilterReload = ref(false)
const offset = 10
const activeExtraFilters = computed(() =>
  (selectedPlatform.value ? 1 : 0) + (selectedVersionNames.value.length ? 1 : 0),
)
const platformOptions = computed(() => [
  { value: '' as const, label: t('all-platforms') },
  { value: 'ios' as const, label: t('platform-ios') },
  { value: 'android' as const, label: t('platform-android') },
  { value: 'electron' as const, label: t('platform-electron') },
])
const dateRangeLabel = computed(() => {
  const mode = dateRangeMode.value
  if (mode === 'custom')
    return t('date-range')
  return t(DATE_RANGE_PRESET_LABEL_KEYS[mode])
})
const showRangeFilterBanner = computed(() => unfilteredTotal.value !== null && unfilteredTotal.value > 0)

function clearExtraFilters() {
  // Values only — DataTable clear emits a filters update that triggers the single reload.
  // Keep skipFilterReload true until the next tick so platform/bundle watchers do not
  // schedule a second reload in the same clear action.
  skipFilterReload.value = true
  selectedPlatform.value = ''
  selectedVersionNames.value = []
  nextTick(() => {
    skipFilterReload.value = false
  })
}

function openDateRangePicker(event: MouseEvent) {
  dateRangePickerRef.value?.togglePicker(event.currentTarget as HTMLElement)
}

function onDateRangeApply(payload: { start: Date, end: Date, mode: DateRangePreset }) {
  // Apply payload first so refresh does not race v-model flush and keep the old window.
  dateRangeMode.value = payload.mode
  dateRange.value = [payload.start, payload.end]
  void refreshData()
}

function clearDeviceViewFilters(clearFilters: () => void) {
  cancelScheduledReload()
  clearFilters()
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

function getDateRangePayload() {
  // Always use the frozen session bounds. Recomputing rolling presets from
  // `now` on each page fetch desyncs API filters from cached cursors.
  if (!dateRange.value)
    return {}
  return {
    updated_at_gt: dateRange.value[0].toISOString(),
    updated_at_lte: dateRange.value[1].toISOString(),
  }
}

function snapRollingDateRangeBounds() {
  if (dateRangeMode.value === 'custom')
    return
  const rolling = getDateRangeForPreset(dateRangeMode.value)
  dateRange.value = [rolling.start, rolling.end]
}

function getVersionNameFilter(): string[] | undefined {
  return selectedVersionNames.value.length ? [...selectedVersionNames.value] : undefined
}

function getPlatformFilter(): PlatformOs | undefined {
  return selectedPlatform.value || undefined
}

function getQuerySignature() {
  return JSON.stringify({
    appId: props.appId,
    versionNames: getVersionNameFilter() ?? [],
    platform: getPlatformFilter() ?? '',
    search: getSearchTerm(),
    order: getActiveOrder(columns.value),
    override: filters.value.Override,
    customIdMode: filters.value.CustomId,
    ids: props.ids ? [...props.ids].sort().join(',') : '',
    // Stable mode identity — not rolling ISO bounds that move every millisecond.
    dateRange: getTableDateRangeSignature(dateRangeMode.value, dateRange.value),
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
  const selected = getVersionNameFilter() ?? []
  for (const name of selected) {
    if (!names.includes(name))
      names.unshift(name)
  }
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

async function countDevices(options?: { includeDateRange?: boolean }) {
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
        versionNames: getVersionNameFilter(),
        platform: getPlatformFilter(),
        devicesId: deviceIds.length > 0 ? deviceIds : undefined,
        search: searchTerm,
        order: getActiveOrder(columns.value),
        customIdMode: filters.value.CustomId,
        ...(options?.includeDateRange === false ? {} : getDateRangePayload()),
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

async function recountDevices(loadId: number) {
  const [filteredCount, allCount] = await Promise.all([
    countDevices(),
    countDevices({ includeDateRange: false }),
  ])
  if (loadId !== activeLoadId.value)
    return false
  total.value = filteredCount
  unfilteredTotal.value = allCount
  return true
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

function resetTablePagination(options: { snapRolling?: boolean } = {}) {
  if (options.snapRolling)
    snapRollingDateRangeBounds()
  currentPage.value = 1
  previousPage.value = 1
  clearPaginationState()
  elements.value.length = 0
  lastQuerySignature.value = getQuerySignature()
}

async function reload() {
  const loadId = ++activeLoadId.value
  isLoading.value = true
  try {
    const requestedPage = currentPage.value
    const querySignature = getQuerySignature()
    const filtersChanged = lastQuerySignature.value !== querySignature
    const shouldRecount = shouldRecountOnTableReload({
      filtersChanged,
      previousPage: previousPage.value,
      requestedPage,
    })
    if (filtersChanged) {
      // Keep frozen date bounds; only drop cursors / page for the new filters.
      resetTablePagination()
    }

    if (shouldRecount) {
      // Toolbar reload (not a page change): snap rolling bounds and drop
      // cursors so the new window cannot reuse stale page offsets.
      if (!filtersChanged)
        resetTablePagination({ snapRolling: true })
      const counted = await recountDevices(loadId)
      if (!counted)
        return
    }

    await getData(loadId)
    if (loadId === activeLoadId.value)
      previousPage.value = currentPage.value
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
  cancelScheduledReload()
  const loadId = ++activeLoadId.value
  isLoading.value = true
  try {
    resetTablePagination({ snapRolling: true })
    const counted = await recountDevices(loadId)
    if (!counted)
      return
    await getData(loadId)
    if (loadId === activeLoadId.value)
      previousPage.value = currentPage.value
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
      versionNames: getVersionNameFilter(),
      platform: getPlatformFilter(),
      devicesId: ids.length ? ids : undefined,
      search: searchTerm,
      order: getActiveOrder(columns.value),
      cursor: cursor ?? undefined,
      limit: offset,
      customIdMode: filters.value.CustomId,
      ...getDateRangePayload(),
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
  selectedVersionNames.value = props.versionName ? [props.versionName] : []
  await loadBundleNames()
  if (appId !== props.appId)
    return
  skipFilterReload.value = false
  await refreshData()
})

watch(() => props.versionName, (value) => {
  cancelScheduledReload()
  skipFilterReload.value = true
  selectedVersionNames.value = value ? [value] : []
  skipFilterReload.value = false
  debouncedReload()
})

watch([selectedPlatform, selectedVersionNames], () => {
  if (skipFilterReload.value)
    return
  debouncedReload()
}, { deep: true })
</script>

<template>
  <div>
    <div
      v-if="showRangeFilterBanner"
      class="mx-3 mt-3 flex flex-col gap-3 rounded-lg border border-azure-200 bg-azure-50 px-4 py-3 text-sm text-slate-700 dark:border-azure-800 dark:bg-azure-900/20 dark:text-slate-200 sm:flex-row sm:items-center sm:justify-between"
      data-test="devices-range-filter-banner"
      role="status"
    >
      <div class="flex min-w-0 items-start gap-3">
        <IconInfo class="mt-0.5 h-5 w-5 shrink-0 text-azure-600 dark:text-azure-400" aria-hidden="true" />
        <p>
          {{ t('devices-filter-range-banner', { range: dateRangeLabel, shown: total, total: unfilteredTotal }) }}
        </p>
      </div>
      <button
        type="button"
        class="d-btn d-btn-sm h-9 min-h-9 shrink-0 border-azure-300 bg-white text-azure-700 hover:border-azure-400 hover:bg-azure-100 dark:border-azure-700 dark:bg-slate-900 dark:text-azure-200 dark:hover:bg-azure-900/40"
        data-test="devices-range-filter-change"
        @click="openDateRangePicker"
      >
        {{ t('devices-empty-change-time') }}
      </button>
    </div>
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
      <template #toolbar-extras>
        <DateRangePicker
          ref="dateRangePickerRef"
          v-model="dateRange"
          v-model:mode="dateRangeMode"
          compact
          @apply="onDateRangeApply"
        />
      </template>
      <template #empty-state="{ clearFilters, hasActiveFilters }">
        <div
          class="mx-auto flex max-w-2xl flex-col items-center px-4 py-6 text-left md:py-8"
          data-test="devices-empty-state"
        >
          <IconSmartphone class="mb-3 h-9 w-9 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          <h3 class="text-center text-base font-semibold text-slate-900 dark:text-white">
            {{ t('devices-empty-title') }}
          </h3>
          <p class="mt-1 text-center text-sm text-slate-600 dark:text-slate-300">
            {{ t('devices-empty-intro') }}
          </p>
          <ul class="mt-4 w-full list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600 dark:text-slate-300">
            <li>
              <span class="font-medium text-slate-800 dark:text-slate-100">{{ t('devices-empty-time-reason') }}</span>
              <button
                type="button"
                class="d-btn d-btn-link ml-1 h-auto min-h-0 p-0 text-sm font-medium text-azure-600 underline decoration-azure-600/40 underline-offset-2 hover:text-azure-700 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-400 dark:hover:text-azure-300"
                @click="openDateRangePicker"
              >
                {{ t('devices-empty-change-time') }}
              </button>
            </li>
            <li v-if="hasActiveFilters">
              <span class="font-medium text-slate-800 dark:text-slate-100">{{ t('devices-empty-filters-reason') }}</span>
              <button
                type="button"
                class="d-btn d-btn-link ml-1 h-auto min-h-0 p-0 text-sm font-medium text-azure-600 underline decoration-azure-600/40 underline-offset-2 hover:text-azure-700 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-400 dark:hover:text-azure-300"
                @click="clearDeviceViewFilters(clearFilters)"
              >
                {{ t('devices-empty-clear-filters') }}
              </button>
            </li>
            <li>
              <span class="font-medium text-slate-800 dark:text-slate-100">{{ t('devices-empty-contact-reason') }}</span>
              {{ t('devices-empty-contact-help') }}
            </li>
            <li>
              <span class="font-medium text-slate-800 dark:text-slate-100">{{ t('devices-empty-refresh-reason') }}</span>
              <button
                type="button"
                class="d-btn d-btn-link ml-1 h-auto min-h-0 p-0 text-sm font-medium text-azure-600 underline decoration-azure-600/40 underline-offset-2 hover:text-azure-700 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-400 dark:hover:text-azure-300"
                @click="refreshData"
              >
                {{ t('devices-empty-refresh') }}
              </button>
            </li>
          </ul>
        </div>
      </template>
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
        <BundleMultiFilter
          v-model="selectedVersionNames"
          :options="bundleNames"
        />
      </template>
    </DataTable>
  </div>
</template>
