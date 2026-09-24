<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconTrash from '~icons/heroicons/trash'
import Spinner from '~/components/Spinner.vue'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { getRbacRoleI18nKey } from '~/stores/organization'

type OrgRole = 'org_member' | 'org_billing_admin' | 'org_admin' | 'org_super_admin'

export interface SsoRoleMapping {
  attribute: string
  rules: Array<{ value: string, role: OrgRole | null, group_id: string | null }>
  default_role: OrgRole | null
}

const props = defineProps<{
  orgId: string
  providerId: string
  roleMapping: SsoRoleMapping | null
}>()

const emit = defineEmits<{
  saved: [roleMapping: SsoRoleMapping | null]
}>()

const ROLES: OrgRole[] = ['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin']

const { t } = useI18n()
const supabase = useSupabase()

const groups = ref<Array<{ id: string, name: string }>>([])
const attribute = ref(props.roleMapping?.attribute ?? '')
const rules = ref((props.roleMapping?.rules ?? []).map(rule => ({ ...rule })))
// '' = no access; kept as a string so it can bind to a <select>.
const defaultRole = ref<OrgRole | ''>(props.roleMapping ? (props.roleMapping.default_role ?? '') : 'org_member')
const isSaving = ref(false)

onMounted(async () => {
  const { data, error } = await supabase
    .from('groups')
    .select('id, name')
    .eq('org_id', props.orgId)
    .order('name', { ascending: true })
  if (error)
    console.error('Failed to load groups for SSO role mapping:', error)
  groups.value = data ?? []
})

function addRule() {
  rules.value.push({ value: '', role: 'org_member', group_id: null })
}

function removeRule(index: number) {
  rules.value.splice(index, 1)
}

async function save(roleMapping: SsoRoleMapping | null) {
  isSaving.value = true
  try {
    const { data: session } = await supabase.auth.getSession()
    const response = await fetch(`${defaultApiHost}/private/sso/providers/${props.providerId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${session.session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ role_mapping: roleMapping }),
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string, message?: string }
      toast.error(errorData.message || errorData.error || t('sso-error-updating'))
      return
    }
    toast.success(t('sso-role-mapping-saved'))
    emit('saved', roleMapping)
  }
  catch (error) {
    console.error('Error saving SSO role mapping:', error)
    toast.error(t('sso-error-updating'))
  }
  finally {
    isSaving.value = false
  }
}

function submit() {
  save({
    attribute: attribute.value.trim(),
    rules: rules.value.map(rule => ({ value: rule.value.trim(), role: rule.role, group_id: rule.group_id })),
    default_role: defaultRole.value || null,
  })
}
</script>

<template>
  <div class="flex flex-col gap-3 pt-3 border-t border-slate-200 dark:border-slate-700">
    <p class="text-xs text-slate-500 dark:text-slate-400">
      {{ t('sso-role-mapping-description') }}
    </p>

    <div>
      <label :for="`sso-role-attribute-${providerId}`" class="block mb-1 text-sm font-medium dark:text-white text-slate-700">
        {{ t('sso-role-mapping-attribute') }}
      </label>
      <input
        :id="`sso-role-attribute-${providerId}`"
        v-model="attribute"
        type="text"
        :placeholder="t('sso-role-mapping-attribute-placeholder')"
        :aria-label="t('sso-role-mapping-attribute')"
        class="d-input d-input-bordered d-input-sm w-full"
      >
    </div>

    <div v-for="(rule, index) in rules" :key="index" class="flex flex-wrap items-center gap-2">
      <input
        v-model="rule.value"
        type="text"
        :placeholder="t('sso-role-mapping-value-placeholder')"
        :aria-label="t('sso-role-mapping-value')"
        class="d-input d-input-bordered d-input-sm flex-1 min-w-32"
      >
      <select v-model="rule.role" :aria-label="t('sso-role-mapping-role')" class="d-select d-select-bordered d-select-sm">
        <option :value="null">
          {{ t('sso-role-mapping-no-role') }}
        </option>
        <option v-for="role in ROLES" :key="role" :value="role">
          {{ t(getRbacRoleI18nKey(role) ?? role) }}
        </option>
      </select>
      <select v-model="rule.group_id" :aria-label="t('sso-role-mapping-group')" class="d-select d-select-bordered d-select-sm">
        <option :value="null">
          {{ t('sso-role-mapping-no-group') }}
        </option>
        <option v-for="group in groups" :key="group.id" :value="group.id">
          {{ group.name }}
        </option>
      </select>
      <button type="button" class="d-btn d-btn-ghost d-btn-sm" :aria-label="t('delete')" @click="removeRule(index)">
        <IconTrash class="w-4 h-4" />
      </button>
    </div>

    <button type="button" class="d-btn d-btn-outline d-btn-sm self-start" @click="addRule">
      {{ t('sso-role-mapping-add-rule') }}
    </button>

    <div>
      <label :for="`sso-default-role-${providerId}`" class="block mb-1 text-sm font-medium dark:text-white text-slate-700">
        {{ t('sso-role-mapping-default-role') }}
      </label>
      <select :id="`sso-default-role-${providerId}`" v-model="defaultRole" class="d-select d-select-bordered d-select-sm">
        <option value="">
          {{ t('sso-role-mapping-no-access') }}
        </option>
        <option v-for="role in ROLES" :key="role" :value="role">
          {{ t(getRbacRoleI18nKey(role) ?? role) }}
        </option>
      </select>
    </div>

    <div class="flex items-center gap-2">
      <button type="button" class="d-btn d-btn-primary d-btn-sm" :disabled="isSaving || !attribute.trim()" @click="submit">
        <Spinner v-if="isSaving" size="w-4 h-4" />
        {{ t('save-changes') }}
      </button>
      <button v-if="roleMapping" type="button" class="d-btn d-btn-outline d-btn-sm" :disabled="isSaving" @click="save(null)">
        {{ t('sso-role-mapping-remove') }}
      </button>
    </div>
  </div>
</template>
