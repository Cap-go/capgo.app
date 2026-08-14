<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconPlus from '~icons/heroicons/plus'
import IconTrash from '~icons/heroicons/trash'
import RoleCapabilitiesHint from '~/components/forms/RoleCapabilitiesHint.vue'
import ChannelPermissionOverridesPanel from '~/components/permissions/ChannelPermissionOverridesPanel.vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { useSupabase } from '~/services/supabase'
import { getRbacRoleI18nKey } from '~/stores/organization'
import { getErrorCode, getErrorMessage } from '~/utils/errors'

type PrincipalType = 'user' | 'group' | 'apikey'

interface Role {
  id: string
  name: string
  description: string | null
}

interface ChannelSummary {
  id: number
  rbac_id: string
  name: string
}

interface ChannelRoleBinding {
  id: string
  role_id: string
  role_name: string
  role_description: string | null
  channel_id: string
  channel_row_id: number | null
  channel_name: string
}

const props = withDefaults(defineProps<{
  appId: string
  appUuid: string
  orgId: string
  principalType: PrincipalType
  principalId: string
  principalName: string
  inheritedRoleName: string
  editable?: boolean
}>(), {
  editable: true,
})

const emit = defineEmits<{
  changed: []
}>()

const { t } = useI18n()
const supabase = useSupabase()

const isLoading = ref(false)
const isSaving = ref(false)
const channels = ref<ChannelSummary[]>([])
const channelRoles = ref<Role[]>([])
const channelBindings = ref<ChannelRoleBinding[]>([])
const selectedChannelId = ref('')
const selectedRoleName = ref('')

const channelByRbacId = computed(() => new Map(channels.value.map(channel => [channel.rbac_id, channel])))
const canUseChannelPermissionOverrides = computed(() => props.principalType !== 'group')
const channelRoleNameById = computed(() => {
  return Object.fromEntries(
    channelBindings.value
      .filter(binding => typeof binding.channel_row_id === 'number')
      .map(binding => [binding.channel_row_id!, binding.role_name]),
  ) as Record<number, string>
})

const availableChannels = computed(() => {
  const usedChannelIds = new Set(channelBindings.value.map(binding => binding.channel_row_id).filter((id): id is number => typeof id === 'number'))
  return channels.value.filter(channel => !usedChannelIds.has(channel.id))
})

const canAddChannelRole = computed(() => {
  return props.editable
    && !!props.appUuid
    && !!props.orgId
    && !!props.principalId
    && !!selectedChannelId.value
    && !!selectedRoleName.value
    && !isSaving.value
})

function getRoleDisplayName(roleName: string): string {
  const i18nKey = getRbacRoleI18nKey(roleName)
  return i18nKey ? t(i18nKey) : roleName.replaceAll('_', ' ')
}

function normalizeChannelBindings(rows: any[]): ChannelRoleBinding[] {
  return rows.map((row) => {
    const channel = channelByRbacId.value.get(row.channel_id)
    return {
      id: row.id,
      role_id: row.role_id,
      role_name: row.role_name ?? row.roles?.name ?? '',
      role_description: row.role_description ?? row.roles?.description ?? null,
      channel_id: row.channel_id,
      channel_row_id: channel?.id ?? null,
      channel_name: channel?.name ?? row.channel_id,
    }
  })
}

async function loadChannelAccess() {
  if (!props.appId || !props.appUuid || !props.principalId) {
    channels.value = []
    channelRoles.value = []
    channelBindings.value = []
    return
  }

  isLoading.value = true
  try {
    const [channelsResult, rolesResult] = await Promise.all([
      supabase
        .from('channels')
        .select('id, rbac_id, name')
        .eq('app_id', props.appId)
        .order('name', { ascending: true }),
      supabase
        .from('roles')
        .select('id, name, description')
        .eq('scope_type', 'channel')
        .eq('is_assignable', true)
        .order('priority_rank', { ascending: false }),
    ])

    if (channelsResult.error)
      throw channelsResult.error
    if (rolesResult.error)
      throw rolesResult.error

    channels.value = (channelsResult.data || []) as ChannelSummary[]
    channelRoles.value = (rolesResult.data || []) as Role[]

    const { data, error } = await invokeCapgoApi(`private/role_bindings/app/${props.appUuid}/channel`, {
      method: 'GET',
    })

    if (error)
      throw error

    const principalBindings = ((data as any[]) || []).filter((binding) => {
      return binding.principal_type === props.principalType && binding.principal_id === props.principalId
    })
    channelBindings.value = normalizeChannelBindings(principalBindings)
    selectedChannelId.value = availableChannels.value[0]?.id?.toString() ?? ''
    selectedRoleName.value = channelRoles.value[0]?.name ?? ''
  }
  catch (error) {
    console.error('Error loading channel role bindings:', error)
    toast.error(t('error-loading-channel-access'))
  }
  finally {
    isLoading.value = false
  }
}

async function addChannelRole() {
  if (!canAddChannelRole.value)
    return

  const channel = channels.value.find(item => item.id.toString() === selectedChannelId.value)
  const role = channelRoles.value.find(item => item.name === selectedRoleName.value)
  if (!channel || !role) {
    toast.error(t('error-assigning-role'))
    return
  }

  isSaving.value = true
  try {
    const { error } = await invokeCapgoApi('private/role_bindings', {
      method: 'POST',
      body: {
        principal_type: props.principalType,
        principal_id: props.principalId,
        role_name: role.name,
        scope_type: 'channel',
        org_id: props.orgId,
        app_id: props.appUuid,
        channel_id: channel.rbac_id,
        reason: null,
      },
    })

    if (error)
      throw error

    toast.success(t('role-assigned'))
    await loadChannelAccess()
    emit('changed')
  }
  catch (error: unknown) {
    console.error('Error assigning channel role:', error)
    if (getErrorMessage(error)?.includes('duplicate') || getErrorCode(error) === '23505')
      toast.error(t('error-role-already-assigned'))
    else
      toast.error(t('error-assigning-role'))
  }
  finally {
    isSaving.value = false
  }
}

async function updateChannelRole(binding: ChannelRoleBinding, event: Event) {
  if (!props.editable)
    return

  const roleName = (event.target as HTMLSelectElement).value
  const role = channelRoles.value.find(item => item.name === roleName)
  if (!role || role.id === binding.role_id)
    return

  isSaving.value = true
  try {
    const { error } = await invokeCapgoApi(`private/role_bindings/${binding.id}`, {
      method: 'PATCH',
      body: { role_name: role.name },
    })

    if (error)
      throw error

    toast.success(t('permission-changed'))
    await loadChannelAccess()
    emit('changed')
  }
  catch (error) {
    console.error('Error updating channel role:', error)
    toast.error(t('error-assigning-role'))
  }
  finally {
    isSaving.value = false
  }
}

async function removeChannelRole(binding: ChannelRoleBinding) {
  if (!props.editable)
    return

  isSaving.value = true
  try {
    const { error } = await invokeCapgoApi(`private/role_bindings/${binding.id}`, {
      method: 'DELETE',
    })

    if (error)
      throw error

    toast.success(t('role-removed'))
    await loadChannelAccess()
    emit('changed')
  }
  catch (error) {
    console.error('Error removing channel role:', error)
    toast.error(t('error-removing-role'))
  }
  finally {
    isSaving.value = false
  }
}

watch(
  () => [props.appId, props.appUuid, props.principalType, props.principalId] as const,
  () => {
    void loadChannelAccess()
  },
  { immediate: true },
)
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-3">
      <div class="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {{ t('channel-direct-roles-title') }}
          </h3>
          <p class="text-sm text-slate-500 dark:text-slate-400">
            {{ t('channel-direct-roles-description') }}
          </p>
        </div>
        <span class="text-xs font-medium text-slate-500 dark:text-slate-400">
          {{ principalName }}
        </span>
      </div>

      <div v-if="isLoading" class="py-6 text-sm text-slate-500 dark:text-slate-400">
        {{ t('loading') }}...
      </div>

      <div v-else class="space-y-3">
        <div
          v-if="channelBindings.length === 0"
          class="rounded-md border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
        >
          {{ t('channel-direct-roles-empty') }}
        </div>

        <div
          v-for="binding in channelBindings"
          :key="binding.id"
          class="flex flex-col gap-3 rounded-md border border-slate-200 px-3 py-3 dark:border-slate-700 sm:flex-row sm:items-center"
        >
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {{ binding.channel_name }}
            </div>
            <div class="truncate text-xs text-slate-500 dark:text-slate-400">
              {{ getRoleDisplayName(binding.role_name) }}
            </div>
          </div>

          <label class="sr-only" :for="`channel-role-${binding.id}`">
            {{ t('select-channel-role') }}
          </label>
          <div class="flex w-full items-center gap-2 sm:w-auto">
            <select
              :id="`channel-role-${binding.id}`"
              class="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-900 sm:w-64"
              :value="binding.role_name"
              :disabled="!editable || isSaving"
              @change="updateChannelRole(binding, $event)"
            >
              <option v-for="role in channelRoles" :key="role.id" :value="role.name">
                {{ getRoleDisplayName(role.name) }}
              </option>
            </select>
            <RoleCapabilitiesHint :role-name="binding.role_name" />
          </div>

          <button
            class="d-btn d-btn-ghost min-h-11 w-11 text-error"
            type="button"
            :disabled="!editable || isSaving"
            :aria-label="t('remove-channel-role')"
            @click="removeChannelRole(binding)"
          >
            <IconTrash class="size-4" />
          </button>
        </div>

        <div
          v-if="editable && channels.length > 0"
          class="grid gap-3 border-t border-slate-200 pt-3 dark:border-slate-700 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <div class="form-control">
            <label for="channel-role-channel" class="label">
              <span class="label-text">{{ t('channel') }}</span>
            </label>
            <select
              id="channel-role-channel"
              v-model="selectedChannelId"
              class="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-900"
              :disabled="availableChannels.length === 0 || isSaving"
            >
              <option v-if="availableChannels.length === 0" value="">
                {{ t('channel-direct-roles-all-assigned') }}
              </option>
              <option v-for="channel in availableChannels" :key="channel.id" :value="channel.id.toString()">
                {{ channel.name }}
              </option>
            </select>
          </div>

          <div class="form-control">
            <label for="channel-role-role" class="label">
              <span class="label-text">{{ t('role') }}</span>
            </label>
            <div class="flex items-center gap-2">
              <select
                id="channel-role-role"
                v-model="selectedRoleName"
                class="min-h-11 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-900"
                :disabled="channelRoles.length === 0 || isSaving"
              >
                <option v-for="role in channelRoles" :key="role.id" :value="role.name">
                  {{ getRoleDisplayName(role.name) }}
                </option>
              </select>
              <RoleCapabilitiesHint
                v-if="selectedRoleName"
                :role-name="selectedRoleName"
              />
            </div>
          </div>

          <div class="flex items-end">
            <button
              class="d-btn d-btn-primary min-h-11 w-full gap-2 md:w-auto"
              type="button"
              :disabled="!canAddChannelRole"
              @click="addChannelRole"
            >
              <IconPlus class="size-4" />
              {{ t('add-channel-role') }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="canUseChannelPermissionOverrides" class="space-y-3 border-t border-slate-200 pt-5 dark:border-slate-700">
      <div>
        <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {{ t('channel-permission-overrides-title') }}
        </h3>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          {{ t('channel-permissions-description') }}
        </p>
      </div>

      <ChannelPermissionOverridesPanel
        :app-id="appId"
        :principal-type="principalType"
        :principal-id="principalId"
        :principal-name="principalName"
        :role-name="inheritedRoleName"
        :channel-role-name-by-id="channelRoleNameById"
        :editable="editable"
      />
    </section>
  </div>
</template>
