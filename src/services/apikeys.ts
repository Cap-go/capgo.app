import type { SupabaseClient } from '@supabase/supabase-js'
import type { TableColumn } from '~/components/comp_def'
import type { DialogV2Button, DialogV2Options } from '~/stores/dialogv2'
import type { Database } from '~/types/supabase.types'

export async function createDefaultApiKey(
  supabase: SupabaseClient<Database>,
  name: string,
  options: {
    orgId?: string | null
    appId?: string | null
    hashed?: boolean
  } = {},
) {
  let orgId = options.orgId ?? null
  let appUuid: string | null = null

  if (options.appId) {
    const { data: app, error } = await supabase
      .from('apps')
      .select('id, owner_org')
      .eq('app_id', options.appId)
      .single()

    if (error)
      throw error

    if (orgId && app?.owner_org && orgId !== app.owner_org) {
      throw new Error('appId does not belong to orgId')
    }

    appUuid = app?.id ?? null
    orgId = orgId ?? app?.owner_org ?? null
  }

  if (!orgId) {
    throw new Error('Cannot create a default API key without an organization')
  }

  const bindings: Array<{
    role_name: string
    scope_type: 'org' | 'app'
    org_id: string
    app_id?: string
  }> = appUuid && !options.orgId
    ? [
        {
          role_name: 'org_member',
          scope_type: 'org',
          org_id: orgId,
        },
        {
          role_name: 'app_admin',
          scope_type: 'app',
          org_id: orgId,
          app_id: appUuid,
        },
      ]
    : [
        {
          role_name: 'org_admin',
          scope_type: 'org',
          org_id: orgId,
        },
      ]

  return supabase.functions.invoke('apikey', {
    method: 'POST',
    body: {
      name,
      hashed: options.hashed === true,
      bindings,
    },
  })
}

export async function createAiApiKey(
  supabase: SupabaseClient<Database>,
  name: string,
  options: {
    /** Organizations used for admin bindings or to validate each selected app's owner. */
    orgIds: string[]
    role: 'admin' | 'member'
    /** Member role only: the apps to grant access on, each with its owning org and chosen app-level role. */
    apps?: Array<{ uuid: string, orgId: string, role: string }>
    /** Admin role only: also grant the `org.create` global permission (create new orgs). */
    allowOrgCreate?: boolean
  },
) {
  const { orgIds, role } = options

  if (!orgIds || orgIds.length === 0) {
    throw new Error('Cannot create an AI API key without an organization')
  }

  const bindings: Array<{
    role_name: string
    scope_type: 'org' | 'app'
    org_id: string
    app_id?: string
  }> = []

  if (role === 'admin') {
    for (const orgId of orgIds)
      bindings.push({ role_name: 'org_admin', scope_type: 'org', org_id: orgId })
  }
  else {
    const orgIdSet = new Set(orgIds)
    const apps = options.apps ?? []
    if (apps.length === 0)
      throw new Error('Select at least one app for a member API key')

    for (const app of apps) {
      if (!orgIdSet.has(app.orgId))
        throw new Error('Each app.orgId must be one of the selected orgIds')
      bindings.push({ role_name: app.role, scope_type: 'app', org_id: app.orgId, app_id: app.uuid })
    }
  }

  // `org.create` is only valid on a key that has an org-admin binding — i.e. the admin role.
  const globalPermissions = role === 'admin' && options.allowOrgCreate ? ['org.create'] : undefined

  return supabase.functions.invoke('apikey', {
    method: 'POST',
    body: {
      name,
      hashed: false,
      bindings,
      global_permissions: globalPermissions,
    },
  })
}

export async function findUsablePlainApiKey(
  supabase: SupabaseClient<Database>,
  userId: string,
  orgId?: string | null,
  appId?: string | null,
): Promise<string | null> {
  const isLiveKey = (expiresAt: string | null) => !expiresAt || new Date(expiresAt).getTime() > Date.now()
  let appUuid: string | null = null

  const { data: keys, error } = await supabase
    .from('apikeys')
    .select('key, expires_at, rbac_id, created_at')
    .eq('user_id', userId)
    .not('key', 'is', null)
    .order('created_at', { ascending: false })

  if (error || !keys?.length)
    return null

  const liveKeys = keys.filter(key => key.key && isLiveKey(key.expires_at))
  if (!liveKeys.length)
    return null

  if (!orgId)
    return liveKeys[0].key ?? null

  if (appId) {
    const { data: app, error: appError } = await supabase
      .from('apps')
      .select('id, owner_org')
      .eq('app_id', appId)
      .single()

    if (appError || !app?.id || !app.owner_org)
      return null

    if (app.owner_org !== orgId)
      return null

    appUuid = app.id
  }

  const rbacIds = liveKeys.map(key => key.rbac_id).filter((rbacId): rbacId is string => !!rbacId)
  if (!rbacIds.length)
    return null

  const { data: bindings, error: bindingsError } = await supabase
    .from('role_bindings')
    .select('principal_id, scope_type, app_id, roles(name)')
    .eq('principal_type', 'apikey')
    .eq('org_id', orgId)
    .in('principal_id', rbacIds)

  if (bindingsError || !bindings?.length)
    return null

  const orgAdminRoles = new Set(['org_super_admin', 'org_admin'])
  type BindingRole = { name?: string | null } | { name?: string | null }[] | null
  interface BindingRow {
    principal_id: string | null
    scope_type: string | null
    app_id: string | null
    roles: BindingRole
  }
  const scopedKeyIds = new Set((bindings as BindingRow[])
    .filter((binding) => {
      const roleName = Array.isArray(binding.roles) ? binding.roles[0]?.name : binding.roles?.name
      if (!roleName)
        return false
      if (binding.scope_type === 'org' && orgAdminRoles.has(roleName))
        return true
      return !!appUuid && binding.scope_type === 'app' && binding.app_id === appUuid
    })
    .map(binding => binding.principal_id)
    .filter((principalId): principalId is string => typeof principalId === 'string'))

  if (!scopedKeyIds.size)
    return null

  return liveKeys.find(key => scopedKeyIds.has(key.rbac_id))?.key ?? null
}

interface ApiKeyListRow {
  name?: string | null
  created_at: string | null
}

interface DialogStoreLike {
  lastButtonRole?: string
  openDialog: (options: DialogV2Options) => void
  onDialogDismiss: () => Promise<boolean>
}

type Translate = (key: string) => string

function createDialogButton(
  text: string,
  role: DialogV2Button['role'],
  handler?: DialogV2Button['handler'],
): DialogV2Button {
  return {
    text,
    role,
    handler,
  }
}

export function isApiKeyExpired(expiresAt: string | null): boolean {
  if (!expiresAt)
    return false

  return new Date(expiresAt) < new Date()
}

export function sortApiKeyRows<T extends ApiKeyListRow>(
  rows: T[],
  columns: TableColumn[],
): T[] {
  let result = [...rows]

  columns.forEach((col) => {
    if (!col.sortable || typeof col.sortable !== 'string')
      return

    result = [...result].sort((a, b) => {
      let aValue: string | number = ''
      let bValue: string | number = ''

      switch (col.key) {
        case 'name':
          aValue = a.name?.toLowerCase() || ''
          bValue = b.name?.toLowerCase() || ''
          break
        case 'created_at':
          aValue = a.created_at ? new Date(a.created_at).getTime() : 0
          bValue = b.created_at ? new Date(b.created_at).getTime() : 0
          break
        default:
          return 0
      }

      if (aValue < bValue)
        return col.sortable === 'asc' ? -1 : 1
      if (aValue > bValue)
        return col.sortable === 'asc' ? 1 : -1
      return 0
    })
  })

  return result
}

export async function confirmApiKeyDeletion(
  dialogStore: DialogStoreLike,
  t: Translate,
): Promise<boolean> {
  dialogStore.openDialog({
    title: t('alert-confirm-delete'),
    description: `${t('alert-not-reverse-message')} ${t('alert-delete-message')}?`,
    buttons: [
      createDialogButton(t('button-cancel'), 'cancel'),
      createDialogButton(t('button-delete'), 'danger'),
    ],
  })

  const wasCanceled = await dialogStore.onDialogDismiss()
  return !wasCanceled && dialogStore.lastButtonRole === 'danger'
}

export async function confirmApiKeyRegeneration(
  dialogStore: DialogStoreLike,
  t: Translate,
): Promise<boolean> {
  dialogStore.openDialog({
    title: t('alert-confirm-regenerate'),
    description: `${t('alert-not-reverse-message')}. ${t('alert-regenerate-key')}?`,
    buttons: [
      createDialogButton(t('button-cancel'), 'cancel'),
      createDialogButton(t('button-regenerate'), 'primary'),
    ],
  })

  const wasCanceled = await dialogStore.onDialogDismiss()
  return !wasCanceled && dialogStore.lastButtonRole === 'primary'
}

export async function showApiKeySecretModal(
  dialogStore: DialogStoreLike,
  t: Translate,
  plainKey: string,
  onCopySuccess?: () => void,
): Promise<void> {
  dialogStore.openDialog({
    title: t('secure-key-created'),
    description: `${t('secure-key-warning')}\n\n${t('your-api-key')}: ${plainKey}`,
    size: 'lg',
    buttons: [
      createDialogButton(t('copy-and-close'), 'primary', async () => {
        try {
          await navigator.clipboard.writeText(plainKey)
          onCopySuccess?.()
        }
        catch {}
      }),
    ],
  })

  await dialogStore.onDialogDismiss()
}
