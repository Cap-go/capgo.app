<script setup lang="ts">
import type { Ref } from 'vue'
import type { Tab, TableColumn } from '~/components/comp_def'
import { computedAsync } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconLock from '~icons/heroicons/lock-closed'
import IconTrash from '~icons/heroicons/trash'
import IconUsers from '~icons/heroicons/users'
import DataTable from '~/components/DataTable.vue'
import SearchInput from '~/components/forms/SearchInput.vue'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { getRbacRoleI18nKey, useOrganizationStore } from '~/stores/organization'

interface Group {
  id: string
  org_id: string
  name: string
  description: string | null
  created_at: string
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

interface OrgApp {
  id: string
  app_id: string
  name: string | null
}

interface OrgMember {
  user_id: string
  email: string
  is_invite?: boolean
  is_tmp?: boolean
}

interface GroupMember {
  user_id: string
  email: string
}

interface RoleOption {
  id: string
  name: string
  description: string
}

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)
const displayStore = useDisplayStore()
const dialogStore = useDialogV2Store()

const groupId = computed(() => (route.params as { id: string }).id)
const isCreateMode = computed(() => groupId.value === 'new')

const canShow = computed(() =>
  !!currentOrganization.value?.gid,
)

const isPermissionLoading = ref(false)
const canManage = computedAsync(async () => {
  if (!currentOrganization.value?.gid)
    return false
  return await checkPermissions('org.update_user_roles', { orgId: currentOrganization.value.gid })
}, false, { evaluating: isPermissionLoading })

const isLoading = ref(false)
const isSubmitting = ref(false)
const showAppDropdown = ref(false)

const group = ref<Group | null>(null)
const editName = ref('')
const editDescription = ref('')

const roles = ref<Role[]>([])
const roleBindings = ref<RoleBinding[]>([])
const apps = ref<OrgApp[]>([])
const orgMembers = ref<OrgMember[]>([])
const groupMembers = ref<GroupMember[]>([])

const selectedOrgRole = ref('')
const selectedMemberIds = ref<string[]>([])
const modalMemberSearch = ref('')

// Pending app bindings: appId → roleName (tracks unsaved changes)
const pendingAppBindings = ref<Record<string, string>>({})

const activeSection = ref('access')

// Member DataTable state
const memberSearch = ref('')
const memberCurrentPage = ref(1)
const memberColumns: Ref<TableColumn[]> = ref<TableColumn[]>([])

const sectionTabs = computed<Tab[]>(() => {
  const tabs: Tab[] = [
    { label: 'app-access-control', key: 'access', icon: IconLock },
  ]
  if (!isCreateMode.value)
    tabs.push({ label: 'members', key: 'members', icon: IconUsers })
  return tabs
})

const orgRoles = computed(() => roles.value.filter((role: Role) => role.scope_type === 'org'))
const appRoles = computed(() => roles.value.filter((role: Role) => role.scope_type === 'app'))

const appById = computed(() => new Map(apps.value.map((app: OrgApp) => [app.id, app])))

const groupBindings = computed(() =>
  roleBindings.value.filter((b: RoleBinding) => b.principal_type === 'group' && b.principal_id === groupId.value),
)

const groupOrgBinding = computed(() =>
  groupBindings.value.find((b: RoleBinding) => b.scope_type === 'org'),
)

const groupAppBindings = computed(() =>
  groupBindings.value.filter((b: RoleBinding) => b.scope_type === 'app' && !!b.app_id),
)

const availableMembersToAdd = computed(() => {
  const alreadyInGroup = new Set(groupMembers.value.map((m: GroupMember) => m.user_id))
  return orgMembers.value.filter((m: OrgMember) => !alreadyInGroup.has(m.user_id))
})

const orgRoleOptions = computed<RoleOption[]>(() =>
  orgRoles.value
    .filter((role: Role) => role.name !== 'org_super_admin')
    .map((role: Role) => ({
      id: role.id,
      name: role.name,
      description: getRoleDisplayName(role.name),
    })),
)

const appRoleOptions = computed<RoleOption[]>(() =>
  appRoles.value.map((role: Role) => ({
    id: role.id,
    name: role.name,
    description: getRoleDisplayName(role.name),
  })),
)

const rolesWithInheritedAppAccess = new Set(['org_admin', 'org_super_admin'])
const showAppAccessForm = computed(() => !!selectedOrgRole.value && !rolesWithInheritedAppAccess.has(selectedOrgRole.value))

const selectedAppIds = computed(() => Object.keys(pendingAppBindings.value))

const filteredAvailableMembers = computed(() => {
  if (!modalMemberSearch.value)
    return availableMembersToAdd.value
  const q = modalMemberSearch.value.toLowerCase()
  return availableMembersToAdd.value.filter((m: OrgMember) => m.email.toLowerCase().includes(q))
})

const filteredGroupMembers = computed(() => {
  if (!memberSearch.value)
    return groupMembers.value
  const q = memberSearch.value.toLowerCase()
  return groupMembers.value.filter((m: GroupMember) => m.email.toLowerCase().includes(q))
})

const memberDynamicColumns = computed<TableColumn[]>(() => [
  { key: 'email', label: t('email'), head: true, mobile: true, sortable: true },
  {
    key: 'actions',
    label: t('actions'),
    mobile: true,
    actions: [
      {
        icon: IconTrash,
        title: t('remove'),
        onClick: (member: GroupMember) => removeMemberFromGroup(member.user_id),
      },
    ],
  },
])

watch(memberDynamicColumns, (cols: TableColumn[]) => {
  memberColumns.value = cols
}, { immediate: true })

const UUID_REGEX = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

watch(groupId, async (id: string) => {
  if (!id)
    return
  if (id === 'new') {
    group.value = null
    editName.value = ''
    editDescription.value = ''
    selectedOrgRole.value = ''
    pendingAppBindings.value = {}
    displayStore.NavTitle = t('create-group')
    await Promise.all([fetchRoles(), fetchApps()])
  }
  else if (UUID_REGEX.test(id)) {
    await loadAll()
  }
  else {
    group.value = null
    editName.value = ''
    editDescription.value = ''
    selectedOrgRole.value = ''
    pendingAppBindings.value = {}
    displayStore.NavTitle = t('groups')
    toast.error(t('invalid-group-id'))
  }
}, { immediate: true })

async function loadAll() {
  isLoading.value = true
  try {
    await Promise.all([
      fetchGroup(),
      fetchRoles(),
      fetchRoleBindings(),
      fetchApps(),
      fetchOrgMembers(),
    ])
    // fetchGroupMembers needs orgMembers loaded first to resolve emails
    await fetchGroupMembers()
  }
  catch (error) {
    console.error('Error loading group data:', error)
    toast.error(t('error-loading-group-data'))
  }
  finally {
    isLoading.value = false
  }
}

async function fetchGroup() {
  const { data, error } = await supabase
    .from('groups')
    .select('id, org_id, name, description, created_at')
    .eq('id', groupId.value)
    .single()

  if (error)
    throw error

  group.value = data as Group
  editName.value = data.name
  editDescription.value = data.description ?? ''
  displayStore.NavTitle = data.name
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
  if (!group.value?.org_id && !currentOrganization.value?.gid)
    return

  const orgId = group.value?.org_id ?? currentOrganization.value?.gid ?? ''
  const { data, error } = await supabase
    .from('role_bindings')
    .select('id, principal_type, principal_id, scope_type, app_id, role_id, roles(name)')
    .eq('org_id', orgId)
    .eq('principal_type', 'group')
    .eq('principal_id', groupId.value)

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

  selectedOrgRole.value = groupOrgBinding.value?.role_name ?? ''

  // Reset pending app bindings to match current DB state
  const map: Record<string, string> = {}
  groupAppBindings.value.forEach((b: RoleBinding) => {
    if (b.app_id)
      map[b.app_id] = b.role_name
  })
  pendingAppBindings.value = map
}

async function fetchApps() {
  const orgId = group.value?.org_id ?? currentOrganization.value?.gid
  if (!orgId)
    return

  const { data, error } = await supabase
    .from('apps')
    .select('id, app_id, name')
    .eq('owner_org', orgId)
    .order('name', { ascending: true })

  if (error)
    throw error

  apps.value = (data || []).filter((app): app is OrgApp => !!app.id)
}

async function fetchOrgMembers() {
  const orgId = group.value?.org_id ?? currentOrganization.value?.gid
  if (!orgId)
    return

  const { data, error } = await supabase
    .rpc('get_org_members_rbac', { p_org_id: orgId })

  if (error)
    throw error

  orgMembers.value = ((data || []) as OrgMember[]).filter((m: OrgMember) => !m.is_tmp)
}

async function fetchGroupMembers() {
  const id = group.value?.id
  if (!id)
    return

  const { data, error } = await supabase
    .from('group_members')
    .select('user_id')
    .eq('group_id', id)

  if (error)
    throw error

  // users table RLS only allows selecting your own row, so we resolve
  // emails from the already-loaded orgMembers list instead of joining
  const emailMap = new Map(orgMembers.value.map((m: OrgMember) => [m.user_id, m.email]))
  groupMembers.value = (data || []).map((row: { user_id: string }) => ({
    user_id: row.user_id,
    email: emailMap.get(row.user_id) || row.user_id,
  }))
}

function getRoleDisplayName(roleName: string): string {
  const i18nKey = getRbacRoleI18nKey(roleName)
  return i18nKey ? t(i18nKey) : roleName.replaceAll('_', ' ')
}

function getAppName(appId: string) {
  const app = appById.value.get(appId)
  return app ? (app.name || app.app_id) : appId
}

function getRoleIdByName(roleName: string) {
  return roles.value.find((r: Role) => r.name === roleName)?.id
}

function toggleApp(appId: string) {
  if (appId in pendingAppBindings.value) {
    const updated = { ...pendingAppBindings.value }
    delete updated[appId]
    pendingAppBindings.value = updated
  }
  else {
    pendingAppBindings.value = { ...pendingAppBindings.value, [appId]: '' }
  }
}

function setAppRole(appId: string, roleName: string) {
  pendingAppBindings.value = { ...pendingAppBindings.value, [appId]: roleName }
}

function onAppRoleChange(appId: string, event: Event) {
  setAppRole(appId, (event.target as HTMLSelectElement).value)
}

async function createGroup() {
  if (!editName.value.trim()) {
    toast.error(t('please-enter-group-name'))
    return
  }

  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return

  isSubmitting.value = true
  try {
    const { data, error } = await supabase
      .from('groups')
      .insert({
        org_id: orgId,
        name: editName.value.trim(),
        description: editDescription.value.trim() || null,
        created_by: main.user?.id || null,
      })
      .select('id, org_id, name, description, created_at')
      .single()

    if (error)
      throw error

    group.value = data as Group

    try {
      await saveGroupOrgRole()
    }
    catch (roleError) {
      console.error('Error saving group org role:', roleError)
      toast.warning(t('error-saving-group-role'))
    }

    try {
      await syncAppBindings()
    }
    catch (bindingError) {
      console.error('Error syncing app bindings:', bindingError)
      toast.warning(t('error-syncing-app-bindings'))
    }
  }
  catch (error) {
    console.error('Error creating group:', error)
    toast.error(t('error-creating-group'))
    return
  }
  finally {
    isSubmitting.value = false
  }

  toast.success(t('group-created'))
  try {
    await fetchOrgMembers()
    openAddMembersModal()
    await dialogStore.onDialogDismiss()
  }
  catch (memberError) {
    console.error('Error opening add-members modal:', memberError)
  }
  await router.replace('/settings/organization/groups')
}

async function saveGroup() {
  if (!group.value || !editName.value.trim()) {
    toast.error(t('please-enter-group-name'))
    return
  }

  isSubmitting.value = true
  try {
    // Save group info
    const { error: groupError } = await supabase
      .from('groups')
      .update({
        name: editName.value.trim(),
        description: editDescription.value.trim() || null,
      })
      .eq('id', group.value.id)

    if (groupError)
      throw groupError

    // Save org role
    await saveGroupOrgRole()

    // Save app bindings (diff)
    await syncAppBindings()

    group.value.name = editName.value.trim()
    group.value.description = editDescription.value.trim() || null
    displayStore.NavTitle = group.value.name
    toast.success(t('group-updated'))
  }
  catch (error) {
    console.error('Error saving group:', error)
    toast.error(t('error-updating-group'))
  }
  finally {
    isSubmitting.value = false
  }
}

function requireCurrentUserId() {
  if (!main.user?.id)
    throw new Error('No user')

  return main.user.id
}

function requireRoleId(roleName: string) {
  const roleId = getRoleIdByName(roleName)
  if (!roleId)
    throw new Error('Role not found')

  return roleId
}

async function deleteRoleBinding(bindingId: string) {
  const { error } = await supabase.from('role_bindings').delete().eq('id', bindingId)
  if (error)
    throw error
}

async function updateRoleBinding(bindingId: string, roleId: string) {
  const { error } = await supabase.from('role_bindings').update({ role_id: roleId }).eq('id', bindingId)
  if (error)
    throw error
}

async function insertGroupRoleBinding(roleId: string, scopeType: 'org' | 'app', appId: string | null) {
  const { error } = await supabase.from('role_bindings').insert({
    principal_type: 'group',
    principal_id: group.value!.id,
    role_id: roleId,
    scope_type: scopeType,
    org_id: group.value!.org_id,
    app_id: appId,
    channel_id: null,
    granted_by: requireCurrentUserId(),
    reason: null,
    is_direct: true,
  })
  if (error)
    throw error
}

async function saveGroupOrgRole() {
  const existing = groupOrgBinding.value
  const targetRoleName = selectedOrgRole.value

  if (!targetRoleName) {
    if (existing)
      await deleteRoleBinding(existing.id)
    return
  }

  if (existing?.role_name === targetRoleName)
    return

  const roleId = requireRoleId(targetRoleName)
  if (existing) {
    await updateRoleBinding(existing.id, roleId)
    return
  }

  await insertGroupRoleBinding(roleId, 'org', null)
}

async function deleteRemovedAppBindings(existing: RoleBinding[], pending: Record<string, string>) {
  for (const binding of existing) {
    if (!binding.app_id || !(binding.app_id in pending))
      await deleteRoleBinding(binding.id)
  }
}

async function upsertGroupAppBinding(existing: RoleBinding[], appId: string, roleName: string) {
  const roleId = getRoleIdByName(roleName)
  if (!roleId)
    return

  const existingBinding = existing.find((binding: RoleBinding) => binding.app_id === appId)
  if (!existingBinding) {
    await insertGroupRoleBinding(roleId, 'app', appId)
    return
  }

  if (existingBinding.role_name !== roleName)
    await updateRoleBinding(existingBinding.id, roleId)
}

async function upsertPendingAppBindings(existing: RoleBinding[], pending: Record<string, string>) {
  for (const [appId, roleName] of Object.entries(pending)) {
    if (roleName)
      await upsertGroupAppBinding(existing, appId, roleName)
  }
}

async function syncAppBindings() {
  const existing = groupAppBindings.value
  const pending = pendingAppBindings.value

  await deleteRemovedAppBindings(existing, pending)
  await upsertPendingAppBindings(existing, pending)
  await fetchRoleBindings()
}

function openAddMembersModal() {
  selectedMemberIds.value = []
  modalMemberSearch.value = ''
  dialogStore.openDialog({
    id: 'add-group-members',
    title: t('add-members'),
    description: '',
    size: 'xl',
    buttons: [
      { text: t('button-cancel'), role: 'cancel' },
      {
        text: t('add-members'),
        role: 'primary',
        preventClose: true,
        handler: addSelectedMembersToGroup,
      },
    ],
  })
}

async function addSelectedMembersToGroup() {
  if (selectedMemberIds.value.length === 0) {
    toast.error(t('please-select-member'))
    return false
  }

  isSubmitting.value = true
  try {
    const rows = selectedMemberIds.value.map((userId: string) => ({
      group_id: group.value!.id,
      user_id: userId,
      added_by: main.user?.id || null,
    }))

    const { error } = await supabase
      .from('group_members')
      .upsert(rows, { onConflict: 'group_id,user_id', ignoreDuplicates: true })

    if (error)
      throw error

    selectedMemberIds.value = []
    await fetchGroupMembers()
    toast.success(t('member-added'))
    dialogStore.closeDialog()
    return true
  }
  catch (error) {
    console.error('Error adding members:', error)
    toast.error(t('error-adding-member'))
    return false
  }
  finally {
    isSubmitting.value = false
  }
}

async function removeMemberFromGroup(userId: string) {
  isSubmitting.value = true
  try {
    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', group.value!.id)
      .eq('user_id', userId)

    if (error)
      throw error

    await fetchGroupMembers()
    toast.success(t('member-deleted'))
  }
  catch (error) {
    console.error('Error removing member:', error)
    toast.error(t('cannot-delete-member'))
  }
  finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div>
    <div v-if="isPermissionLoading" class="flex items-center justify-center py-12">
      <span class="d-loading d-loading-spinner d-loading-lg" />
    </div>

    <div
      v-else-if="!canShow || !canManage"
      class="flex flex-col bg-white border shadow-lg md:p-6 md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900"
    >
      <h2 class="text-2xl font-bold dark:text-white text-slate-800">
        {{ t('groups') }}
      </h2>
      <p class="mt-2 text-sm text-slate-500">
        {{ t('groups-unavailable') }}
      </p>
    </div>

    <div v-else>
      <div class="flex flex-col bg-white border shadow-lg md:p-8 md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
        <!-- Back link -->
        <div class="mb-6">
          <RouterLink
            to="/settings/organization/groups"
            class="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            <span>←</span>
            <span>{{ t('groups') }}</span>
          </RouterLink>
        </div>

        <div v-if="isLoading" class="flex items-center justify-center py-12">
          <span class="d-loading d-loading-spinner d-loading-lg" />
        </div>

        <!-- Create / Edit mode -->
        <template v-else-if="isCreateMode || group">
          <h1 class="mb-6 text-2xl font-bold dark:text-white text-slate-800">
            {{ isCreateMode ? t('create-group') : group!.name }}
          </h1>

          <!-- Group information -->
          <section class="mb-8">
            <h2 class="mb-4 text-sm font-semibold uppercase text-slate-500">
              {{ t('group-information') }}
            </h2>
            <div class="space-y-4 max-w-lg">
              <div>
                <label for="group-edit-name" class="block mb-1 text-sm font-medium dark:text-white text-slate-800">
                  {{ t('name') }} *
                </label>
                <input
                  id="group-edit-name"
                  v-model="editName"
                  type="text"
                  class="w-full d-input d-input-bordered"
                  :placeholder="t('group-name')"
                  :aria-label="t('name')"
                  :disabled="isSubmitting"
                >
              </div>
              <div>
                <label for="group-edit-description" class="block mb-1 text-sm font-medium dark:text-white text-slate-800">
                  {{ t('description') }}
                </label>
                <input
                  id="group-edit-description"
                  v-model="editDescription"
                  type="text"
                  class="w-full d-input d-input-bordered"
                  :placeholder="t('description')"
                  :aria-label="t('description')"
                  :disabled="isSubmitting"
                >
              </div>
            </div>
          </section>

          <!-- Organization role -->
          <section class="mb-8">
            <h2 class="mb-4 text-sm font-semibold uppercase text-slate-500">
              {{ t('organization') }}
            </h2>
            <p class="mb-3 text-sm text-slate-500">
              {{ t('select-user-role') }}
            </p>
            <div class="space-y-2">
              <label class="flex items-center gap-3 cursor-pointer">
                <input
                  v-model="selectedOrgRole"
                  type="radio"
                  class="d-radio d-radio-primary d-radio-sm"
                  name="org-role"
                  value=""
                  :disabled="isSubmitting"
                >
                <span class="text-sm text-slate-600 dark:text-slate-400">{{ t('none') }}</span>
              </label>
              <label
                v-for="role in orgRoleOptions"
                :key="role.id"
                class="flex items-center gap-3 cursor-pointer"
              >
                <input
                  v-model="selectedOrgRole"
                  type="radio"
                  class="d-radio d-radio-primary d-radio-sm"
                  name="org-role"
                  :value="role.name"
                  :disabled="isSubmitting"
                >
                <span class="text-sm font-medium dark:text-white text-slate-800">{{ role.description }}</span>
              </label>
            </div>
          </section>

          <!-- Pill sub-tabs -->
          <div class="flex border-b border-slate-200 dark:border-slate-700 -mx-8 px-8 mt-2">
            <button
              v-for="tab in sectionTabs"
              :key="tab.key"
              class="flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors"
              :class="activeSection === tab.key
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'"
              @click="activeSection = tab.key"
            >
              <component :is="tab.icon" class="w-4 h-4" />
              {{ t(tab.label) }}
            </button>
          </div>

          <!-- App access tab -->
          <div v-if="activeSection === 'access'" class="pt-6 pb-2">
            <div v-if="!showAppAccessForm" class="py-8 text-center text-sm text-slate-500">
              {{ t('app-access-member-only') }}
            </div>

            <template v-else>
              <div class="flex justify-end mb-4">
                <div class="relative">
                  <button
                    class="d-btn d-btn-sm d-btn-outline gap-2"
                    :disabled="isSubmitting"
                    @click="showAppDropdown = !showAppDropdown"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                    </svg>
                    {{ t('add-app') }}
                  </button>

                  <div v-if="showAppDropdown" class="fixed inset-0 z-10" @click="showAppDropdown = false" />
                  <div
                    v-if="showAppDropdown"
                    class="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-gray-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg min-w-[240px] max-h-60 overflow-y-auto"
                  >
                    <div v-if="apps.length === 0" class="px-4 py-3 text-sm text-slate-500">
                      {{ t('no-apps') }}
                    </div>
                    <label
                      v-for="app in apps"
                      :key="app.id"
                      class="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                      <input
                        type="checkbox"
                        class="d-checkbox d-checkbox-sm d-checkbox-primary"
                        :checked="app.id in pendingAppBindings"
                        @change="toggleApp(app.id)"
                      >
                      <div>
                        <div class="text-sm font-medium dark:text-white text-slate-800">
                          {{ app.name || app.app_id }}
                        </div>
                        <div v-if="app.name" class="text-xs text-slate-500">
                          {{ app.app_id }}
                        </div>
                      </div>
                    </label>
                  </div>
                </div>
              </div>

              <div v-if="selectedAppIds.length === 0" class="py-8 text-center text-sm text-slate-500">
                {{ t('app-access-none') }}
              </div>
              <div v-else class="border rounded-lg border-slate-200 dark:border-slate-700 overflow-hidden">
                <div
                  v-for="appId in selectedAppIds"
                  :key="appId"
                  class="flex items-center gap-4 px-4 py-2.5 border-b last:border-0 border-slate-100 dark:border-slate-700 hover:bg-slate-50/50 dark:hover:bg-slate-700/20 transition-colors"
                >
                  <span class="flex-1 text-sm font-medium dark:text-white text-slate-800 truncate">
                    {{ getAppName(appId) }}
                  </span>
                  <label :for="`group-app-role-${appId}`" class="sr-only">
                    {{ getAppName(appId) }} {{ t('select-role') }}
                  </label>
                  <select
                    :id="`group-app-role-${appId}`"
                    class="d-select d-select-sm d-select-bordered"
                    :value="pendingAppBindings[appId] || ''"
                    :aria-label="t('select-role')"
                    :disabled="isSubmitting"
                    @change="onAppRoleChange(appId, $event)"
                  >
                    <option value="">
                      {{ t('select-role') }}
                    </option>
                    <option v-for="role in appRoleOptions" :key="role.id" :value="role.name">
                      {{ role.description }}
                    </option>
                  </select>
                  <button
                    class="d-btn d-btn-xs d-btn-ghost text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0"
                    :disabled="isSubmitting"
                    @click="toggleApp(appId)"
                  >
                    <IconTrash class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </template>
          </div>

          <!-- Members tab -->
          <div v-if="activeSection === 'members'">
            <DataTable
              v-model:columns="memberColumns"
              v-model:current-page="memberCurrentPage"
              v-model:search="memberSearch"
              :show-add="true"
              :total="filteredGroupMembers.length"
              :element-list="filteredGroupMembers"
              :search-placeholder="t('search-members')"
              :is-loading="isLoading"
              :auto-reload="false"
              @reload="fetchGroupMembers"
              @add="openAddMembersModal"
            />
          </div>

          <!-- Global Save / Create button -->
          <div class="flex justify-end mt-8 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button
              class="d-btn d-btn-primary"
              :disabled="isSubmitting || !editName.trim()"
              @click="isCreateMode ? createGroup() : saveGroup()"
            >
              <span v-if="isSubmitting" class="d-loading d-loading-spinner d-loading-xs" />
              {{ isCreateMode ? t('create') : t('save') }}
            </button>
          </div>
        </template>

        <div v-else class="py-12 text-center text-slate-500">
          {{ t('group-not-found') }}
        </div>
      </div>
    </div>
  </div>

  <Teleport
    v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'add-group-members'"
    defer
    to="#dialog-v2-content"
  >
    <div class="w-full space-y-3">
      <SearchInput
        v-model="modalMemberSearch"
        :placeholder="t('search-members')"
        class="d-input-sm"
      />
      <div v-if="availableMembersToAdd.length === 0" class="py-4 text-sm text-center text-slate-500">
        {{ t('no-members-to-add') }}
      </div>
      <template v-else>
        <div class="border rounded-lg border-slate-200 dark:border-slate-700 overflow-hidden max-h-80 overflow-y-auto">
          <div v-if="filteredAvailableMembers.length === 0" class="px-4 py-6 text-sm text-center text-slate-500">
            {{ t('no-results') }}
          </div>
          <label
            v-for="member in filteredAvailableMembers"
            :key="member.user_id"
            class="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors border-b border-slate-100 dark:border-slate-700 last:border-0"
          >
            <input
              v-model="selectedMemberIds"
              type="checkbox"
              class="d-checkbox d-checkbox-sm d-checkbox-primary"
              :value="member.user_id"
            >
            <span class="text-sm dark:text-white text-slate-800">{{ member.email }}</span>
          </label>
        </div>
        <p v-if="selectedMemberIds.length > 0" class="text-xs text-slate-500">
          {{ selectedMemberIds.length }} {{ t('selected') }}
        </p>
      </template>
    </div>
  </Teleport>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
