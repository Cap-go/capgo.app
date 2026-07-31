<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '~/components/comp_def'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconTrash from '~icons/heroicons/trash'
import IconWrench from '~icons/heroicons/wrench'
import DataTable from '~/components/DataTable.vue'
import { formatDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { getRbacRoleI18nKey } from '~/stores/organization'

interface Group {
  id: string
  org_id: string
  name: string
  description: string | null
  created_at: string
}

interface GroupRow extends Group {
  org_role: string | null
}

interface Role {
  id: string
  name: string
  scope_type: string
  description: string | null
  priority_rank: number
}

interface RoleBinding {
  id: string
  principal_type: string
  principal_id: string
  role_name: string
  scope_type: string
  app_id: string | null
}

const props = defineProps<{
  orgId: string
  canManage: boolean
}>()

const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()

const isLoading = ref(false)
const isSubmitting = ref(false)
const groups = ref<Group[]>([])
const roles = ref<Role[]>([])
const roleBindings = ref<RoleBinding[]>([])

const search = ref('')
const currentPage = ref(1)
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])

const groupRows = computed<GroupRow[]>(() =>
  groups.value.map((group: Group) => ({
    ...group,
    org_role: getGroupOrgRoleName(group.id),
  })),
)

const filteredGroups = computed(() => {
  if (!search.value)
    return groupRows.value
  const searchLower = search.value.toLowerCase()
  return groupRows.value.filter((group: GroupRow) =>
    group.name.toLowerCase().includes(searchLower)
    || (group.description || '').toLowerCase().includes(searchLower)
    || getRoleDisplayName(group.org_role || '').toLowerCase().includes(searchLower),
  )
})

const dynamicColumns = computed<TableColumn[]>(() => {
  const tableColumns: TableColumn[] = [
    {
      label: t('name'),
      key: 'name',
      mobile: true,
      sortable: true,
      head: true,
    },
    {
      label: t('description'),
      key: 'description',
      mobile: true,
      displayFunction: (group: GroupRow) => group.description || t('none'),
    },
    {
      label: t('role'),
      key: 'org_role',
      mobile: true,
      displayFunction: (group: GroupRow) => group.org_role ? getRoleDisplayName(group.org_role) : t('none'),
    },
    {
      label: t('granted-at'),
      key: 'created_at',
      mobile: true,
      displayFunction: (group: GroupRow) => formatDate(group.created_at),
    },
  ]

  if (props.canManage) {
    tableColumns.push({
      key: 'actions',
      label: t('actions'),
      mobile: true,
      actions: [
        {
          icon: IconWrench,
          title: t('manage'),
          onClick: (group: GroupRow) => router.push(`/settings/organization/groups/${group.id}`),
        },
        {
          icon: IconTrash,
          title: t('remove'),
          onClick: (group: GroupRow) => deleteGroup(group),
        },
      ],
    })
  }

  return tableColumns
})

watch(dynamicColumns, (newColumns: TableColumn[]) => {
  columns.value = newColumns
}, { immediate: true })

watch(() => props.orgId, async (orgId: string) => {
  if (!orgId) {
    groups.value = []
    return
  }
  search.value = ''
  currentPage.value = 1
  await refreshData()
}, { immediate: true })

async function refreshData() {
  if (!props.orgId)
    return

  isLoading.value = true
  try {
    await Promise.all([
      fetchGroups(),
      fetchRoles(),
      fetchRoleBindings(),
    ])
  }
  catch (error) {
    console.error('Error loading groups:', error)
    toast.error(t('error-fetching-groups'))
  }
  finally {
    isLoading.value = false
  }
}

async function fetchGroups() {
  const { data, error } = await supabase
    .from('groups')
    .select('id, org_id, name, description, created_at')
    .eq('org_id', props.orgId)
    .order('name', { ascending: true })

  if (error)
    throw error

  groups.value = (Array.isArray(data) ? data : []) as Group[]
}

async function fetchRoles() {
  const { data, error } = await supabase
    .from('roles')
    .select('id, name, scope_type, description, priority_rank')
    .eq('is_assignable', true)
    .in('scope_type', ['org', 'app'])
    .order('priority_rank', { ascending: false })

  if (error)
    throw error

  roles.value = (data || []) as Role[]
}

async function fetchRoleBindings() {
  const { data, error } = await supabase
    .from('role_bindings')
    .select('id, principal_type, principal_id, scope_type, app_id, role_id, roles(name)')
    .eq('org_id', props.orgId)
    .eq('principal_type', 'group')

  if (error)
    throw error

  roleBindings.value = ((data || []) as any[]).map(row => ({
    id: row.id,
    principal_type: row.principal_type,
    principal_id: row.principal_id,
    scope_type: row.scope_type,
    app_id: row.app_id,
    role_name: row.roles?.name || '',
  }))
}

function getRoleDisplayName(roleName: string): string {
  const i18nKey = getRbacRoleI18nKey(roleName)
  return i18nKey ? t(i18nKey) : roleName.replaceAll('_', ' ')
}

function getGroupOrgRoleName(groupId: string): string | null {
  const binding = roleBindings.value.find((b: RoleBinding) =>
    b.principal_type === 'group'
    && b.principal_id === groupId
    && b.scope_type === 'org',
  )
  return binding?.role_name || null
}

function navigateToCreate() {
  if (!props.canManage)
    return
  router.push('/settings/organization/groups/new')
}

async function deleteGroup(group: GroupRow) {
  if (!props.canManage)
    return

  dialogStore.openDialog({
    id: 'delete-group-confirmation',
    title: t('remove-group'),
    description: t('remove-group-confirmation'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('remove'),
        role: 'danger',
      },
    ],
  })

  const wasCanceled = await dialogStore.onDialogDismiss()
  if (wasCanceled || dialogStore.lastButtonRole !== 'danger')
    return

  isSubmitting.value = true
  try {
    const { error } = await supabase.rpc('delete_group_with_bindings', { group_id: group.id })

    if (error)
      throw error

    toast.success(t('group-removed'))
    await refreshData()
  }
  catch (error) {
    console.error('Error deleting group:', error)
    toast.error(t('error-removing-group'))
  }
  finally {
    isSubmitting.value = false
  }
}

async function reload() {
  await refreshData()
}
</script>

<template>
  <div>
    <div class="flex flex-col h-full pb-8 overflow-hidden overflow-y-auto bg-white border shadow-lg md:p-8 md:pb-0 max-h-fit grow md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <div class="flex justify-between w-full mb-5 ml-2 md:ml-0">
        <h2 class="text-2xl font-bold dark:text-white text-slate-800">
          {{ t('groups') }}
        </h2>
      </div>
      <DataTable
        v-model:columns="columns"
        v-model:current-page="currentPage"
        v-model:search="search"
        :show-add="props.canManage"
        :total="filteredGroups.length"
        :element-list="filteredGroups"
        :search-placeholder="t('search-groups')"
        :is-loading="isLoading"
        :auto-reload="false"
        @reload="reload"
        @reset="refreshData"
        @add="navigateToCreate"
      />
    </div>
  </div>
</template>
