<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import type { Database } from '~/types/supabase.types'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconShield from '~icons/heroicons/shield-check'
import IconTrash from '~icons/heroicons/trash'
import IconWrench from '~icons/heroicons/wrench'
import RoleCapabilitiesHint from '~/components/forms/RoleCapabilitiesHint.vue'
import ChannelAccessPanel from '~/components/permissions/ChannelAccessPanel.vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { formatDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { getRbacRoleI18nKey } from '~/stores/organization'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{
  appId: string
}>()

interface RoleBinding {
  id: string
  principal_type: 'user' | 'group'
  principal_id: string
  role_id: string
  role_name: string
  role_description: string
  scope_type: 'app' | 'channel'
  org_id: string
  app_id: string | null
  channel_id: string | null
  channel_row_id?: number | null
  channel_name?: string | null
  granted_at: string
  granted_by: string
  expires_at: string | null
  reason: string | null
  is_direct: boolean
  principal_name: string
  user_email: string | null
  group_name: string | null
}

type Element = RoleBinding

interface Role {
  id: string
  name: string
  scope_type: 'app' | 'channel'
  description: string | null
  priority_rank: number
}

interface ChannelSummary {
  id: number
  rbac_id: string
  name: string
}

interface PrincipalOption {
  type: 'user' | 'group'
  id: string
  label: string
  detail: string
}

const { t } = useI18n()
const dialogStore = useDialogV2Store()
const supabase = useSupabase()
const app = ref<Database['public']['Tables']['apps']['Row']>()
const total = ref(0)
const search = ref('')
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const elements = ref<Element[]>([])
const isLoading = ref(true)
const currentPage = ref(1)
const canUpdateUserRoles = ref(false)
const selectedRole = ref('')
const selectedRoleScope = ref<'app' | 'channel'>('app')
const selectedPrincipal = ref<Element | null>(null)
const roles = ref<Role[]>([])
const channels = ref<ChannelSummary[]>([])
const principalOptions = ref<PrincipalOption[]>([])
const assignAccessForm = ref({
  principal_type: 'user' as 'user' | 'group',
  principal_id: '',
  scope_type: 'app' as 'app' | 'channel',
  role_name: '',
  channel_id: '',
})

const appRoleOptions = computed(() => roles.value.filter(role => role.scope_type === 'app'))
const channelRoleOptions = computed(() => roles.value.filter(role => role.scope_type === 'channel'))
const selectedRoleOptions = computed(() => selectedRoleScope.value === 'channel' ? channelRoleOptions.value : appRoleOptions.value)
const assignRoleOptions = computed(() => assignAccessForm.value.scope_type === 'channel' ? channelRoleOptions.value : appRoleOptions.value)
const channelByRbacId = computed(() => new Map(channels.value.map(channel => [channel.rbac_id, channel])))
const filteredPrincipalOptions = computed(() => principalOptions.value.filter(option => option.type === assignAccessForm.value.principal_type))
const canAssignAppScope = computed(() => appRoleOptions.value.length > 0)
const canAssignChannelScope = computed(() => channels.value.length > 0 && channelRoleOptions.value.length > 0)
const hasValidAssignRole = computed(() => assignRoleOptions.value.some(role => role.name === assignAccessForm.value.role_name))
const isAssignAccessFormValid = computed(() => {
  return !!assignAccessForm.value.principal_id
    && !!assignAccessForm.value.role_name
    && hasValidAssignRole.value
    && (assignAccessForm.value.scope_type !== 'app' || canAssignAppScope.value)
    && (assignAccessForm.value.scope_type !== 'channel' || canAssignChannelScope.value)
    && (assignAccessForm.value.scope_type === 'app' || !!assignAccessForm.value.channel_id)
})
const selectControlClass = 'd-select d-select-bordered min-h-11 w-full rounded-md bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/30 dark:bg-slate-900 dark:text-slate-100'

function getDefaultAssignRoleName(scopeType: 'app' | 'channel') {
  const options = scopeType === 'channel' ? channelRoleOptions.value : appRoleOptions.value
  return options[0]?.name ?? ''
}

function resetAssignScopeDefaults(scopeType: 'app' | 'channel') {
  assignAccessForm.value.role_name = getDefaultAssignRoleName(scopeType)
  assignAccessForm.value.channel_id = scopeType === 'channel' ? (channels.value[0]?.id?.toString() ?? '') : ''
}

async function loadAppInfo() {
  try {
    const { data: dataApp } = await supabase
      .from('apps')
      .select()
      .eq('app_id', props.appId)
      .single()
    app.value = dataApp ?? undefined
    canUpdateUserRoles.value = false

    // Check app.update_user_roles permission
    if (app.value?.app_id) {
      canUpdateUserRoles.value = await checkPermissions('app.update_user_roles', { appId: app.value.app_id })
    }
  }
  catch (error) {
    console.error('Error loading app info:', error)
    app.value = undefined
    canUpdateUserRoles.value = false
  }
}

function getRoleDisplayName(roleName: string): string {
  const i18nKey = getRbacRoleI18nKey(roleName)
  return i18nKey ? t(i18nKey) : roleName.replaceAll('_', ' ')
}

function getPrincipalName(principalType: 'user' | 'group', principalId: string) {
  return principalOptions.value.find(option => option.type === principalType && option.id === principalId)?.label ?? principalId
}

async function loadAccessReferenceData() {
  if (!app.value?.owner_org || !app.value?.app_id)
    return

  const [rolesResult, channelsResult] = await Promise.all([
    supabase
      .from('roles')
      .select('id, name, scope_type, description, priority_rank')
      .in('scope_type', ['app', 'channel'])
      .eq('is_assignable', true)
      .order('priority_rank', { ascending: false }),
    supabase
      .from('channels')
      .select('id, rbac_id, name')
      .eq('app_id', app.value.app_id)
      .order('name', { ascending: true }),
  ])

  if (rolesResult.error)
    throw rolesResult.error
  if (channelsResult.error)
    throw channelsResult.error

  roles.value = ((rolesResult.data || []) as Role[])
    .filter(role => role.scope_type === 'app' || role.scope_type === 'channel')
  channels.value = (channelsResult.data || []) as ChannelSummary[]

  const nextPrincipalOptions: PrincipalOption[] = []
  if (canUpdateUserRoles.value) {
    const { data: principals, error: principalsError } = await invokeCapgoApi(`private/role_bindings/app/${app.value.id}/principals`, { method: 'GET' })

    if (principalsError) {
      console.error('Error loading assignable principals for app access:', principalsError)
    }
    else {
      for (const principal of (principals || []) as PrincipalOption[]) {
        if (principal.type !== 'user' && principal.type !== 'group')
          continue

        nextPrincipalOptions.push({
          type: principal.type,
          id: principal.id,
          label: principal.label || principal.id,
          detail: principal.detail || (principal.type === 'user' ? t('user') : t('group')),
        })
      }
    }
  }

  principalOptions.value = nextPrincipalOptions.sort((a, b) => a.label.localeCompare(b.label))
}

function normalizeAppBindings(data: any[]): Element[] {
  return data.map(binding => ({
    ...binding,
    scope_type: 'app',
    org_id: app.value?.owner_org ?? binding.org_id,
    app_id: app.value?.id ?? binding.app_id ?? null,
    channel_id: null,
    channel_row_id: null,
    channel_name: null,
    principal_name: binding.principal_name || getPrincipalName(binding.principal_type, binding.principal_id),
    role_description: binding.role_description ?? null,
  }))
}

function normalizeChannelBindings(data: any[]): Element[] {
  return data.map((binding) => {
    const channel = channelByRbacId.value.get(binding.channel_id)
    return {
      id: binding.id,
      principal_type: binding.principal_type,
      principal_id: binding.principal_id,
      role_id: binding.role_id,
      role_name: binding.role_name ?? binding.roles?.name ?? '',
      role_description: binding.role_description ?? binding.roles?.description ?? null,
      scope_type: 'channel',
      org_id: binding.org_id,
      app_id: binding.app_id,
      channel_id: binding.channel_id,
      channel_row_id: channel?.id ?? null,
      channel_name: channel?.name ?? binding.channel_id,
      granted_at: binding.granted_at,
      granted_by: binding.granted_by,
      expires_at: binding.expires_at,
      reason: binding.reason,
      is_direct: binding.is_direct,
      principal_name: binding.principal_name || getPrincipalName(binding.principal_type, binding.principal_id),
      user_email: binding.principal_type === 'user' ? (binding.principal_name || getPrincipalName(binding.principal_type, binding.principal_id)) : null,
      group_name: binding.principal_type === 'group' ? (binding.principal_name || getPrincipalName(binding.principal_type, binding.principal_id)) : null,
    } as Element
  })
}

async function fetchData() {
  if (!props.appId || !app.value?.owner_org || !app.value?.id)
    return

  isLoading.value = true
  try {
    // Use the secure RPC to fetch access
    const { data, error } = await supabase
      .rpc('get_app_access_rbac', {
        p_app_id: app.value.id,
      })

    if (error)
      throw error

    const { data: channelBindings, error: channelBindingsError } = await invokeCapgoApi(`private/role_bindings/app/${app.value.id}/channel`, { method: 'GET' })

    if (channelBindingsError)
      throw channelBindingsError

    const nextElements = [
      ...normalizeAppBindings((data as any[]) || []),
      ...normalizeChannelBindings((channelBindings as any[]) || []),
    ]

    elements.value = nextElements
    total.value = nextElements.length
  }
  catch (error: unknown) {
    console.error('Error fetching role bindings:', error)
    toast.error(t('error-fetching-role-bindings'))
  }
  finally {
    isLoading.value = false
  }
}

async function openChannelPermissions(element: Element) {
  if (!canUpdateUserRoles.value)
    return
  if (element.scope_type !== 'app')
    return

  selectedPrincipal.value = element

  dialogStore.openDialog({
    id: 'channel-permissions',
    title: t('channel-permissions-title'),
    description: t('channel-permissions-description'),
    size: 'xl',
    buttons: [
      {
        text: t('close'),
        role: 'cancel',
      },
    ],
  })
}

function openAssignAccessModal() {
  const defaultScope = canAssignChannelScope.value ? 'channel' : 'app'
  const defaultPrincipalType = principalOptions.value.some(option => option.type === 'user') ? 'user' : 'group'
  const defaultPrincipalId = principalOptions.value.find(option => option.type === defaultPrincipalType)?.id ?? ''

  assignAccessForm.value = {
    principal_type: defaultPrincipalType,
    principal_id: defaultPrincipalId,
    scope_type: defaultScope,
    role_name: getDefaultAssignRoleName(defaultScope),
    channel_id: defaultScope === 'channel' ? (channels.value[0]?.id?.toString() ?? '') : '',
  }

  dialogStore.openDialog({
    id: 'assign-access-role',
    title: t('assign-access-role'),
    description: t('assign-access-role-description'),
    size: 'lg',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('assign'),
        role: 'primary',
        preventClose: true,
        handler: assignAccessRole,
      },
    ],
  })
}

async function assignAccessRole() {
  if (!canUpdateUserRoles.value || !app.value?.owner_org || !app.value?.id) {
    toast.error(t('no-permission'))
    return false
  }

  if (!isAssignAccessFormValid.value) {
    toast.error(t('please-select-permission'))
    return false
  }

  isLoading.value = true
  try {
    const selectedChannel = assignAccessForm.value.scope_type === 'channel'
      ? channels.value.find(channel => channel.id.toString() === assignAccessForm.value.channel_id)
      : undefined

    if (assignAccessForm.value.scope_type === 'channel' && !selectedChannel?.rbac_id) {
      toast.error(t('please-select-channel'))
      return false
    }

    const { error } = await invokeCapgoApi('private/role_bindings', {
      method: 'POST',
      body: {
        principal_type: assignAccessForm.value.principal_type,
        principal_id: assignAccessForm.value.principal_id,
        role_name: assignAccessForm.value.role_name,
        scope_type: assignAccessForm.value.scope_type,
        org_id: app.value.owner_org,
        app_id: app.value.id,
        channel_id: assignAccessForm.value.scope_type === 'channel' ? selectedChannel!.rbac_id : null,
        reason: null,
      },
    })

    if (error)
      throw error

    toast.success(t('role-assigned'))
    dialogStore.closeDialog()
    await refreshData()
    return true
  }
  catch (error: unknown) {
    console.error('Error assigning access role:', error)
    if (getErrorMessage(error)?.includes('already has a role')) {
      toast.error(t('error-role-already-assigned'))
    }
    else {
      toast.error(t('error-assigning-role'))
    }
    return false
  }
  finally {
    isLoading.value = false
  }
}

async function showRoleModal(element: Element): Promise<string | undefined> {
  selectedRole.value = element.role_name
  selectedRoleScope.value = element.scope_type

  dialogStore.openDialog({
    id: 'select-access-role',
    title: element.scope_type === 'channel' ? t('select-channel-role') : t('select-app-role'),
    description: t('select-role'),
    size: 'lg',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        role: 'primary',
        handler: () => {
          if (!selectedRole.value) {
            toast.error(t('please-select-permission'))
            return false
          }
          return true
        },
      },
    ],
  })

  const wasDismissed = await dialogStore.onDialogDismiss()
  if (wasDismissed) {
    return undefined
  }
  const roleSnapshot = selectedRole.value
  return roleSnapshot
}

async function changeUserRole(element: Element) {
  if (!canUpdateUserRoles.value)
    return

  const newRoleName = await showRoleModal(element)

  if (!newRoleName || newRoleName === element.role_name) {
    return
  }

  const isValidRole = selectedRoleOptions.value.some(option => option.name === newRoleName)
  if (!isValidRole) {
    return
  }

  isLoading.value = true
  try {
    const { error: updateError } = await invokeCapgoApi(`private/role_bindings/${element.id}`, {
      method: 'PATCH',
      body: { role_name: newRoleName },
    })

    if (updateError)
      throw updateError

    toast.success(t('permission-changed'))
    await refreshData()
  }
  catch (error: unknown) {
    console.error('Error changing role:', error)
    toast.error(t('error-assigning-role'))
  }
  finally {
    isLoading.value = false
  }
}

async function deleteElement(element: Element) {
  dialogStore.openDialog({
    title: t('remove-role'),
    description: t('remove-role-confirm'),
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

  isLoading.value = true
  try {
    const { error } = await invokeCapgoApi(`private/role_bindings/${element.id}`, {
      method: 'DELETE',
    })

    if (error)
      throw error

    toast.success(t('role-removed'))
    await refreshData()
  }
  catch (error: unknown) {
    console.error('Error removing role:', error)
    toast.error(t('error-removing-role'))
  }
  finally {
    isLoading.value = false
  }
}

async function reload() {
  await refreshData()
}

async function refreshData() {
  isLoading.value = true
  try {
    await loadAppInfo()
    if (app.value?.owner_org) {
      await loadAccessReferenceData()
      await fetchData()
    }
  }
  catch (error) {
    console.error('Error in refreshData:', error)
  }
  finally {
    isLoading.value = false
  }
}

watch(() => props.appId, async () => {
  await refreshData()
}, { immediate: true })

// Filter items based on the search query
const filteredElements = computed(() => {
  if (!search.value)
    return elements.value

  const searchLower = search.value.toLowerCase()
  return elements.value.filter((element) => {
    return element.principal_name?.toLowerCase().includes(searchLower)
      || element.user_email?.toLowerCase().includes(searchLower)
      || element.channel_name?.toLowerCase().includes(searchLower)
      || element.scope_type?.toLowerCase().includes(searchLower)
      || element.role_name?.toLowerCase().includes(searchLower)
      || getRoleDisplayName(element.role_name)?.toLowerCase().includes(searchLower)
  })
})

// Define columns
const dynamicColumns = computed<TableColumn[]>(() => {
  const baseColumns: TableColumn[] = [
    {
      key: 'principal_name',
      label: t('name'),
      sortable: true,
    },
    {
      key: 'principal_type',
      label: t('type'),
      sortable: true,
      displayFunction: (row: Element) => row.principal_type === 'group' ? t('group') : t('user'),
    },
    {
      key: 'role_name',
      label: t('role'),
      sortable: true,
      displayFunction: (row: Element) => getRoleDisplayName(row.role_name),
    },
    {
      key: 'scope_type',
      label: t('scope'),
      sortable: true,
      displayFunction: (row: Element) => row.scope_type === 'channel'
        ? `${t('channel')} - ${row.channel_name || row.channel_id || '-'}`
        : t('app'),
    },
    {
      key: 'granted_at',
      label: t('granted-at'),
      sortable: true,
      displayFunction: (row: Element) => formatDate(row.granted_at),
    },
  ]

  // Add action columns only if the user has permission
  if (canUpdateUserRoles.value) {
    baseColumns.push({
      key: 'actions',
      label: t('actions'),
      actions: [
        {
          icon: IconShield,
          visible: (row: Element) => row.scope_type === 'app',
          title: t('channel-permissions-title'),
          onClick: (row: Element) => openChannelPermissions(row),
        },
        {
          icon: IconWrench,
          title: t('edit-role'),
          onClick: (row: Element) => changeUserRole(row),
        },
        {
          icon: IconTrash,
          title: t('remove'),
          onClick: (row: Element) => deleteElement(row),
        },
      ],
    })
  }

  return baseColumns
})

// Sync dynamic columns with the columns ref
watch(dynamicColumns, (newCols) => {
  columns.value = newCols
}, { immediate: true })

watch(
  () => assignAccessForm.value.principal_type,
  () => {
    assignAccessForm.value.principal_id = filteredPrincipalOptions.value[0]?.id ?? ''
  },
)

watch(
  () => assignAccessForm.value.scope_type,
  scopeType => resetAssignScopeDefaults(scopeType),
  { flush: 'sync' },
)
</script>

<template>
  <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
    <DataTable
      v-model:columns="columns"
      v-model:current-page="currentPage"
      v-model:search="search"
      :total="filteredElements.length"
      :show-add="canUpdateUserRoles"
      add-button-test-id="assign-access-role"
      :element-list="filteredElements"
      :is-loading="isLoading"
      :search-placeholder="t('search-role-bindings')"
      :auto-reload="false"
      @add="openAssignAccessModal()"
      @reload="reload()"
      @reset="refreshData()"
    />
  </div>

  <!-- Teleport for the role selection modal -->
  <Teleport
    v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'select-access-role'"
    defer
    to="#dialog-v2-content"
  >
    <div class="w-full">
      <div class="rounded-md border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/60">
        <div class="space-y-2">
          <div v-for="option in selectedRoleOptions" :key="option.id" class="form-control">
            <div class="flex items-center gap-2">
              <label
                class="flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md border p-3 text-left transition-colors"
                :class="selectedRole === option.name
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30 dark:bg-primary/10'
                  : 'border-slate-200 bg-white hover:border-primary/60 dark:border-slate-700 dark:bg-transparent'"
              >
                <input
                  v-model="selectedRole"
                  type="radio"
                  name="access-role"
                  :value="option.name"
                  class="radio radio-primary radio-sm"
                >
                <span class="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {{ getRoleDisplayName(option.name) }}
                </span>
              </label>
              <RoleCapabilitiesHint :role-name="option.name" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <Teleport
    v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'assign-access-role'"
    defer
    to="#dialog-v2-content"
  >
    <div class="space-y-5">
      <div class="rounded-md border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/60">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium uppercase text-slate-500 dark:text-slate-400">
            {{ t('assign-access-selected-scope') }}
          </span>
          <span class="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary dark:bg-primary/20">
            {{ assignAccessForm.scope_type === 'channel' ? t('app-access-scope-channel') : t('app-access-scope-app') }}
          </span>
        </div>
        <p class="mt-2 text-sm leading-5 text-slate-600 dark:text-slate-300">
          {{ assignAccessForm.scope_type === 'channel' ? t('assign-access-scope-channel-description') : t('assign-access-scope-app-description') }}
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div class="form-control">
          <label for="assign-principal-type" class="label">
            <span class="label-text">{{ t('principal-type') }}</span>
          </label>
          <select
            id="assign-principal-type"
            v-model="assignAccessForm.principal_type"
            :class="selectControlClass"
          >
            <option value="user">
              {{ t('user') }}
            </option>
            <option value="group">
              {{ t('group') }}
            </option>
          </select>
        </div>

        <div class="form-control">
          <label for="assign-principal" class="label">
            <span class="label-text">
              {{ assignAccessForm.principal_type === 'user' ? t('select-user') : t('select-group') }}
            </span>
          </label>
          <select
            id="assign-principal"
            v-model="assignAccessForm.principal_id"
            :class="selectControlClass"
            aria-describedby="assign-principal-helper"
          >
            <option value="">
              {{ assignAccessForm.principal_type === 'user' ? t('select-user') : t('select-group') }}
            </option>
            <option v-for="option in filteredPrincipalOptions" :key="`${option.type}:${option.id}`" :value="option.id">
              {{ option.label }}
            </option>
          </select>
          <p id="assign-principal-helper" class="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('assign-access-principal-helper') }}
          </p>
        </div>
      </div>

      <fieldset class="space-y-2" aria-describedby="assign-scope-helper">
        <legend class="text-sm font-medium text-slate-700 dark:text-slate-200">
          {{ t('scope') }}
        </legend>
        <div class="grid gap-3 md:grid-cols-2">
          <label
            class="flex min-h-16 items-start gap-3 rounded-md border p-3 text-sm transition-colors"
            :class="[
              assignAccessForm.scope_type === 'app'
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30 dark:bg-primary/10'
                : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-950',
              canAssignAppScope ? 'cursor-pointer hover:border-primary/60' : 'cursor-not-allowed opacity-60',
            ]"
          >
            <input
              v-model="assignAccessForm.scope_type"
              type="radio"
              name="assign-scope"
              value="app"
              class="radio radio-primary radio-sm mt-0.5"
              :disabled="!canAssignAppScope"
            >
            <span class="min-w-0">
              <span class="block font-medium text-slate-900 dark:text-slate-100">
                {{ t('app-access-scope-app') }}
              </span>
              <span class="mt-1 block leading-5 text-slate-500 dark:text-slate-400">
                {{ t('assign-access-scope-app-description') }}
              </span>
            </span>
          </label>
          <label
            class="flex min-h-16 items-start gap-3 rounded-md border p-3 text-sm transition-colors"
            :class="[
              assignAccessForm.scope_type === 'channel'
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30 dark:bg-primary/10'
                : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-950',
              canAssignChannelScope ? 'cursor-pointer hover:border-primary/60' : 'cursor-not-allowed opacity-60',
            ]"
          >
            <input
              v-model="assignAccessForm.scope_type"
              type="radio"
              name="assign-scope"
              value="channel"
              class="radio radio-primary radio-sm mt-0.5"
              :disabled="!canAssignChannelScope"
            >
            <span class="min-w-0">
              <span class="block font-medium text-slate-900 dark:text-slate-100">
                {{ t('app-access-scope-channel') }}
              </span>
              <span class="mt-1 block leading-5 text-slate-500 dark:text-slate-400">
                {{ t('assign-access-scope-channel-description') }}
              </span>
            </span>
          </label>
        </div>
        <p id="assign-scope-helper" class="text-xs leading-5 text-slate-500 dark:text-slate-400">
          {{ canAssignChannelScope ? t('assign-access-scope-helper') : t('assign-access-no-channel-scope') }}
        </p>
      </fieldset>

      <div class="grid gap-4 rounded-md border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-900/40 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div v-if="assignAccessForm.scope_type === 'channel'" class="form-control">
          <label for="assign-channel" class="label">
            <span class="label-text">{{ t('channel') }}</span>
          </label>
          <select
            id="assign-channel"
            v-model="assignAccessForm.channel_id"
            :class="selectControlClass"
            aria-describedby="assign-channel-helper"
          >
            <option value="">
              {{ t('select-channel') }}
            </option>
            <option v-for="channel in channels" :key="channel.id" :value="channel.id.toString()">
              {{ channel.name }}
            </option>
          </select>
          <p id="assign-channel-helper" class="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('assign-access-channel-helper') }}
          </p>
        </div>

        <div class="form-control" :class="{ 'md:col-span-2': assignAccessForm.scope_type !== 'channel' }">
          <label for="assign-role" class="label">
            <span class="label-text">{{ assignAccessForm.scope_type === 'channel' ? t('select-channel-role') : t('select-app-role') }}</span>
          </label>
          <div class="flex items-center gap-2">
            <select
              id="assign-role"
              v-model="assignAccessForm.role_name"
              :class="selectControlClass"
              class="min-w-0 flex-1"
              aria-describedby="assign-role-helper"
            >
              <option value="">
                {{ t('select-role') }}
              </option>
              <option v-for="role in assignRoleOptions" :key="role.id" :value="role.name">
                {{ getRoleDisplayName(role.name) }}
              </option>
            </select>
            <RoleCapabilitiesHint
              v-if="assignAccessForm.role_name"
              :role-name="assignAccessForm.role_name"
            />
          </div>
          <p id="assign-role-helper" class="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('assign-access-role-helper') }}
          </p>
        </div>
      </div>
    </div>
  </Teleport>

  <Teleport
    v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'channel-permissions'"
    defer
    to="#dialog-v2-content"
  >
    <ChannelAccessPanel
      v-if="selectedPrincipal"
      :app-id="props.appId"
      :app-uuid="app?.id ?? ''"
      :org-id="app?.owner_org ?? ''"
      :principal-type="selectedPrincipal.principal_type"
      :principal-id="selectedPrincipal.principal_id"
      :principal-name="selectedPrincipal.principal_name || '-'"
      :inherited-role-name="selectedPrincipal.role_name"
      @changed="refreshData()"
    />
  </Teleport>
</template>
