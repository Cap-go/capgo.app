<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconPlus from '~icons/heroicons/plus'
import IconTrash from '~icons/heroicons/trash'
import IconXMark from '~icons/heroicons/x-mark'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { getRbacRoleI18nKey } from '~/stores/organization'

type OrgRole = 'org_member' | 'org_billing_admin' | 'org_admin' | 'org_super_admin'
type AppRole = 'app_reader' | 'app_uploader' | 'app_developer' | 'app_admin'

export interface SsoRoleMapping {
  attribute: string
  rules: Array<{
    value: string
    org_role: OrgRole | null
    apps: Array<{ app_id: string, role: AppRole }>
    group_id: string | null
  }>
  default_role: OrgRole | null
}

const props = defineProps<{
  orgId: string
}>()

const emit = defineEmits<{
  saved: [providerId: string, roleMapping: SsoRoleMapping | null]
}>()

const DIALOG_ID = 'sso-role-mapping'
const ORG_ROLES: OrgRole[] = ['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin']
const APP_ROLES: AppRole[] = ['app_reader', 'app_uploader', 'app_developer', 'app_admin']
const controlClass = 'd-select d-select-bordered min-h-10 w-full rounded-md bg-white text-sm text-slate-900 dark:bg-slate-900 dark:text-slate-100'
const inputClass = 'd-input d-input-bordered min-h-10 w-full rounded-md bg-white text-sm text-slate-900 dark:bg-slate-900 dark:text-slate-100'

const { t } = useI18n()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()

const providerId = ref('')
const attribute = ref('')
const rules = ref<SsoRoleMapping['rules']>([])
// '' = no access; a string so it can bind to a <select>.
const defaultRole = ref<OrgRole | ''>('org_member')
const apps = ref<Array<{ id: string, name: string | null, app_id: string }>>([])
const groups = ref<Array<{ id: string, name: string }>>([])

function roleLabel(role: string) {
  return t(getRbacRoleI18nKey(role) ?? role)
}

async function loadTargets() {
  const [appsResult, groupsResult] = await Promise.all([
    supabase.from('apps').select('id, name, app_id').eq('owner_org', props.orgId).order('name'),
    supabase.from('groups').select('id, name').eq('org_id', props.orgId).order('name'),
  ])
  if (appsResult.error || groupsResult.error)
    console.error('Failed to load SSO role mapping targets:', appsResult.error ?? groupsResult.error)
  apps.value = (appsResult.data ?? []).filter((app): app is { id: string, name: string | null, app_id: string } => app.id !== null)
  groups.value = groupsResult.data ?? []
}

function addRule() {
  rules.value.push({ value: '', org_role: 'org_member', apps: [], group_id: null })
}

function addApp(rule: SsoRoleMapping['rules'][number]) {
  const unused = apps.value.find(app => !rule.apps.some(entry => entry.app_id === app.id))
  if (unused)
    rule.apps.push({ app_id: unused.id, role: 'app_developer' })
}

async function save(roleMapping: SsoRoleMapping | null): Promise<boolean> {
  const { data: session } = await supabase.auth.getSession()
  const response = await fetch(`${defaultApiHost}/private/sso/providers/${providerId.value}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${session.session?.access_token ?? ''}`,
    },
    body: JSON.stringify({ role_mapping: roleMapping }),
  }).catch(() => null)
  if (!response?.ok) {
    const errorData = await response?.json().catch(() => ({})) as { error?: string, message?: string } | undefined
    toast.error(errorData?.message || errorData?.error || t('sso-error-updating'))
    return false
  }
  toast.success(t('sso-role-mapping-saved'))
  emit('saved', providerId.value, roleMapping)
  return true
}

function currentMapping(): SsoRoleMapping {
  return {
    attribute: attribute.value.trim(),
    rules: rules.value.map(rule => ({ ...rule, value: rule.value.trim(), apps: rule.apps.map(app => ({ ...app })) })),
    default_role: defaultRole.value || null,
  }
}

function open(provider: { id: string, domain: string, role_mapping: SsoRoleMapping | null }) {
  providerId.value = provider.id
  attribute.value = provider.role_mapping?.attribute ?? 'groups'
  // Plain copies: Vue reactive proxies cannot be structured-cloned.
  rules.value = (provider.role_mapping?.rules ?? []).map(rule => ({ ...rule, apps: rule.apps.map(app => ({ ...app })) }))
  defaultRole.value = provider.role_mapping ? (provider.role_mapping.default_role ?? '') : 'org_member'
  if (rules.value.length === 0)
    addRule()
  loadTargets()

  dialogStore.openDialog({
    id: DIALOG_ID,
    title: t('sso-role-mapping-dialog-title', { domain: provider.domain }),
    description: t('sso-role-mapping-description'),
    size: '3xl',
    preventAccidentalClose: true,
    buttons: [
      { text: t('button-cancel'), role: 'cancel' },
      ...(provider.role_mapping
        ? [{ text: t('sso-role-mapping-remove'), role: 'danger' as const, handler: () => save(null) }]
        : []),
      // A false return keeps the dialog open so the admin can fix the error.
      { text: t('save-changes'), role: 'primary', handler: () => save(currentMapping()) },
    ],
  })
}

defineExpose({ open })
</script>

<template>
  <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === DIALOG_ID" defer to="#dialog-v2-content">
    <div class="space-y-6">
      <div class="form-control">
        <label for="sso-role-attribute" class="label">
          <span class="label-text font-medium">{{ t('sso-role-mapping-attribute') }}</span>
        </label>
        <input id="sso-role-attribute" v-model="attribute" type="text" :placeholder="t('sso-role-mapping-attribute-placeholder')" :class="inputClass">
        <p class="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {{ t('sso-role-mapping-attribute-help') }}
        </p>
      </div>

      <fieldset class="space-y-3">
        <legend class="text-sm font-medium text-slate-700 dark:text-slate-200">
          {{ t('sso-role-mapping-rules') }}
        </legend>

        <div
          v-for="(rule, ruleIndex) in rules"
          :key="ruleIndex"
          class="space-y-4 rounded-md border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/60"
        >
          <div class="flex items-end gap-3">
            <div class="form-control flex-1">
              <label :for="`sso-rule-value-${ruleIndex}`" class="label">
                <span class="label-text text-xs uppercase text-slate-500 dark:text-slate-400">{{ t('sso-role-mapping-value') }}</span>
              </label>
              <input :id="`sso-rule-value-${ruleIndex}`" v-model="rule.value" type="text" :placeholder="t('sso-role-mapping-value-placeholder')" :class="inputClass">
            </div>
            <button type="button" class="d-btn d-btn-ghost d-btn-sm text-slate-500" :aria-label="t('sso-role-mapping-remove-rule')" @click="rules.splice(ruleIndex, 1)">
              <IconTrash class="h-4 w-4" />
            </button>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <div class="form-control">
              <label :for="`sso-rule-org-role-${ruleIndex}`" class="label">
                <span class="label-text">{{ t('sso-role-mapping-org-role') }}</span>
              </label>
              <select :id="`sso-rule-org-role-${ruleIndex}`" v-model="rule.org_role" :class="controlClass">
                <option :value="null">
                  {{ t('sso-role-mapping-no-role') }}
                </option>
                <option v-for="role in ORG_ROLES" :key="role" :value="role">
                  {{ roleLabel(role) }}
                </option>
              </select>
            </div>
            <div class="form-control">
              <label :for="`sso-rule-group-${ruleIndex}`" class="label">
                <span class="label-text">{{ t('sso-role-mapping-group') }}</span>
              </label>
              <select :id="`sso-rule-group-${ruleIndex}`" v-model="rule.group_id" :class="controlClass">
                <option :value="null">
                  {{ t('sso-role-mapping-no-group') }}
                </option>
                <option v-for="group in groups" :key="group.id" :value="group.id">
                  {{ group.name }}
                </option>
              </select>
            </div>
          </div>

          <div class="space-y-2">
            <span class="text-sm text-slate-700 dark:text-slate-200">{{ t('sso-role-mapping-app-access') }}</span>
            <div v-for="(appEntry, appIndex) in rule.apps" :key="appIndex" class="flex items-center gap-2">
              <select v-model="appEntry.app_id" :aria-label="t('sso-role-mapping-app')" :class="controlClass">
                <option v-for="app in apps" :key="app.id" :value="app.id" :disabled="app.id !== appEntry.app_id && rule.apps.some(entry => entry.app_id === app.id)">
                  {{ app.name || app.app_id }}
                </option>
              </select>
              <select v-model="appEntry.role" :aria-label="t('sso-role-mapping-app-role')" :class="controlClass">
                <option v-for="role in APP_ROLES" :key="role" :value="role">
                  {{ roleLabel(role) }}
                </option>
              </select>
              <button type="button" class="d-btn d-btn-ghost d-btn-sm text-slate-500" :aria-label="t('sso-role-mapping-remove-app')" @click="rule.apps.splice(appIndex, 1)">
                <IconXMark class="h-4 w-4" />
              </button>
            </div>
            <button
              v-if="rule.apps.length < apps.length"
              type="button"
              class="d-btn d-btn-ghost d-btn-sm text-primary"
              @click="addApp(rule)"
            >
              <IconPlus class="h-4 w-4" />
              {{ t('sso-role-mapping-add-app') }}
            </button>
            <p v-else class="text-xs text-slate-500 dark:text-slate-400">
              {{ apps.length === 0 ? t('sso-role-mapping-no-apps') : t('sso-role-mapping-all-apps-added') }}
            </p>
          </div>
        </div>

        <button type="button" class="d-btn d-btn-outline d-btn-sm w-full border-dashed" @click="addRule">
          <IconPlus class="h-4 w-4" />
          {{ t('sso-role-mapping-add-rule') }}
        </button>
      </fieldset>

      <div class="form-control">
        <label for="sso-default-role" class="label">
          <span class="label-text font-medium">{{ t('sso-role-mapping-default-role') }}</span>
        </label>
        <select id="sso-default-role" v-model="defaultRole" :class="controlClass" aria-describedby="sso-default-role-help">
          <option value="">
            {{ t('sso-role-mapping-no-access') }}
          </option>
          <option v-for="role in ORG_ROLES" :key="role" :value="role">
            {{ roleLabel(role) }}
          </option>
        </select>
        <p id="sso-default-role-help" class="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {{ t('sso-role-mapping-default-role-help') }}
        </p>
      </div>
    </div>
  </Teleport>
</template>
