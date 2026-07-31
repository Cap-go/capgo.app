<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import { useDebounceFn } from '@vueuse/core'
import dayjs from 'dayjs'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { formatDate } from '~/services/date'
import { getLogDocUrl } from '~/services/logDocLinks'
import { actionToFilter, createActionFilterState, failureActionFilterKeys, filterToAction } from '~/services/statsActions'
import { defaultApiHost, useSupabase } from '~/services/supabase'

const props = defineProps<{
  deviceId?: string
  appId?: string
  actions?: string[]
}>()

interface LogData {
  app_id: string
  device_id: string
  action: string
  version_name: string
  version?: number
  metadata?: Record<string, string> | string | null
  created_at: string
}
type Element = LogData

function getActiveOrder(columns: TableColumn[]) {
  return columns
    .filter(col => typeof col.sortable === 'string')
    .map(col => ({ key: col.key, sortable: col.sortable }))
}

interface ParsedVersionName {
  version: string
  filename: string | null
  isFileSpecific: boolean
}

function parseVersionName(versionName: string): ParsedVersionName {
  const colonIndex = versionName.indexOf(':')
  if (colonIndex > 0) {
    return {
      version: versionName.substring(0, colonIndex),
      filename: versionName.substring(colonIndex + 1),
      isFileSpecific: true,
    }
  }
  return {
    version: versionName,
    filename: null,
    isFileSpecific: false,
  }
}
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const supabase = useSupabase()
const search = ref('')
const elements = ref<Element[]>([])
const isLoading = ref(false)
const isExporting = ref(false)
const currentPage = ref(1)

// Initialize date range from query parameters if provided, otherwise default to last hour
function initializeDateRange(): [Date, Date] {
  const startParam = route.query.start
  const endParam = route.query.end

  if (startParam && endParam && typeof startParam === 'string' && typeof endParam === 'string') {
    try {
      const startDate = new Date(startParam)
      const endDate = new Date(endParam)

      // Validate dates
      if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
        return [startDate, endDate]
      }
    }
    catch (error) {
      console.warn('Invalid date parameters in URL:', error)
    }
  }

  return [dayjs().subtract(1, 'hour').toDate(), new Date()]
}

const range = ref<[Date, Date]>(initializeDateRange())
function normalizeMetadata(metadata: LogData['metadata']): Record<string, string> | null {
  if (!metadata)
    return null
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, string>
    }
    catch {
      return null
    }
    return null
  }
  return metadata
}

function formatMetadata(elem: Element): string {
  const metadata = normalizeMetadata(elem.metadata)
  if (!metadata)
    return '-'

  const entries = Object.entries(metadata)
  if (!entries.length)
    return '-'

  const preview = entries.slice(0, 3).map(([key, value]) => `${key}: ${value}`).join(', ')
  return entries.length > 3 ? `${preview}, +${entries.length - 3}` : preview
}

async function copyMetadata(elem: Element) {
  const metadata = normalizeMetadata(elem.metadata)
  if (!metadata)
    return

  try {
    await navigator.clipboard.writeText(JSON.stringify(metadata, null, 2))
    toast.success(t('copied-to-clipboard'))
  }
  catch (error) {
    console.error(error)
    toast.error(t('copy-fail'))
  }
}
const filterShortcuts = [
  { label: 'filter-shortcut-all-fail', filters: failureActionFilterKeys },
]
let latestDataRequest = 0
const actionFilters = ref<Record<string, boolean>>(createActionFilterState())
function formatAction(elem: Element): string {
  const filterKey = actionToFilter[elem.action]
  return filterKey ? t(filterKey) : elem.action
}

// Initialize action filters from URL query parameter
function initializeActionFilters(): void {
  const actionParams = [route.query.action]
    .flat()
    .filter((action): action is string => typeof action === 'string')

  actionParams.forEach((action) => {
    const filterKey = actionToFilter[action]
    if (filterKey && actionFilters.value[filterKey] !== undefined) {
      actionFilters.value[filterKey] = true
    }
  })
}

// Compute active actions based on filters
const activeActions = computed(() => {
  const actions: string[] = []
  for (const [filterKey, enabled] of Object.entries(actionFilters.value)) {
    if (enabled && filterToAction[filterKey]) {
      actions.push(filterToAction[filterKey])
    }
  }
  // If props.actions is provided, use those instead (for backward compatibility)
  if (props.actions?.length) {
    return props.actions
  }
  // If no filters are selected, return undefined to get all actions
  return actions.length > 0 ? actions : undefined
})

const paginatedRange = computed(() => {
  const rangeStart = range.value ? range.value[0].getTime() : undefined
  const rangeEnd = range.value ? range.value[1].getTime() : undefined

  if (rangeStart && rangeEnd) {
    const timeDifference = rangeEnd - rangeStart
    const pageTimeOffset = timeDifference * (currentPage.value - 1)

    return {
      rangeStart: rangeStart + pageTimeOffset,
      rangeEnd: rangeEnd + pageTimeOffset,
    }
  }

  return {
    rangeStart,
    rangeEnd,
  }
})

async function getData(options: { append?: boolean } = {}) {
  const append = options.append ?? true
  const requestId = ++latestDataRequest
  isLoading.value = true
  try {
    const { data: currentSession } = await supabase.auth.getSession()!
    if (!currentSession.session)
      return
    const currentJwt = currentSession.session.access_token

    try {
      const response = await fetch(`${defaultApiHost}/private/stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${currentJwt ?? ''}`,
        },
        body: JSON.stringify({
          appId: props.appId,
          devicesId: props.deviceId ? [props.deviceId] : undefined,
          search: search.value ? search.value : undefined,
          order: getActiveOrder(columns.value),
          rangeStart: paginatedRange.value.rangeStart,
          rangeEnd: paginatedRange.value.rangeEnd,
          actions: activeActions.value,
        }),
      })

      if (!response.ok) {
        console.log('Cannot get stats', response.status)
        return
      }

      const dataD = await response.json() as LogData[]
      if (requestId !== latestDataRequest)
        return

      if (append)
        elements.value.push(...dataD)
      else
        elements.value = dataD
    }
    catch (err) {
      console.log('Cannot get devices', err)
    }
  }
  catch (error) {
    console.error(error)
  }
  finally {
    if (requestId === latestDataRequest)
      isLoading.value = false
  }
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function exportCsv() {
  if (isExporting.value)
    return
  isExporting.value = true
  const loadingToastId = toast.loading(t('exporting-logs'))
  try {
    const { data: currentSession } = await supabase.auth.getSession()!
    if (!currentSession.session) {
      toast.dismiss(loadingToastId)
      toast.error(t('not-logged-in'))
      return
    }
    const currentJwt = currentSession.session.access_token

    const response = await fetch(`${defaultApiHost}/private/stats/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${currentJwt ?? ''}`,
      },
      body: JSON.stringify({
        appId: props.appId,
        devicesId: props.deviceId ? [props.deviceId] : undefined,
        search: search.value ? search.value : undefined,
        order: getActiveOrder(columns.value),
        rangeStart: range.value?.[0]?.toISOString(),
        rangeEnd: range.value?.[1]?.toISOString(),
        actions: activeActions.value,
        format: 'csv',
        limit: 10_000,
      }),
    })

    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { message?: string }
      toast.dismiss(loadingToastId)
      toast.error(err?.message || t('export-failed'))
      return
    }

    const data = await response.json() as { csv: string, filename: string, contentType: string }
    if (!data.csv || !data.filename) {
      toast.dismiss(loadingToastId)
      toast.error(t('export-failed'))
      return
    }

    downloadText(data.filename, data.csv, data.contentType || 'text/csv; charset=utf-8')
    toast.dismiss(loadingToastId)
    toast.success(t('export-ready'))
  }
  catch (error) {
    console.error(error)
    toast.dismiss(loadingToastId)
    toast.error(t('export-failed'))
  }
  finally {
    isExporting.value = false
  }
}
async function refreshData() {
  try {
    currentPage.value = 1
    await getData({ append: false })
  }
  catch (error) {
    console.error(error)
  }
}
const debouncedRefreshData = useDebounceFn(() => {
  void refreshData()
}, 700)
columns.value = [
  {
    label: t('created-at'),
    key: 'created_at',
    mobile: true,
    class: 'truncate max-w-8',
    sortable: 'desc',
    displayFunction: (elem: Element) => formatDate(elem.created_at ?? ''),
  },
  {
    label: t('device-id'),
    key: 'device_id',
    class: 'truncate max-w-8',
    mobile: true,
    sortable: true,
    head: true,
    onClick: (elem: Element) => openOne(elem),
  },
  {
    label: t('action'),
    key: 'action',
    mobile: true,
    class: 'truncate max-w-8',
    sortable: true,
    head: true,
    displayFunction: (elem: Element) => formatAction(elem),
    onClick: (elem: Element) => window.open(getLogDocUrl(elem.action), '_blank', 'noopener,noreferrer'),
  },
  {
    label: t('version'),
    key: 'version_name',
    class: 'truncate max-w-8',
    mobile: false,
    sortable: false,
    displayFunction: (elem: Element) => {
      const parsed = parseVersionName(elem.version_name)
      return parsed.isFileSpecific
        ? `${parsed.version} (${parsed.filename})`
        : parsed.version
    },
    onClick: (elem: Element) => openOneVersion(elem),
  },
  {
    label: t('metadata'),
    key: 'metadata',
    class: 'truncate max-w-48',
    mobile: false,
    sortable: false,
    displayFunction: (elem: Element) => formatMetadata(elem),
    onClick: (elem: Element) => copyMetadata(elem),
  },
]

async function reload() {
  try {
    currentPage.value = 1
    await getData({ append: false })
  }
  catch (error) {
    console.error(error)
  }
}
async function openOneVersion(one: Element) {
  if (props.deviceId || !props.appId)
    return
  if (!one.version) {
    const loadingToastId = toast.loading(t('loading-version'))
    // Extract version from composite format if present (e.g., "1.2.3:main.js" -> "1.2.3")
    const parsed = parseVersionName(one.version_name)
    const versionName = parsed.version

    const { data: versionRecord, error } = await supabase
      .from('app_versions')
      .select('id')
      .eq('app_id', props.appId)
      .eq('name', versionName)
      .single()
    if (error || !versionRecord?.id) {
      toast.dismiss(loadingToastId)
      toast.error(t('cannot-find-version'))
      return
    }
    one.version = versionRecord.id
    toast.dismiss(loadingToastId)
  }
  if (one.version)
    router.push(`/app/${props.appId}/bundle/${one.version}`)
  else
    toast.error(t('version-name-missing'))
}
async function openOne(one: Element) {
  if (props.deviceId || !props.appId)
    return
  router.push(`/app/${props.appId}/device/${one.device_id}`)
}
onMounted(async () => {
  initializeActionFilters()
  await refreshData()
})
watch(columns, async () => {
  await refreshData()
}, { deep: true })
watch(search, async () => {
  await refreshData()
})
watch(() => props.appId, async () => {
  await refreshData()
})
watch(() => props.deviceId, async () => {
  await refreshData()
})
watch(() => props.actions, async () => {
  await refreshData()
})
watch(actionFilters, () => {
  debouncedRefreshData()
}, { deep: true })
watch(range, async () => {
  await refreshData()
})
</script>

<template>
  <div>
    <TableLog
      v-model:filters="actionFilters"
      v-model:columns="columns"
      v-model:current-page="currentPage"
      v-model:search="search"
      v-model:range="range"
      :element-list="elements"
      filter-text="filter-actions"
      :filter-shortcuts="filterShortcuts"
      :is-loading="isLoading"
      :exportable="true"
      :export-loading="isExporting"
      :auto-reload="false"
      :app-id="props.appId ?? ''"
      :search-placeholder="deviceId ? t('search-by-device-id-0') : t('search-by-device-id-')"
      @reload="reload()" @reset="refreshData()" @export="exportCsv()"
    />
  </div>
</template>
