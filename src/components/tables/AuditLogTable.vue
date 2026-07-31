<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import { FormKit } from '@formkit/vue'
import { useDebounceFn } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconDown from '~icons/ic/round-keyboard-arrow-down'
import IconFastBackward from '~icons/ic/round-keyboard-double-arrow-left'
import IconSearch from '~icons/ic/round-search?raw'
import IconSortDown from '~icons/lucide/chevron-down'
import IconSortUp from '~icons/lucide/chevron-up'
import IconSort from '~icons/lucide/chevrons-up-down'
import IconFilter from '~icons/system-uicons/filtering'
import IconReload from '~icons/tabler/reload'
import { formatDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useOrganizationStore } from '~/stores/organization'

type AuditActorType = 'user' | 'apikey' | 'system' | 'unknown'

interface AuditLogRow {
  id: number
  created_at: string
  table_name: string
  record_id: string
  operation: string
  user_id: string | null
  org_id: string
  old_record: Record<string, unknown> | null
  new_record: Record<string, unknown> | null
  changed_fields: string[] | null
  actor_type: AuditActorType
  actor_user_id: string | null
  actor_user_email: string | null
  actor_apikey_id: number | null
  actor_apikey_name: string | null
}

interface ExtendedAuditLog extends AuditLogRow {
  user?: {
    uid: string
    email: string
  } | null
}

const props = defineProps<{
  orgId: string
}>()

const { t } = useI18n()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()

const auditLogs = ref<ExtendedAuditLog[]>([])
const membersMap = ref<Map<string, { uid: string, email: string }>>(new Map())
const membersLoaded = ref(false)
const isLoading = ref(true)
const search = ref('')
const currentPage = ref(1)
const total = ref(0)
const pageSize = 20

// Modal state
const selectedLog = ref<ExtendedAuditLog | null>(null)

// Filter dropdown state - similar to LogTable
const filterDropdownOpen = ref(false)
const filterDropdownRef = ref<HTMLElement | null>(null)
const filterDropdownStyle = ref<{ top: string, left: string }>({ top: '0px', left: '0px' })
const filterSearchVal = ref('')

// All filter options combining table + operation
const actionFilters = ref<Record<string, boolean>>({
  'audit-orgs-insert': false,
  'audit-orgs-update': false,
  'audit-orgs-delete': false,
  'audit-apps-insert': false,
  'audit-apps-update': false,
  'audit-apps-delete': false,
  'audit-channels-insert': false,
  'audit-channels-update': false,
  'audit-channels-delete': false,
  'audit-app_versions-insert': false,
  'audit-app_versions-update': false,
  'audit-app_versions-delete': false,
  'audit-org_users-insert': false,
  'audit-org_users-update': false,
  'audit-org_users-delete': false,
})

// Mapping filter key to { table, operation }
const filterToTableOperation: Record<string, { table: string, operation: string }> = {
  'audit-orgs-insert': { table: 'orgs', operation: 'INSERT' },
  'audit-orgs-update': { table: 'orgs', operation: 'UPDATE' },
  'audit-orgs-delete': { table: 'orgs', operation: 'DELETE' },
  'audit-apps-insert': { table: 'apps', operation: 'INSERT' },
  'audit-apps-update': { table: 'apps', operation: 'UPDATE' },
  'audit-apps-delete': { table: 'apps', operation: 'DELETE' },
  'audit-channels-insert': { table: 'channels', operation: 'INSERT' },
  'audit-channels-update': { table: 'channels', operation: 'UPDATE' },
  'audit-channels-delete': { table: 'channels', operation: 'DELETE' },
  'audit-app_versions-insert': { table: 'app_versions', operation: 'INSERT' },
  'audit-app_versions-update': { table: 'app_versions', operation: 'UPDATE' },
  'audit-app_versions-delete': { table: 'app_versions', operation: 'DELETE' },
  'audit-org_users-insert': { table: 'org_users', operation: 'INSERT' },
  'audit-org_users-update': { table: 'org_users', operation: 'UPDATE' },
  'audit-org_users-delete': { table: 'org_users', operation: 'DELETE' },
}

const columns: Ref<TableColumn[]> = ref<TableColumn[]>([
  {
    label: 'date',
    key: 'created_at',
    mobile: true,
    sortable: 'desc',
    class: 'truncate max-w-8',
  },
  {
    label: 'resource',
    key: 'table_name',
    mobile: true,
    sortable: true,
    class: 'truncate max-w-8',
  },
  {
    label: 'action',
    key: 'operation',
    mobile: true,
    sortable: true,
    class: 'truncate max-w-8',
  },
  {
    label: 'actor',
    key: 'actor',
    mobile: false,
    sortable: false,
    class: 'truncate max-w-8',
  },
  {
    label: 'changed-fields',
    key: 'changed_fields',
    mobile: false,
    sortable: false,
    class: 'truncate max-w-8',
  },
  {
    label: 'details',
    key: 'details',
    mobile: true,
    sortable: false,
    class: 'text-center cursor-pointer hover:underline',
  },
])

function toggleFilterDropdown() {
  if (filterDropdownOpen.value) {
    filterDropdownOpen.value = false
    return
  }
  if (filterDropdownRef.value) {
    const rect = filterDropdownRef.value.getBoundingClientRect()
    filterDropdownStyle.value = {
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
    }
  }
  filterDropdownOpen.value = true
}

function handleClickOutside(event: MouseEvent) {
  if (filterDropdownOpen.value && filterDropdownRef.value && !filterDropdownRef.value.contains(event.target as Node)) {
    const dropdown = document.querySelector('.fixed.p-2.w-64.bg-white')
    if (dropdown && !dropdown.contains(event.target as Node)) {
      filterDropdownOpen.value = false
    }
  }
}

const filterList = computed(() => {
  const allFilters = Object.keys(actionFilters.value)
  if (!filterSearchVal.value)
    return allFilters
  const searchLower = filterSearchVal.value.toLowerCase()
  return allFilters.filter(f => t(f).toLowerCase().includes(searchLower))
})

const filterActivated = computed(() => {
  return Object.keys(actionFilters.value).reduce((acc, key) => {
    if (actionFilters.value[key])
      acc += 1
    return acc
  }, 0)
})

// Compute active filters for query
const activeFilters = computed(() => {
  const filters: { table: string, operation: string }[] = []
  for (const [filterKey, enabled] of Object.entries(actionFilters.value)) {
    if (enabled && filterToTableOperation[filterKey]) {
      filters.push(filterToTableOperation[filterKey])
    }
  }
  return filters.length > 0 ? filters : undefined
})

function getOperationLabel(operation: string): string {
  switch (operation) {
    case 'INSERT':
      return t('created')
    case 'UPDATE':
      return t('modified')
    case 'DELETE':
      return t('deleted')
    default:
      return operation
  }
}

function getTableLabel(tableName: string): string {
  switch (tableName) {
    case 'orgs':
      return t('organization')
    case 'apps':
      return t('app')
    case 'channels':
      return t('channel')
    case 'app_versions':
      return t('bundle')
    case 'org_users':
      return t('member')
    default:
      return tableName
  }
}

function getActorTypeLabel(actorType: AuditActorType): string {
  switch (actorType) {
    case 'user':
      return t('user')
    case 'apikey':
      return t('api-key')
    case 'system':
      return t('automated')
    default:
      return t('unknown')
  }
}

function getActorUserEmail(item: ExtendedAuditLog): string | null {
  if (item.actor_type !== 'user')
    return null

  return item.actor_user_email || item.user?.email || null
}

function getActorDisplay(item: ExtendedAuditLog): string {
  if (item.actor_type === 'apikey') {
    const apiKey = item.actor_apikey_id ? `${t('api-key')} #${item.actor_apikey_id}` : t('api-key')
    return item.actor_apikey_name ? `${apiKey} (${item.actor_apikey_name})` : apiKey
  }

  if (item.actor_type === 'system')
    return t('automated')

  if (item.actor_type === 'user')
    return getActorUserEmail(item) || item.actor_user_id || item.user_id || '-'

  return t('unknown')
}

async function openDetails(item: ExtendedAuditLog) {
  selectedLog.value = item
  dialogStore.openDialog({
    title: t('audit-log-details'),
    size: 'xl',
  })
  await dialogStore.onDialogDismiss()
  selectedLog.value = null
}

function getChangedFieldsDisplay(item: ExtendedAuditLog): string {
  if (!item.changed_fields || item.changed_fields.length === 0) {
    return '-'
  }
  return item.changed_fields.slice(0, 3).join(', ') + (item.changed_fields.length > 3 ? '...' : '')
}

function displayValueKey(elem: ExtendedAuditLog, col: TableColumn): string {
  switch (col.key) {
    case 'created_at':
      return formatDate(elem.created_at)
    case 'table_name':
      return getTableLabel(elem.table_name)
    case 'operation':
      return getOperationLabel(elem.operation)
    case 'actor':
      return getActorDisplay(elem)
    case 'changed_fields':
      return getChangedFieldsDisplay(elem)
    case 'details':
      return t('view')
    default:
      return String(elem[col.key as keyof ExtendedAuditLog] ?? '')
  }
}

async function loadMembers() {
  if (membersLoaded.value)
    return

  try {
    const membersList = await organizationStore.getMembers()
    membersMap.value = new Map(membersList.map(m => [m.uid, m]))
    membersLoaded.value = true
  }
  catch (error) {
    console.error('Error fetching members:', error)
  }
}

async function fetchAuditLogs() {
  isLoading.value = true
  try {
    await loadMembers()

    let query = supabase
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .eq('org_id', props.orgId)
      .order('created_at', { ascending: false })

    // Apply filters if any are active
    if (activeFilters.value && activeFilters.value.length > 0) {
      // Build OR conditions for the filters
      const filterConditions = activeFilters.value.map(f => `and(table_name.eq.${f.table},operation.eq.${f.operation})`)
      query = query.or(filterConditions.join(','))
    }

    if (search.value) {
      query = query.ilike('record_id', `%${search.value}%`)
    }

    const { data, error, count } = await query
      .range((currentPage.value - 1) * pageSize, currentPage.value * pageSize - 1)

    if (error) {
      console.error('Error fetching audit logs:', error)
      toast.error(t('error-fetching-audit-logs'))
      return
    }

    const rows = (data ?? []) as ExtendedAuditLog[]

    for (const item of rows) {
      const memberId = item.actor_type === 'user'
        ? (item.actor_user_id || item.user_id)
        : null
      if (memberId) {
        const member = membersMap.value.get(memberId)
        if (member) {
          item.user = member
        }
      }
    }

    auditLogs.value = rows
    total.value = count ?? 0
  }
  catch (error) {
    console.error('Error fetching audit logs:', error)
    toast.error(t('error-fetching-audit-logs'))
  }
  finally {
    isLoading.value = false
  }
}

function sortClick(key: number) {
  if (!columns.value[key].sortable)
    return
  let sortable = columns.value[key].sortable
  if (sortable === 'asc')
    sortable = 'desc'
  else if (sortable === 'desc')
    sortable = true
  else
    sortable = 'asc'
  columns.value[key].sortable = sortable
}

function loadMore() {
  currentPage.value++
  fetchAuditLogs()
}

function refreshData() {
  currentPage.value = 1
  auditLogs.value = []
  fetchAuditLogs()
}

function formatJson(data: unknown): string {
  if (!data)
    return '-'
  try {
    return JSON.stringify(data, null, 2)
  }
  catch {
    return String(data)
  }
}

function getChangeDiff(oldRecord: unknown, newRecord: unknown, changedFields: string[] | null): { field: string, oldValue: string, newValue: string }[] {
  if (!changedFields || changedFields.length === 0) {
    return []
  }

  const oldObj = (oldRecord || {}) as Record<string, unknown>
  const newObj = (newRecord || {}) as Record<string, unknown>

  return changedFields.map((field) => {
    const oldVal = field in oldObj ? JSON.stringify(oldObj[field], null, 2) : '(not set)'
    const newVal = field in newObj ? JSON.stringify(newObj[field], null, 2) : '(not set)'
    return { field, oldValue: oldVal, newValue: newVal }
  })
}

const selectedLogChanges = computed(() => {
  if (!selectedLog.value || selectedLog.value.operation !== 'UPDATE') {
    return []
  }
  return getChangeDiff(
    selectedLog.value.old_record,
    selectedLog.value.new_record,
    selectedLog.value.changed_fields,
  )
})

const debouncedSearch = useDebounceFn(() => {
  currentPage.value = 1
  fetchAuditLogs()
}, 500)

watch(search, () => {
  debouncedSearch()
})

watch(actionFilters, () => {
  refreshData()
}, { deep: true })

onMounted(() => {
  fetchAuditLogs()
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="pb-4 md:pb-0">
    <div class="flex items-start justify-between p-3 pb-4 overflow-visible md:items-center">
      <div class="flex h-10 md:mb-0">
        <button class="inline-flex items-center py-1.5 px-3 mr-2 text-sm font-medium text-gray-500 bg-white rounded-md border border-gray-300 dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden" type="button" @click="refreshData">
          <IconReload v-if="!isLoading" class="m-1 md:mr-2" />
          <Spinner v-else size="w-[16.8px] h-[16.8px] m-1 mr-2" />
          <span class="hidden text-sm md:block">{{ t('reload') }}</span>
        </button>
      </div>

      <!-- Filter Dropdown - same design as LogTable -->
      <div ref="filterDropdownRef" class="relative h-10 mr-2 md:mr-auto">
        <button
          type="button"
          class="relative inline-flex items-center py-1.5 px-3 h-full text-sm font-medium text-gray-500 bg-white rounded-md border border-gray-300 cursor-pointer dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden"
          @click="toggleFilterDropdown"
        >
          <div
            v-if="filterActivated"
            class="inline-flex absolute -top-2 -right-2 justify-center items-center w-6 h-6 text-xs font-bold text-white bg-red-500 rounded-full border-2 border-white dark:border-gray-900"
          >
            {{ filterActivated }}
          </div>
          <IconFilter class="mr-2 w-4 h-4" />
          <span class="hidden md:block">{{ t('filter-actions') }}</span>
          <IconDown class="hidden ml-2 w-4 h-4 md:block" />
        </button>
        <Teleport to="body">
          <div
            v-if="filterDropdownOpen"
            class="fixed p-2 w-64 bg-white shadow-lg rounded-lg z-9999 dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
            :style="filterDropdownStyle"
            @click.stop
          >
            <label for="audit-log-filter-search" class="sr-only">{{ t('search') }}</label>
            <input
              id="audit-log-filter-search"
              v-model="filterSearchVal"
              type="text"
              :placeholder="t('search')"
              :aria-label="t('search')"
              class="w-full px-3 py-2 mb-2 text-sm border border-gray-300 rounded-md dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              @click.stop
            >
            <ul class="max-h-64 overflow-y-auto">
              <li v-for="(f, i) in filterList" :key="i">
                <div
                  class="flex items-center p-2 rounded-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600"
                >
                  <input
                    :id="`filter-radio-example-${i}`" :checked="actionFilters[f]" type="checkbox"
                    :name="`filter-radio-${i}`"
                    class="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 dark:bg-gray-700 dark:border-gray-600 dark:ring-offset-gray-800 focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 dark:focus:ring-offset-gray-800"
                    @change="actionFilters[f] = !actionFilters[f]"
                  >
                  <label
                    :for="`filter-radio-example-${i}`"
                    class="ml-2 w-full text-sm font-medium text-gray-900 rounded-sm dark:text-gray-300"
                  >{{ t(f) }}</label>
                </div>
              </li>
              <li v-if="filterList.length === 0" class="p-2 text-sm text-gray-500 dark:text-gray-400 text-center">
                {{ t('no-results') }}
              </li>
            </ul>
          </div>
        </Teleport>
      </div>

      <div class="flex overflow-hidden md:w-auto">
        <FormKit
          v-model="search"
          :placeholder="t('search-by-record-id')"
          :prefix-icon="IconSearch"
          :disabled="isLoading"
          enterkeyhint="send"
          :classes="{
            outer: 'mb-0! md:w-96',
          }"
        />
      </div>
    </div>

    <div class="block overflow-x-auto">
      <table id="custom_table" class="w-full text-sm text-left text-gray-500 dark:text-gray-400">
        <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:text-gray-400 dark:bg-gray-700">
          <tr>
            <th v-for="(col, i) in columns" :key="i" scope="col" class="px-1 py-3 md:px-6" :class="{ 'cursor-pointer': col.sortable, 'hidden md:table-cell': !col.mobile }" @click="sortClick(i)">
              <div class="flex items-center first-letter:uppercase">
                {{ t(col.label) }}
                <div v-if="col.sortable">
                  <IconSortUp v-if="col.sortable === 'asc'" />
                  <IconSortDown v-else-if="col.sortable === 'desc'" />
                  <IconSort v-else />
                </div>
              </div>
            </th>
          </tr>
        </thead>
        <tbody v-if="!isLoading && auditLogs.length !== 0">
          <tr
            v-for="(elem, i) in auditLogs" :key="i"
            class="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
          >
            <template v-for="(col, y) in columns" :key="`${i}_${y}`">
              <td
                :class="`${col.class} ${!col.mobile ? 'hidden md:table-cell' : ''} ${col.key === 'details' ? 'cursor-pointer hover:underline clickable-cell' : ''}`"
                class="px-1 py-1 md:py-4 md:px-6"
                @click.stop="col.key === 'details' ? openDetails(elem) : undefined"
              >
                {{ displayValueKey(elem, col) }}
              </td>
            </template>
          </tr>
        </tbody>
        <tbody v-else-if="!isLoading && auditLogs.length === 0">
          <tr>
            <td :colspan="columns.length" class="px-1 py-1 text-center text-gray-500 md:py-4 md:px-6 dark:text-gray-400">
              {{ t('no_elements_found') }}
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="i in 10" :key="i" class="max-w-sm" :class="{ 'animate-pulse duration-1000': isLoading }">
            <td v-for="(_, y) in columns" :key="`${i}_${y}`" class="px-1 py-1 md:py-4 md:px-6">
              <div class="bg-gray-200 rounded-full dark:bg-gray-700 max-w-[300px] h-2 mb-2.5" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <nav class="fixed bottom-0 left-0 z-40 flex items-center justify-between w-full p-4 bg-white md:relative md:pt-4 md:bg-transparent dark:bg-gray-900 dark:md:bg-transparent" aria-label="Table navigation">
      <button
        v-if="auditLogs.length < total"
        class="flex items-center justify-center h-10 px-4 py-2 space-x-2 text-sm font-medium transition-colors border border-gray-300 rounded-md whitespace-nowrap dark:text-white dark:border-gray-700 focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background dark:hover:bg-primary/90 hover:bg-primary/10 focus-visible:outline-hidden focus-visible:ring-ring"
        @click="loadMore"
      >
        <IconFastBackward />
        <span>{{ t('load-older') }}</span>
      </button>
    </nav>

    <!-- Details Modal Content -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('audit-log-details')" defer to="#dialog-v2-content">
      <div v-if="selectedLog" class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="px-2 py-1 text-xs font-medium rounded"
            :class="{
              'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300': selectedLog.operation === 'INSERT',
              'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300': selectedLog.operation === 'UPDATE',
              'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300': selectedLog.operation === 'DELETE',
            }"
          >
            {{ getOperationLabel(selectedLog.operation) }}
          </span>
          <span class="text-sm text-gray-600 dark:text-gray-400">
            {{ getTableLabel(selectedLog.table_name) }} #{{ selectedLog.record_id }}
          </span>
          <span class="text-sm text-gray-500 dark:text-gray-500">
            {{ formatDate(selectedLog.created_at) }}
          </span>
        </div>

        <div class="space-y-1 text-sm text-gray-700 dark:text-gray-300">
          <div>
            <span class="font-medium">{{ t('source') }}:</span>
            {{ getActorTypeLabel(selectedLog.actor_type) }}
          </div>
          <div v-if="selectedLog.actor_type === 'apikey' && selectedLog.actor_apikey_id">
            <span class="font-medium">{{ t('api-key-id') }}:</span>
            #{{ selectedLog.actor_apikey_id }}
          </div>
          <div v-if="selectedLog.actor_type === 'apikey' && selectedLog.actor_apikey_name">
            <span class="font-medium">{{ t('api-key-name') }}:</span>
            {{ selectedLog.actor_apikey_name }}
          </div>
          <div v-if="getActorUserEmail(selectedLog)">
            <span class="font-medium">{{ t('actor-user-email') }}:</span>
            {{ getActorUserEmail(selectedLog) }}
          </div>
        </div>

        <div v-if="selectedLog.operation === 'UPDATE' && selectedLog.changed_fields?.length">
          <h4 class="font-semibold mb-2 text-gray-900 dark:text-white">
            {{ t('changes') }}
          </h4>
          <div class="space-y-3">
            <div
              v-for="change in selectedLogChanges"
              :key="change.field"
              class="border border-gray-200 dark:border-gray-700 rounded-lg p-3"
            >
              <div class="font-medium text-sm mb-2 text-gray-900 dark:text-white">
                {{ change.field }}
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div class="bg-red-50 dark:bg-red-900/20 p-2 rounded text-xs overflow-x-auto">
                  <div class="text-red-600 dark:text-red-400 text-xs mb-1">
                    {{ t('before') }}
                  </div>
                  <pre class="text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap break-all">{{ change.oldValue }}</pre>
                </div>
                <div class="bg-green-50 dark:bg-green-900/20 p-2 rounded text-xs overflow-x-auto">
                  <div class="text-green-600 dark:text-green-400 text-xs mb-1">
                    {{ t('after') }}
                  </div>
                  <pre class="text-green-700 dark:text-green-300 font-mono whitespace-pre-wrap break-all">{{ change.newValue }}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="selectedLog.operation === 'INSERT'">
          <h4 class="font-semibold mb-2 text-gray-900 dark:text-white">
            {{ t('new-record') }}
          </h4>
          <pre class="bg-gray-100 dark:bg-gray-700 p-4 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap text-gray-800 dark:text-gray-200">{{ formatJson(selectedLog.new_record) }}</pre>
        </div>

        <div v-else-if="selectedLog.operation === 'DELETE'">
          <h4 class="font-semibold mb-2 text-gray-900 dark:text-white">
            {{ t('deleted-record') }}
          </h4>
          <pre class="bg-gray-100 dark:bg-gray-700 p-4 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap text-gray-800 dark:text-gray-200">{{ formatJson(selectedLog.old_record) }}</pre>
        </div>
      </div>
    </Teleport>
  </div>
</template>
