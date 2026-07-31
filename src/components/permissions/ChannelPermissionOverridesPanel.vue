<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useSupabase } from '~/services/supabase'
import { getRbacRoleI18nKey } from '~/stores/organization'

type PrincipalType = 'user' | 'group' | 'apikey'
type ChannelPermissionKey = 'channel.read' | 'channel.read_history' | 'channel.promote_bundle'

interface ChannelSummary {
  id: number
  name: string
}

interface ChannelPermissionOverrideSummary {
  channel_id: number
  permission_key: ChannelPermissionKey
  is_allowed: boolean
}

const props = withDefaults(defineProps<{
  appId: string
  principalType: PrincipalType
  principalId: string
  principalName: string
  roleName: string
  channelRoleNameById?: Record<number, string>
  editable?: boolean
}>(), {
  channelRoleNameById: () => ({}),
  editable: true,
})

const { t } = useI18n()
const supabase = useSupabase()
const channelOverrides = ref<Record<string, boolean>>({})
const channelOverridesLoading = ref(false)
const channelOverridesSearch = ref('')
const channelOverridesSaving = ref<Record<string, boolean>>({})
const loadRequestId = ref(0)
const channels = ref<ChannelSummary[]>([])

const channelPermissionOptions = computed(() => [
  { key: 'channel.read' as ChannelPermissionKey, label: t('channel-permission-read') },
  { key: 'channel.read_history' as ChannelPermissionKey, label: t('channel-permission-history') },
  { key: 'channel.promote_bundle' as ChannelPermissionKey, label: t('channel-permission-associate') },
])

const roleDefaultChannelPermissions: Record<string, Record<ChannelPermissionKey, boolean>> = {
  org_super_admin: {
    'channel.read': true,
    'channel.read_history': true,
    'channel.promote_bundle': true,
  },
  org_admin: {
    'channel.read': true,
    'channel.read_history': true,
    'channel.promote_bundle': true,
  },
  app_admin: {
    'channel.read': true,
    'channel.read_history': true,
    'channel.promote_bundle': true,
  },
  app_preview: {
    'channel.read': false,
    'channel.read_history': false,
    'channel.promote_bundle': false,
  },
  channel_preview: {
    'channel.read': true,
    'channel.read_history': false,
    'channel.promote_bundle': true,
  },
  app_developer: {
    'channel.read': true,
    'channel.read_history': true,
    'channel.promote_bundle': true,
  },
  app_uploader: {
    'channel.read': false,
    'channel.read_history': false,
    'channel.promote_bundle': false,
  },
  app_reader: {
    'channel.read': false,
    'channel.read_history': false,
    'channel.promote_bundle': false,
  },
  channel_admin: {
    'channel.read': true,
    'channel.read_history': true,
    'channel.promote_bundle': true,
  },
  channel_reader: {
    'channel.read': true,
    'channel.read_history': true,
    'channel.promote_bundle': false,
  },
}

const filteredChannels = computed(() => {
  if (!channelOverridesSearch.value)
    return channels.value
  const searchLower = channelOverridesSearch.value.toLowerCase()
  return channels.value.filter(channel => channel.name.toLowerCase().includes(searchLower))
})

function getRoleDisplayName(roleName: string): string {
  const i18nKey = getRbacRoleI18nKey(roleName)
  return i18nKey ? t(i18nKey) : roleName.replaceAll('_', ' ')
}

function getOverrideKey(channelId: number, permission: ChannelPermissionKey) {
  return `${channelId}:${permission}`
}

function hasOverride(channelId: number, permission: ChannelPermissionKey) {
  const key = getOverrideKey(channelId, permission)
  return Object.prototype.hasOwnProperty.call(channelOverrides.value, key)
}

function getOverrideValue(channelId: number, permission: ChannelPermissionKey) {
  const key = getOverrideKey(channelId, permission)
  if (!hasOverride(channelId, permission))
    return undefined
  return channelOverrides.value[key]
}

function getRoleDefaultPermission(roleName: string, permission: ChannelPermissionKey) {
  return roleDefaultChannelPermissions[roleName]?.[permission] ?? false
}

function getDefaultPermission(channelId: number, permission: ChannelPermissionKey) {
  const inheritedAllowed = getRoleDefaultPermission(props.roleName, permission)
  const channelRoleName = props.channelRoleNameById[channelId]
  if (!channelRoleName)
    return inheritedAllowed
  return inheritedAllowed || getRoleDefaultPermission(channelRoleName, permission)
}

function getSelectValue(channelId: number, permission: ChannelPermissionKey): 'default' | 'allow' | 'deny' {
  const override = getOverrideValue(channelId, permission)
  if (override === undefined)
    return 'default'
  return override ? 'allow' : 'deny'
}

function getDefaultLabel(channelId: number, permission: ChannelPermissionKey) {
  return getDefaultPermission(channelId, permission)
    ? t('channel-permissions-default-allow')
    : t('channel-permissions-default-deny')
}

function isSavingOverride(channelId: number, permission: ChannelPermissionKey) {
  const key = getOverrideKey(channelId, permission)
  return !!channelOverridesSaving.value[key]
}

async function loadChannelPermissions() {
  const currentRequestId = ++loadRequestId.value

  if (!props.appId || !props.principalId) {
    channels.value = []
    channelOverrides.value = {}
    channelOverridesLoading.value = false
    return
  }

  channelOverridesLoading.value = true
  try {
    const { data: channelData, error: channelError } = await supabase
      .from('channels')
      .select('id, name')
      .eq('app_id', props.appId)
      .order('name', { ascending: true })

    if (currentRequestId !== loadRequestId.value)
      return

    if (channelError)
      throw channelError

    channels.value = (channelData as ChannelSummary[]) || []

    if (channels.value.length === 0) {
      channelOverrides.value = {}
      return
    }

    const channelIds = channels.value.map(channel => channel.id)
    const { data: overrides, error: overridesError } = await supabase
      .from('channel_permission_overrides')
      .select('channel_id, permission_key, is_allowed')
      .eq('principal_type', props.principalType)
      .eq('principal_id', props.principalId)
      .in('channel_id', channelIds)

    if (currentRequestId !== loadRequestId.value)
      return

    if (overridesError)
      throw overridesError

    const nextOverrides: Record<string, boolean> = {}
    for (const override of (overrides || []) as ChannelPermissionOverrideSummary[]) {
      const key = getOverrideKey(override.channel_id, override.permission_key)
      nextOverrides[key] = override.is_allowed
    }
    channelOverrides.value = nextOverrides
  }
  catch (error) {
    console.error('Error loading channel permissions:', error)
    toast.error(t('error-loading-channel-permissions'))
  }
  finally {
    if (currentRequestId === loadRequestId.value)
      channelOverridesLoading.value = false
  }
}

async function updateChannelPermission(channelId: number, permission: ChannelPermissionKey, value: 'default' | 'allow' | 'deny') {
  if (!props.editable || !props.principalId)
    return

  const key = getOverrideKey(channelId, permission)
  if (channelOverridesSaving.value[key])
    return

  const defaultAllowed = getDefaultPermission(channelId, permission)
  const previousOverrides = { ...channelOverrides.value }

  channelOverridesSaving.value = { ...channelOverridesSaving.value, [key]: true }

  let nextOverride: boolean | null = null
  if (value === 'default') {
    nextOverride = null
  }
  else {
    const isAllowed = value === 'allow'
    nextOverride = isAllowed === defaultAllowed ? null : isAllowed
  }

  if (nextOverride === null) {
    const updated = { ...channelOverrides.value }
    delete updated[key]
    channelOverrides.value = updated
  }
  else {
    channelOverrides.value = { ...channelOverrides.value, [key]: nextOverride }
  }

  try {
    if (nextOverride === null) {
      const { error } = await supabase
        .from('channel_permission_overrides')
        .delete()
        .eq('principal_type', props.principalType)
        .eq('principal_id', props.principalId)
        .eq('channel_id', channelId)
        .eq('permission_key', permission)

      if (error)
        throw error
    }
    else {
      const { error } = await supabase
        .from('channel_permission_overrides')
        .upsert({
          principal_type: props.principalType,
          principal_id: props.principalId,
          channel_id: channelId,
          permission_key: permission,
          is_allowed: nextOverride,
        }, { onConflict: 'principal_type,principal_id,channel_id,permission_key' })

      if (error)
        throw error
    }
  }
  catch (error) {
    console.error('Error saving channel permission override:', error)
    channelOverrides.value = previousOverrides
    toast.error(t('error-saving-channel-permissions'))
  }
  finally {
    const updatedSaving = { ...channelOverridesSaving.value }
    delete updatedSaving[key]
    channelOverridesSaving.value = updatedSaving
  }
}

watch(
  () => [props.appId, props.principalType, props.principalId] as const,
  () => {
    channelOverridesSearch.value = ''
    channelOverrides.value = {}
    channels.value = []
    void loadChannelPermissions()
  },
  { immediate: true },
)
</script>

<template>
  <div class="space-y-4" data-test="channel-permissions-panel">
    <div class="space-y-1">
      <div class="text-xs font-semibold tracking-wide text-gray-400 uppercase">
        {{ t('channel-permissions-principal') }}
      </div>
      <div class="text-base text-gray-900 dark:text-gray-100">
        {{ principalName || '-' }}
      </div>
      <div class="text-xs text-gray-500">
        {{ t('channel-permissions-role') }}: {{ getRoleDisplayName(roleName) }}
      </div>
    </div>

    <div>
      <label for="channel-overrides-search" class="sr-only">{{ t('search-channels') }}</label>
      <input
        id="channel-overrides-search"
        v-model="channelOverridesSearch"
        type="text"
        class="w-full d-input d-input-bordered"
        :placeholder="t('search-channels')"
        :aria-label="t('search-channels')"
        data-test="channel-permissions-search"
      >
    </div>

    <div v-if="channelOverridesLoading" class="py-6 text-sm text-gray-500">
      {{ t('loading') }}...
    </div>

    <div v-else-if="filteredChannels.length === 0" class="py-6 text-sm text-gray-500">
      {{ t('channel-permissions-empty') }}
    </div>

    <div v-else class="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
      <table class="min-w-full text-sm">
        <thead class="bg-slate-50 dark:bg-slate-900/40">
          <tr>
            <th class="px-3 py-2 text-left font-semibold text-gray-700 dark:text-gray-200">
              {{ t('channels') }}
            </th>
            <th
              v-for="perm in channelPermissionOptions"
              :key="perm.key"
              class="px-3 py-2 text-left font-semibold text-gray-700 dark:text-gray-200"
            >
              {{ perm.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="channel in filteredChannels"
            :key="channel.id"
            class="border-t border-slate-200 dark:border-slate-700"
            data-test="channel-permissions-row"
            :data-channel-id="channel.id"
          >
            <td class="px-3 py-2 text-gray-900 dark:text-gray-100">
              {{ channel.name }}
            </td>
            <td
              v-for="perm in channelPermissionOptions"
              :key="perm.key"
              class="px-3 py-2"
            >
              <select
                :id="`channel-perm-${channel.id}-${perm.key}`"
                class="w-full d-select d-select-sm d-select-bordered"
                :value="getSelectValue(channel.id, perm.key)"
                :aria-label="`${channel.name} ${perm.label}`"
                :disabled="!editable || isSavingOverride(channel.id, perm.key)"
                data-test="channel-permission-select"
                :data-channel-id="channel.id"
                :data-permission-key="perm.key"
                @change="updateChannelPermission(channel.id, perm.key, ($event.target as HTMLSelectElement).value as 'default' | 'allow' | 'deny')"
              >
                <option value="default">
                  {{ getDefaultLabel(channel.id, perm.key) }}
                </option>
                <option value="allow">
                  {{ t('channel-permissions-allow') }}
                </option>
                <option value="deny">
                  {{ t('channel-permissions-deny') }}
                </option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
