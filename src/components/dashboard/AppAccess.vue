<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '~/components/comp_def'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconLock from '~icons/heroicons/lock-closed'
import IconPlus from '~icons/heroicons/plus'
import IconShield from '~icons/heroicons/shield-check'
import IconTrash from '~icons/heroicons/trash'
import IconWrench from '~icons/heroicons/wrench'
import DataTable from '~/components/DataTable.vue'
import RoleSelect from '~/components/forms/RoleSelect.vue'
import SearchInput from '~/components/forms/SearchInput.vue'
import RoleSelectionModal from '~/components/modals/RoleSelectionModal.vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { formatLocalDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { getErrorMessage } from '~/utils/errors'

interface Role {
  id: string
  name: string
  scope_type: string
  description: string
  priority_rank: number
}

interface RoleBinding {
  id: string
  principal_type: string
  principal_id: string
  role_id: string
  role_name: string
  role_description: string
  scope_type: string
  org_id: string
  app_id: string | null
  channel_id: string | null
  granted_at: string
  granted_by: string
  expires_at: string | null
  reason: string | null
  is_direct: boolean
  principal_email?: string
  group_name?: string
}

interface Props {
  appId: string
}

const props = defineProps<Props>()

const { t } = useI18n()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()
const isLoading = ref(false)
const roleBindings = ref<RoleBinding[]>([])
const availableAppRoles = ref<Role[]>([])
const search = ref('')
const currentPage = ref(1)
const canAssignRoles = ref(false)
const ownerOrg = ref<string>('')

// Assign role modal state
const isAssignRoleModalOpen = ref(false)
const assignRoleForm = ref({
  principal_type: 'user' as 'user' | 'group',
  principal_id: '',
  role_name: '',
  reason: '',
})

const availableMembers = ref<{ user_id: string, email: string }[]>([])
const availableGroups = ref<{ id: string, name: string }[]>([])

const columns: Ref<TableColumn[]> = ref<TableColumn[]>([
  {
    key: 'principal',
    sortable: false,
    label: t('principal'),
  },
  {
    key: 'role',
    sortable: false,
    label: t('role'),
  },
  {
    key: 'granted_at',
    sortable: false,
    label: t('granted-at'),
  },
  {
    key: 'actions',
    sortable: false,
    label: t('actions'),
  },
])

const filteredBindings = computed(() => {
  let filtered = roleBindings.value

  if (search.value) {
    const searchLower = search.value.toLowerCase()
    filtered = filtered.filter((binding) => {
      return binding.principal_email?.toLowerCase().includes(searchLower)
        || binding.group_name?.toLowerCase().includes(searchLower)
        || binding.role_name.toLowerCase().includes(searchLower)
    })
  }

  return filtered
})

const isAssignRoleFormValid = computed(() => {
  return assignRoleForm.value.principal_id !== ''
    && assignRoleForm.value.role_name !== ''
})

const isEditRoleModalOpen = ref(false)
const editRoleBinding = ref<RoleBinding | null>(null)
const editRoleName = ref('')
const isEditingRole = ref(false)

async function fetchAppDetails() {
  if (!props.appId)
    return

  try {
    const { data, error } = await supabase
      .from('apps')
      .select('owner_org')
      .eq('app_id', props.appId)
      .single()

    if (error)
      throw error

    ownerOrg.value = data?.owner_org || ''
  }
  catch (error: unknown) {
    console.error('Error fetching app details:', error)
  }
}

async function fetchAppRoleBindings() {
  if (!props.appId || !ownerOrg.value)
    return

  isLoading.value = true
  try {
    const { data, error } = await invokeCapgoApi(`private/role_bindings/${ownerOrg.value}`, {
      method: 'GET',
    })

    if (error)
      throw error

    // Filter only app-level bindings for this app
    const appBindings = data.filter((b: RoleBinding) =>
      b.scope_type === 'app' && b.app_id === props.appId)

    const userIds = new Set<string>()
    const groupIds = new Set<string>()

    for (const binding of appBindings) {
      if (binding.principal_type === 'user') {
        userIds.add(binding.principal_id)
      }
      else if (binding.principal_type === 'group') {
        groupIds.add(binding.principal_id)
      }
    }

    interface UserEmailRow {
      id: string
      email: string | null
    }

    interface GroupNameRow {
      id: string
      name: string | null
    }

    const usersPromise = userIds.size
      ? supabase
          .from('users')
          .select('id, email')
          .in('id', Array.from(userIds))
      : Promise.resolve({ data: [] as UserEmailRow[], error: null })

    const groupsPromise = groupIds.size
      ? supabase
          .from('groups')
          .select('id, name')
          .in('id', Array.from(groupIds))
      : Promise.resolve({ data: [] as GroupNameRow[], error: null })

    const [usersResult, groupsResult] = await Promise.all([usersPromise, groupsPromise])

    if (usersResult.error) {
      console.error('Error fetching users for role bindings:', usersResult.error)
    }

    if (groupsResult.error) {
      console.error('Error fetching groups for role bindings:', groupsResult.error)
    }

    const userEmailById = new Map<string, string>()
    for (const user of usersResult.data ?? []) {
      userEmailById.set(user.id, user.email || user.id)
    }

    const groupNameById = new Map<string, string>()
    for (const group of groupsResult.data ?? []) {
      groupNameById.set(group.id, group.name || group.id)
    }

    const enrichedBindings = appBindings.map((binding: RoleBinding) => {
      const principal_email = binding.principal_type === 'user'
        ? userEmailById.get(binding.principal_id) || binding.principal_id
        : ''

      const group_name = binding.principal_type === 'group'
        ? groupNameById.get(binding.principal_id) || binding.principal_id
        : ''

      return {
        ...binding,
        principal_email,
        group_name,
      }
    })

    roleBindings.value = enrichedBindings
  }
  catch (error: unknown) {
    console.error('Error fetching app role bindings:', error)
    toast.error(t('error-fetching-role-bindings'))
  }
  finally {
    isLoading.value = false
  }
}

async function fetchAvailableAppRoles() {
  try {
    const { data, error } = await supabase
      .from('roles')
      .select('id, name, scope_type, description, priority_rank')
      .eq('scope_type', 'app')
      .eq('is_assignable', true)
      .order('priority_rank')

    if (error)
      throw error

    availableAppRoles.value = (data || []) as Role[]
  }
  catch (error: unknown) {
    console.error('Error fetching app roles:', error)
  }
}

async function fetchAvailableMembers() {
  if (!ownerOrg.value)
    return

  try {
    const { data, error } = await supabase
      .from('org_users')
      .select(`
        user_id,
        users!inner(email)
      `)
      .eq('org_id', ownerOrg.value)

    if (error)
      throw error

    availableMembers.value = data.map(m => ({
      user_id: m.user_id,
      email: m.users.email,
    })) as any
  }
  catch (error: unknown) {
    console.error('Error fetching members:', error)
  }
}

async function fetchAvailableGroups() {
  if (!ownerOrg.value)
    return

  try {
    const { data, error } = await invokeCapgoApi(`private/groups/${ownerOrg.value}`, {
      method: 'GET',
    })

    if (error)
      throw error

    availableGroups.value = data || []
  }
  catch (error: unknown) {
    console.error('Error fetching groups:', error)
  }
}

function openAssignRoleModal() {
  assignRoleForm.value = {
    principal_type: 'user',
    principal_id: '',
    role_name: '',
    reason: '',
  }
  isAssignRoleModalOpen.value = true
}

function openEditRoleModal(binding: RoleBinding) {
  editRoleBinding.value = binding
  editRoleName.value = binding.role_name
  isEditRoleModalOpen.value = true
}

async function assignRole() {
  if (!isAssignRoleFormValid.value || !ownerOrg.value || !props.appId)
    return

  isLoading.value = true
  try {
    const { error } = await invokeCapgoApi('private/role_bindings', {
      method: 'POST',
      body: {
        principal_type: assignRoleForm.value.principal_type,
        principal_id: assignRoleForm.value.principal_id,
        role_name: assignRoleForm.value.role_name,
        scope_type: 'app',
        org_id: ownerOrg.value,
        app_id: props.appId,
        channel_id: null,
        reason: assignRoleForm.value.reason || null,
      },
    })

    if (error)
      throw error

    toast.success(t('role-assigned'))
    isAssignRoleModalOpen.value = false
    await fetchAppRoleBindings()
  }
  catch (error: unknown) {
    console.error('Error assigning role:', error)
    if (getErrorMessage(error)?.includes('already has a role')) {
      toast.error(t('error-role-already-assigned'))
    }
    else {
      toast.error(t('error-assigning-role'))
    }
  }
  finally {
    isLoading.value = false
  }
}

async function handleEditRoleConfirm(newRoleName: string) {
  if (!editRoleBinding.value) {
    return
  }

  if (newRoleName === editRoleBinding.value.role_name) {
    return
  }

  isEditingRole.value = true
  try {
    const { error: updateError } = await invokeCapgoApi(`private/role_bindings/${editRoleBinding.value.id}`, {
      method: 'PATCH',
      body: { role_name: newRoleName },
    })

    if (updateError)
      throw updateError

    toast.success(t('permission-changed'))
    await fetchAppRoleBindings()
  }
  catch (error: unknown) {
    console.error('Error changing role:', error)
    toast.error(t('error-assigning-role'))
  }
  finally {
    isEditingRole.value = false
  }
}

async function removeRoleBinding(bindingId: string) {
  dialogStore.openDialog({
    title: t('remove-role'),
    description: t('remove-role-confirm'),
    buttons: [
      { text: t('cancel'), role: 'cancel' },
      { text: t('remove'), role: 'danger' },
    ],
  })
  const wasCanceled = await dialogStore.onDialogDismiss()
  if (wasCanceled || dialogStore.lastButtonRole !== 'danger')
    return

  isLoading.value = true
  try {
    const { error } = await invokeCapgoApi(`private/role_bindings/${bindingId}`, {
      method: 'DELETE',
    })

    if (error)
      throw error

    toast.success(t('role-removed'))
    await fetchAppRoleBindings()
  }
  catch (error: unknown) {
    console.error('Error removing role:', error)
    toast.error(t('error-removing-role'))
  }
  finally {
    isLoading.value = false
  }
}

async function loadAppAccess() {
  await fetchAppDetails()
  if (props.appId) {
    try {
      canAssignRoles.value = await checkPermissions('app.update_user_roles', { appId: props.appId })
    }
    catch (error: unknown) {
      console.error('Error checking app role permissions:', error)
      canAssignRoles.value = false
    }
  }
  else {
    canAssignRoles.value = false
  }
  await Promise.all([
    fetchAppRoleBindings(),
    fetchAvailableAppRoles(),
    fetchAvailableMembers(),
    fetchAvailableGroups(),
  ])
}

watch(() => props.appId, async () => {
  await loadAppAccess()
})

onMounted(async () => {
  await loadAppAccess()
})
</script>

<template>
  <div class="w-full px-3 py-2">
    <!-- Header -->
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-2xl font-bold">
          <IconLock class="inline-block mr-2 size-6" />
          {{ t('app-access-control') }}
        </h1>
        <p class="text-sm text-gray-600">
          {{ t('app-access-control-description') }}
        </p>
      </div>
      <button
        v-if="canAssignRoles"
        class="d-btn d-btn-primary"
        @click="openAssignRoleModal"
      >
        <IconPlus class="size-5" />
        {{ t('assign-role') }}
      </button>
    </div>

    <!-- Search -->
    <div class="mb-4">
      <SearchInput
        v-model="search"
        :placeholder="t('search-role-bindings')"
        class="max-w-md"
      />
    </div>

    <!-- Role bindings table -->
    <DataTable
      :columns="columns"
      :element-list="filteredBindings"
      :total="filteredBindings.length"
      :is-loading="isLoading"
      :current-page="currentPage"
      @update:current-page="currentPage = $event"
    >
      <template #principal="{ row }">
        <div class="flex flex-col">
          <span class="font-medium">
            {{ row.principal_type === 'user' ? row.principal_email : row.group_name }}
          </span>
          <span class="text-xs text-gray-500">
            {{ row.principal_type }}
          </span>
        </div>
      </template>

      <template #role="{ row }">
        <div class="flex items-center gap-2">
          <IconShield class="size-5 text-primary" />
          <div class="flex flex-col">
            <span class="font-medium">{{ row.role_name }}</span>
            <span class="text-xs text-gray-500">{{ row.role_description }}</span>
          </div>
        </div>
      </template>

      <template #granted_at="{ row }">
        <span class="text-sm text-gray-600">
          {{ formatLocalDate(row.granted_at) }}
        </span>
      </template>

      <template #actions="{ row }">
        <button
          v-if="canAssignRoles"
          class="d-btn d-btn-sm d-btn-ghost"
          :title="t('edit-role')"
          @click="openEditRoleModal(row)"
        >
          <IconWrench class="size-4" />
        </button>
        <button
          v-if="canAssignRoles"
          class="d-btn d-btn-sm d-btn-ghost text-error"
          :title="t('remove')"
          @click="removeRoleBinding(row.id)"
        >
          <IconTrash class="size-4" />
        </button>
      </template>
    </DataTable>

    <!-- Assign Role Modal -->
    <dialog :open="isAssignRoleModalOpen" class="modal" @close="isAssignRoleModalOpen = false">
      <div class="max-w-2xl modal-box">
        <h3 class="text-lg font-bold">
          {{ t('assign-app-role') }}
        </h3>

        <!-- Principal Type -->
        <div class="mt-4 form-control">
          <label class="label" for="assign-role-principal-type">
            <span class="label-text">{{ t('principal-type') }}</span>
          </label>
          <select id="assign-role-principal-type" v-model="assignRoleForm.principal_type" class="d-select" :aria-label="t('principal-type')">
            <option value="user">
              {{ t('user') }}
            </option>
            <option value="group">
              {{ t('group') }}
            </option>
          </select>
        </div>

        <!-- Principal Selection -->
        <div class="mt-4 form-control">
          <label class="label" for="assign-role-principal-id">
            <span class="label-text">
              {{ assignRoleForm.principal_type === 'user' ? t('select-user') : t('select-group') }}
            </span>
          </label>
          <select id="assign-role-principal-id" v-model="assignRoleForm.principal_id" class="d-select" required :aria-label="assignRoleForm.principal_type === 'user' ? t('select-user') : t('select-group')">
            <option value="">
              {{ assignRoleForm.principal_type === 'user' ? t('select-user') : t('select-group') }}
            </option>
            <option
              v-for="item in assignRoleForm.principal_type === 'user' ? availableMembers : availableGroups"
              :key="assignRoleForm.principal_type === 'user' ? (item as any).user_id : (item as any).id"
              :value="assignRoleForm.principal_type === 'user' ? (item as any).user_id : (item as any).id"
            >
              {{ assignRoleForm.principal_type === 'user' ? (item as any).email : (item as any).name }}
            </option>
          </select>
        </div>

        <!-- Role Selection -->
        <RoleSelect
          v-model="assignRoleForm.role_name"
          :roles="availableAppRoles"
          :label="t('select-app-role')"
          show-capabilities
          class="mt-4"
          required
        />

        <!-- Reason (optional) -->
        <div class="mt-4 form-control">
          <label class="label" for="assign-role-reason">
            <span class="label-text">{{ t('reason-optional') }}</span>
          </label>
          <textarea
            id="assign-role-reason"
            v-model="assignRoleForm.reason"
            :placeholder="t('reason-placeholder')"
            :aria-label="t('reason-optional')"
            class="d-textarea"
            rows="2"
          />
        </div>

        <div class="modal-action">
          <button class="d-btn" @click="isAssignRoleModalOpen = false">
            {{ t('cancel') }}
          </button>
          <button
            class="d-btn d-btn-primary"
            :disabled="!isAssignRoleFormValid || isLoading"
            @click="assignRole"
          >
            {{ t('assign') }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" @click="isAssignRoleModalOpen = false" />
    </dialog>

    <!-- Edit Role Modal -->
    <RoleSelectionModal
      v-model:open="isEditRoleModalOpen"
      :roles="availableAppRoles"
      :current-role="editRoleName"
      :title="t('select-app-role')"
      :is-loading="isEditingRole"
      @confirm="handleEditRoleConfirm"
    />
  </div>
</template>
