<script setup lang="ts">
import type { TableColumn, TableSort } from '~/components/comp_def'

import { computedAsync } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { channelUpdatePackageErrorKey } from '~/services/channelUpdatePackageError'
import { formatDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useOrganizationStore } from '~/stores/organization'

// Define custom type for deploy_history since it doesn't exist in Database types
interface DeployHistory {
  id: number
  version_id: number
  app_id: string
  channel_id: number
  deployed_at: string
  version: {
    id: number
    name: string
    app_id: string
    created_at: string
    deleted?: boolean
  }
  channel?: {
    id: number
    name: string
  }
  created_by: string
  user: {
    uid: string
    email: string
  } | null
  // For bundle history: distinguish between assigned and removed events
  event_type?: 'assigned' | 'removed'
}

const props = defineProps<{
  channelId?: number
  bundleId?: number
  appId: string
}>()

const canRollbackBundle = computedAsync(async () => {
  if (!props.appId || !props.channelId)
    return false
  return await checkPermissions('channel.rollback_bundle', { appId: props.appId, channelId: props.channelId })
}, false)

const members = ref([] as ExtendedOrganizationMembers)
const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()

const deployHistory = ref<DeployHistory[]>([])
const loading = ref(true)
const sort = ref<TableSort>({
  deployed_at: 'desc',
})
const search = ref('')
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const currentVersionId = ref<number | null>(null)

// Fetch current channel's version_id (only relevant for channel mode)
async function fetchCurrentVersion() {
  // Skip if in bundle mode
  if (props.bundleId)
    return

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

// Check if an item is the current version
function isCurrentVersion(item: DeployHistory): boolean {
  return item.version_id === currentVersionId.value
}

// Check if we're in bundle mode (showing deployment history for a specific bundle)
const isBundleMode = computed(() => !!props.bundleId)

function openOneChannel(item: DeployHistory) {
  if (item.channel?.id) {
    router.push(`/app/${props.appId}/channel/${item.channel.id}`)
  }
}

const columns = computed<TableColumn[]>(() => {
  // Bundle mode: show channel name instead of bundle name, and no rollback
  if (isBundleMode.value) {
    return [
      {
        label: t('channel'),
        key: 'channel.name',
        mobile: true,
        sortable: false,
        displayFunction: item => item.channel?.name || '-',
        onClick: (item: DeployHistory) => openOneChannel(item),
      },
      {
        label: t('event'),
        key: 'event_type',
        mobile: true,
        sortable: false,
        displayFunction: item => item.event_type === 'removed' ? t('removed') : t('assigned'),
      },
      {
        label: t('date'),
        key: 'deployed_at',
        mobile: true,
        sortable: true,
        displayFunction: item => formatDate(item.deployed_at),
      },
      {
        label: t('by'),
        key: 'created_by',
        mobile: false,
        displayFunction: item => item.user?.email || '-',
      },
    ]
  }

  const channelColumns: TableColumn[] = [
    {
      label: t('bundle-number'),
      key: 'version.name',
      mobile: true,
      sortable: true,
      displayFunction: item => item.version.name,
      onClick: (item: DeployHistory) => openOneVersion(item),
    },
    {
      label: t('deploy-date'),
      key: 'deployed_at',
      mobile: true,
      sortable: true,
      displayFunction: item => formatDate(item.deployed_at),
    },
    {
      label: t('deployed-by'),
      key: 'created_by',
      mobile: false,
      displayFunction: item => item.user?.email || '-',
    },
  ]

  if (!canRollbackBundle.value)
    return channelColumns

  channelColumns.push(
    {
      label: t('action'),
      key: 'rollback',
      mobile: true,
      class: 'text-center',
      displayFunction: (item) => {
        if (item.version?.deleted) {
          return t('bundle-deleted')
        }
        return isCurrentVersion(item) ? t('current') : t('rollback')
      },
      onClick: (item) => {
        if (!isCurrentVersion(item) && !item.version?.deleted) {
          handleRollback(item)
        }
        else {
          toast.error(t('cannot-rollback-to-current-version'))
        }
      },
    },
  )
  return channelColumns
})

async function openOneVersion(item: DeployHistory) {
  router.push(`/app/${props.appId}/bundle/${item.version_id}`)
}

async function fetchDeployHistory() {
  loading.value = true
  try {
    deployHistory.value.length = 0
    await fetchCurrentVersion()
    members.value = await organizationStore.getMembers()

    if (isBundleMode.value) {
      // Bundle mode: fetch both assignments and removals
      await fetchBundleHistory()
    }
    else {
      // Channel mode: only fetch assignments from deploy_history
      await fetchChannelHistory()
    }
  }
  catch (error) {
    console.error('Error fetching deploy history:', error)
    toast.error(t('error-fetching-deploy-history'))
  }
  finally {
    loading.value = false
  }
}

async function fetchChannelHistory() {
  const selectFields = `
    *,
    version:version_id (
      id,
      name,
      app_id,
      created_at,
      deleted
    )
  `

  let query = supabase
    .from('deploy_history')
    .select(selectFields, { count: 'exact' })
    .eq('app_id', props.appId)
    .order(Object.keys(sort.value)[0], { ascending: Object.values(sort.value)[0] === 'asc' })

  if (props.channelId) {
    query = query.eq('channel_id', props.channelId)
  }

  if (search.value) {
    query = query.like('version.name', `%${search.value}%`)
  }

  const { data, error, count } = await query
    .range((page.value - 1) * pageSize.value, page.value * pageSize.value - 1)

  if (error) {
    console.error('Error fetching deploy history:', error)
    toast.error(t('error-fetching-deploy-history'))
    return
  }

  const rows = (data ?? []) as unknown as DeployHistory[]
  const filteredData = rows.filter(item => item?.version !== null)

  deployHistory.value = filteredData
  for (const item of deployHistory.value) {
    item.event_type = 'assigned'
    const member = members.value.find(m => m.uid === item.created_by)
    if (member) {
      item.user = member
    }
  }

  total.value = count ?? 0
}

async function fetchBundleHistory() {
  // In bundle mode, we need to fetch both:
  // 1. Assignments from deploy_history (when this bundle was assigned to channels)
  // 2. Removals from audit_logs (when this bundle was replaced by another bundle)

  const bundleId = props.bundleId!

  // Fetch assignments from deploy_history
  const assignmentSelectFields = `
    *,
    version:version_id (
      id,
      name,
      app_id,
      created_at,
      deleted
    ),
    channel:channel_id (
      id,
      name
    )
  `

  const { data: assignmentData, error: assignmentError } = await supabase
    .from('deploy_history')
    .select(assignmentSelectFields)
    .eq('app_id', props.appId)
    .eq('version_id', bundleId)

  if (assignmentError) {
    console.error('Error fetching deploy history:', assignmentError)
    toast.error(t('error-fetching-deploy-history'))
    return
  }

  // Fetch removals from audit_logs
  // When a channel's version changes FROM this bundle TO another bundle, that's a removal
  const { data: auditData, error: auditError } = await supabase
    .from('audit_logs')
    .select('*')
    .eq('table_name', 'channels')
    .eq('operation', 'UPDATE')
    .contains('changed_fields', ['version'])

  if (auditError) {
    console.error('Error fetching audit logs:', auditError)
    // Don't fail completely, just show assignments
  }

  // Process assignments
  const assignments: DeployHistory[] = ((assignmentData ?? []) as unknown as DeployHistory[])
    .filter(item => item?.channel != null)
    .map((item) => {
      const member = members.value.find(m => m.uid === item.created_by)
      return {
        ...item,
        event_type: 'assigned' as const,
        user: member || null,
      }
    })

  // Process removals from audit_logs
  const removals: DeployHistory[] = []
  if (auditData) {
    // We need to fetch channel names for the removals
    const channelIds = new Set<number>()

    for (const audit of auditData) {
      const oldRecord = audit.old_record as Record<string, unknown> | null
      if (oldRecord && oldRecord.version === bundleId && oldRecord.app_id === props.appId) {
        channelIds.add(Number(audit.record_id))
      }
    }

    // Fetch channel names
    const channelMap = new Map<number, { id: number, name: string }>()
    if (channelIds.size > 0) {
      const { data: channelsData } = await supabase
        .from('channels')
        .select('id, name')
        .in('id', Array.from(channelIds))

      if (channelsData) {
        for (const ch of channelsData) {
          channelMap.set(ch.id, { id: ch.id, name: ch.name })
        }
      }
    }

    // Build removal entries
    for (const audit of auditData) {
      const oldRecord = audit.old_record as Record<string, unknown> | null
      if (oldRecord && oldRecord.version === bundleId && oldRecord.app_id === props.appId) {
        const channelId = Number(audit.record_id)
        const channel = channelMap.get(channelId)
        const member = members.value.find(m => m.uid === audit.user_id)

        // Apply search filter if present
        if (search.value && channel) {
          if (!channel.name.toLowerCase().includes(search.value.toLowerCase())) {
            continue
          }
        }

        removals.push({
          id: Number(audit.id),
          version_id: bundleId,
          app_id: props.appId,
          channel_id: channelId,
          deployed_at: audit.created_at,
          version: {
            id: bundleId,
            name: '',
            app_id: props.appId,
            created_at: '',
          },
          channel: channel || { id: channelId, name: `Channel #${channelId}` },
          created_by: audit.user_id || '',
          user: member || null,
          event_type: 'removed' as const,
        })
      }
    }
  }

  // Merge and sort by date
  const allHistory = [...assignments, ...removals]
  const sortDir = Object.values(sort.value)[0]

  allHistory.sort((a, b) => {
    const aDate = new Date(a.deployed_at).getTime()
    const bDate = new Date(b.deployed_at).getTime()
    return sortDir === 'asc' ? aDate - bDate : bDate - aDate
  })

  // Apply pagination
  const startIdx = (page.value - 1) * pageSize.value
  const endIdx = startIdx + pageSize.value

  deployHistory.value = allHistory.slice(startIdx, endIdx)
  total.value = allHistory.length
}

async function handleRollback(item: DeployHistory) {
  if (isBundleMode.value)
    return

  if (!props.channelId)
    return

  const channelId = props.channelId

  if (!canRollbackBundle.value) {
    toast.error(t('no-permission'))
    return
  }

  if (item.version?.deleted) {
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
              .update({ version: item.version_id })
              .eq('id', channelId)

            if (error) {
              console.error('Error rolling back version:', error)
              toast.error(t(channelUpdatePackageErrorKey(error) ?? 'error-rollback'))
              return
            }

            toast.success(t('rollback-success'))
            currentVersionId.value = item.version_id
            fetchDeployHistory()
          }
          catch (error) {
            console.error('Error rolling back version:', error)
            toast.error(t(channelUpdatePackageErrorKey(error) ?? 'error-rollback'))
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

watch([() => props.channelId, () => props.bundleId, () => props.appId], () => {
  fetchDeployHistory()
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
    :element-list="deployHistory"
    @update:search="search = $event"
    @update:current-page="page = $event"
    @update:columns="columns = $event"
    @reload="fetchDeployHistory"
  />
</template>
