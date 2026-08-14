<script setup lang="ts">
import type { TableColumn, TableSort } from '~/components/comp_def'

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { formatDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useOrganizationStore } from '~/stores/organization'

// Unified history entry that can represent bundle changes or setting changes
interface HistoryEntry {
  id: string
  date: string
  user: { uid: string, email: string } | null
  event_type: 'bundle_assigned' | 'setting_changed' | 'channel_created'
  // For bundle assignments
  bundle?: {
    id: number
    name: string
    deleted?: boolean
  }
  // For setting changes
  changed_fields?: string[]
  old_values?: Record<string, unknown>
  new_values?: Record<string, unknown>
  // For display
  description: string
}

const props = defineProps<{
  channelId: number
  appId: string
}>()

const members = ref([] as ExtendedOrganizationMembers)
const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()

const historyEntries = ref<HistoryEntry[]>([])
const loading = ref(true)
const sort = ref<TableSort>({
  date: 'desc',
})
const search = ref('')
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const currentVersionId = ref<number | null>(null)

// Selected entry for details modal
const selectedEntry = ref<HistoryEntry | null>(null)

// Labels for channel fields
const fieldLabels: Record<string, string> = {
  version: 'bundle',
  name: 'channel-name',
  public: 'channel-is-public',
  ios: 'ios',
  android: 'android',
  allow_emulator: 'allow-emulator',
  allow_dev: 'allow-dev-builds',
  allow_prod: 'allow-prod-builds',
  allow_device: 'allow-device',
  allow_device_self_set: 'channel-allow-device-self-set',
  disable_auto_update: 'channel-disable-auto-update',
  disable_auto_update_under_native: 'channel-disable-auto-update-under-native',
  update_package: 'update-package',
}

function getFieldLabel(field: string): string {
  const key = fieldLabels[field]
  return key ? t(key) : field
}

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined)
    return '-'
  if (typeof value === 'boolean')
    return value ? t('yes') : t('no')
  if (field === 'version' && typeof value === 'number')
    return `#${value}`
  if (field === 'update_package') {
    switch (value) {
      case 'zip':
        return t('update-package-zip')
      case 'delta':
        return t('update-package-delta')
      case 'zip_from_builtin':
        return t('update-package-zip-from-builtin')
      case 'delta_from_builtin':
        return t('update-package-delta-from-builtin')
      default:
        return t('update-package-all')
    }
  }
  return String(value)
}

// Fetch current channel's version_id
async function fetchCurrentVersion() {
  if (!props.channelId)
    return

  try {
    const { data, error } = await supabase
      .from('channels')
      .select('version')
      .eq('id', props.channelId)
      .single()

    if (error) {
      console.error('Error fetching current version:', error)
      return
    }

    currentVersionId.value = data.version
  }
  catch (error) {
    console.error('Error fetching current version:', error)
  }
}

// Check if an entry's bundle is the current version
function isCurrentVersion(entry: HistoryEntry): boolean {
  return entry.bundle?.id === currentVersionId.value
}

function openOneVersion(entry: HistoryEntry) {
  if (entry.bundle?.id) {
    router.push(`/app/${props.appId}/bundle/${entry.bundle.id}`)
  }
}

const columns = computed<TableColumn[]>(() => {
  return [
    {
      label: t('event'),
      key: 'event_type',
      mobile: true,
      sortable: false,
      displayFunction: (item: HistoryEntry) => {
        if (item.event_type === 'bundle_assigned')
          return t('bundle-deployed')
        if (item.event_type === 'channel_created')
          return t('channel-created')
        return t('setting-changed')
      },
    },
    {
      label: t('details'),
      key: 'description',
      mobile: true,
      sortable: false,
      displayFunction: (item: HistoryEntry) => item.description,
      onClick: (item: HistoryEntry) => {
        if (item.event_type === 'bundle_assigned' && item.bundle?.id)
          openOneVersion(item)
        else if (item.event_type === 'setting_changed')
          openDetails(item)
      },
    },
    {
      label: t('date'),
      key: 'date',
      mobile: true,
      sortable: true,
      displayFunction: (item: HistoryEntry) => formatDate(item.date),
    },
    {
      label: t('by'),
      key: 'user',
      mobile: false,
      displayFunction: (item: HistoryEntry) => item.user?.email || '-',
    },
    {
      label: t('action'),
      key: 'rollback',
      mobile: true,
      class: 'text-center',
      displayFunction: (item: HistoryEntry) => {
        if (item.event_type !== 'bundle_assigned')
          return '-'
        if (item.bundle?.deleted)
          return t('bundle-deleted')
        return isCurrentVersion(item) ? t('current') : t('rollback')
      },
      onClick: (item: HistoryEntry) => {
        if (item.event_type !== 'bundle_assigned')
          return
        if (!isCurrentVersion(item) && !item.bundle?.deleted) {
          handleRollback(item)
        }
        else if (isCurrentVersion(item)) {
          toast.error(t('cannot-rollback-to-current-version'))
        }
      },
    },
  ]
})

async function openDetails(item: HistoryEntry) {
  selectedEntry.value = item
  dialogStore.openDialog({
    title: t('setting-change-details'),
    size: 'xl',
  })
  await dialogStore.onDialogDismiss()
  selectedEntry.value = null
}

async function fetchHistory() {
  loading.value = true
  try {
    historyEntries.value = []
    await fetchCurrentVersion()
    members.value = await organizationStore.getMembers()

    // Fetch ALL audit log entries for this channel
    const { data: auditData, error: auditError } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('table_name', 'channels')
      .eq('record_id', String(props.channelId))
      .order('created_at', { ascending: false })

    if (auditError) {
      console.error('Error fetching audit logs:', auditError)
      toast.error(t('error-fetching-history'))
      return
    }

    // Collect all version IDs we need to look up
    const versionIds = new Set<number>()
    for (const audit of (auditData || [])) {
      const newRecord = audit.new_record as Record<string, unknown> | null
      if (audit.operation === 'INSERT' && newRecord?.version)
        versionIds.add(Number(newRecord.version))
      if (audit.changed_fields?.includes('version') && newRecord?.version)
        versionIds.add(Number(newRecord.version))
    }

    // Fetch version names
    const versionMap = new Map<number, { id: number, name: string, deleted?: boolean }>()
    if (versionIds.size > 0) {
      const { data: versionsData } = await supabase
        .from('app_versions')
        .select('id, name, deleted')
        .in('id', Array.from(versionIds))

      if (versionsData) {
        for (const v of versionsData) {
          versionMap.set(v.id, { id: v.id, name: v.name, deleted: v.deleted || false })
        }
      }
    }

    // Process audit logs into history entries
    const entries: HistoryEntry[] = []

    for (const audit of (auditData || [])) {
      const member = members.value.find(m => m.uid === audit.user_id)
      const newRecord = audit.new_record as Record<string, unknown> | null
      const oldRecord = audit.old_record as Record<string, unknown> | null
      const changedFields = audit.changed_fields as string[] | null

      if (audit.operation === 'INSERT') {
        // Channel was created
        const versionId = newRecord?.version ? Number(newRecord.version) : null
        const version = versionId ? versionMap.get(versionId) : null

        entries.push({
          id: `audit-${audit.id}-insert`,
          date: audit.created_at,
          user: member || null,
          event_type: 'channel_created',
          bundle: version || undefined,
          description: version
            ? `${t('channel-created-with-bundle')} ${version.name}`
            : t('channel-created'),
        })
      }
      else if (audit.operation === 'UPDATE' && changedFields?.length) {
        // Check if version changed (bundle assignment)
        if (changedFields.includes('version')) {
          const versionId = newRecord?.version ? Number(newRecord.version) : null
          const version = versionId ? versionMap.get(versionId) : null

          if (version) {
            entries.push({
              id: `audit-${audit.id}-bundle`,
              date: audit.created_at,
              user: member || null,
              event_type: 'bundle_assigned',
              bundle: version,
              description: version.name,
            })
          }
        }

        // Check for other setting changes (excluding version)
        const settingChanges = changedFields.filter(f => f !== 'version' && f !== 'updated_at')
        if (settingChanges.length > 0) {
          // Build a description of what changed
          const descriptions: string[] = []
          for (const field of settingChanges) {
            const label = getFieldLabel(field)
            const newVal = formatValue(field, newRecord?.[field])
            descriptions.push(`${label}: ${newVal}`)
          }

          entries.push({
            id: `audit-${audit.id}-settings`,
            date: audit.created_at,
            user: member || null,
            event_type: 'setting_changed',
            changed_fields: settingChanges,
            old_values: oldRecord || undefined,
            new_values: newRecord || undefined,
            description: descriptions.slice(0, 2).join(', ') + (descriptions.length > 2 ? '...' : ''),
          })
        }
      }
    }

    // Apply search filter
    let filteredEntries = entries
    if (search.value) {
      const searchLower = search.value.toLowerCase()
      filteredEntries = entries.filter((entry) => {
        if (entry.bundle?.name.toLowerCase().includes(searchLower))
          return true
        if (entry.description.toLowerCase().includes(searchLower))
          return true
        if (entry.user?.email.toLowerCase().includes(searchLower))
          return true
        return false
      })
    }

    // Sort by date
    const sortDir = Object.values(sort.value)[0]
    filteredEntries.sort((a, b) => {
      const aDate = new Date(a.date).getTime()
      const bDate = new Date(b.date).getTime()
      return sortDir === 'asc' ? aDate - bDate : bDate - aDate
    })

    // Apply pagination
    total.value = filteredEntries.length
    const startIdx = (page.value - 1) * pageSize.value
    const endIdx = startIdx + pageSize.value
    historyEntries.value = filteredEntries.slice(startIdx, endIdx)
  }
  catch (error) {
    console.error('Error fetching history:', error)
    toast.error(t('error-fetching-history'))
  }
  finally {
    loading.value = false
  }
}

async function handleRollback(item: HistoryEntry) {
  if (!item.bundle?.id || !props.channelId)
    return

  const canRollback = await checkPermissions('channel.rollback_bundle', {
    appId: props.appId,
    channelId: props.channelId,
  })
  if (!canRollback) {
    toast.error(t('no-permission'))
    return
  }

  if (item.bundle?.deleted) {
    toast.error(t('version-deleted-cannot-rollback'))
    return
  }

  dialogStore.openDialog({
    title: t('rollback-to-version'),
    description: t('confirm-rollback-desc'),
    buttons: [
      {
        text: t('confirm'),
        role: 'primary',
        handler: async () => {
          try {
            const { error } = await supabase
              .from('channels')
              .update({ version: item.bundle!.id })
              .eq('id', props.channelId)

            if (error) {
              console.error('Error rolling back version:', error)
              toast.error(t('error-rollback'))
              return
            }

            toast.success(t('rollback-success'))
            currentVersionId.value = item.bundle!.id
            fetchHistory()
          }
          catch (error) {
            console.error('Error rolling back version:', error)
            toast.error(t('error-rollback'))
          }
        },
      },
      {
        text: t('cancel'),
        role: 'cancel',
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}

watch([() => props.channelId, () => props.appId], () => {
  fetchHistory()
}, { immediate: true })

watch([search, page], () => {
  fetchHistory()
})
</script>

<template>
  <DataTable
    :is-loading="loading"
    :search="search"
    :search-placeholder="t('search-by-name')"
    :total="total"
    :offset="pageSize"
    :current-page="page"
    :columns="columns"
    :element-list="historyEntries"
    @update:search="search = $event"
    @update:current-page="page = $event"
    @update:columns="columns = $event"
    @reload="fetchHistory"
  />

  <!-- Details Modal Content -->
  <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('setting-change-details')" defer to="#dialog-v2-content">
    <div v-if="selectedEntry && selectedEntry.event_type === 'setting_changed'" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <span class="px-2 py-1 text-xs font-medium rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">
          {{ t('setting-changed') }}
        </span>
        <span class="text-sm text-gray-500 dark:text-gray-500">
          {{ formatDate(selectedEntry.date) }}
        </span>
      </div>

      <div v-if="selectedEntry.user" class="text-sm text-gray-700 dark:text-gray-300">
        <span class="font-medium">{{ t('by') }}:</span>
        {{ selectedEntry.user.email }}
      </div>

      <div v-if="selectedEntry.changed_fields?.length">
        <h4 class="font-semibold mb-2 text-gray-900 dark:text-white">
          {{ t('changes') }}
        </h4>
        <div class="space-y-3">
          <div
            v-for="field in selectedEntry.changed_fields"
            :key="field"
            class="border border-gray-200 dark:border-gray-700 rounded-lg p-3"
          >
            <div class="font-medium text-sm mb-2 text-gray-900 dark:text-white">
              {{ getFieldLabel(field) }}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div class="bg-red-50 dark:bg-red-900/20 p-2 rounded text-xs overflow-x-auto">
                <div class="text-red-600 dark:text-red-400 text-xs mb-1">
                  {{ t('before') }}
                </div>
                <pre class="text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap break-all">{{ formatValue(field, selectedEntry.old_values?.[field]) }}</pre>
              </div>
              <div class="bg-green-50 dark:bg-green-900/20 p-2 rounded text-xs overflow-x-auto">
                <div class="text-green-600 dark:text-green-400 text-xs mb-1">
                  {{ t('after') }}
                </div>
                <pre class="text-green-700 dark:text-green-300 font-mono whitespace-pre-wrap break-all">{{ formatValue(field, selectedEntry.new_values?.[field]) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
