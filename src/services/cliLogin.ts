import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import { invokeCapgoApi } from '~/services/capgoApi'
import { checkPermissions } from '~/services/permissions'

export interface CliLoginOrganization {
  'gid': string
  'name': string
  'role': string
  'is_invite': boolean
  'enforcing_2fa': boolean
  '2fa_has_access': boolean
  'password_policy_config': { enabled?: boolean } | null
  'password_has_access': boolean
  'enforce_hashed_api_keys': boolean
  'require_apikey_expiration': boolean
  'max_apikey_expiration_days': number | null
}

export interface CliKeyBinding {
  role_name: string
  scope_type: string
  org_id: string | null
  app_id?: string | null
  channel_id?: string | null
  principal_id?: string | null
}

export interface CliKeyPolicy {
  hashed: boolean
  expiresAt: string | null
}

export interface CliApiKeyMetadata {
  id: number
  name: string
  rbac_id: string | null
  created_at: string | null
  expires_at: string | null
  is_hashed_key: boolean
  global_permissions?: string[]
}

export interface CliOwnedKey {
  id: number
  name: string
  key: string | null
  rbac_id: string | null
  created_at: string | null
  expires_at: string | null
}

export interface CliLoginKeyDependencies {
  hasRequiredPermissions: (orgId: string) => Promise<boolean>
  listMetadata: () => Promise<CliApiKeyMetadata[]>
  listOwnedKeys: () => Promise<CliOwnedKey[]>
  listBindings: (principalIds: string[]) => Promise<CliKeyBinding[]>
  createKey: (input: {
    name: string
    hashed: boolean
    expires_at: string | null
    bindings: CliKeyBinding[]
    global_permissions: string[]
  }) => Promise<{ key: string | null }>
}

export type CliLoginKeyPreparation
  = | { status: 'empty', skippedOrganizationNames: string[] }
    | {
      status: 'ready'
      keyName: string
      secret: string
      eligibleOrgIds: string[]
      skippedOrganizationNames: string[]
      policy: CliKeyPolicy
      reused: boolean
    }

const CLI_KEY_NAME = /^Capgo CLI(?: \(([1-9]\d*)\))?$/
const DAY_MS = 86_400_000
const CLOCK_MARGIN_MS = 60_000

export function roleForCliKey(role: string | null | undefined): 'org_admin' | 'org_super_admin' | null {
  if (role === 'owner' || role === 'org_super_admin')
    return 'org_super_admin'
  return role === 'org_admin' ? 'org_admin' : null
}

function managedNameNumber(name: string): number | null {
  const match = CLI_KEY_NAME.exec(name)
  if (!match)
    return null
  if (!match[1])
    return 1
  const value = Number(match[1])
  return value >= 2 ? value : null
}

export function nextManagedCliKeyName(names: string[]): string {
  const used = new Set(names.map(managedNameNumber).filter((value): value is number => value !== null))
  for (let value = 1; ; value++) {
    if (!used.has(value))
      return value === 1 ? 'Capgo CLI' : `Capgo CLI (${value})`
  }
}

export function canonicalizeCliBindings(bindings: CliKeyBinding[]): string[] {
  return bindings.map(binding => [
    binding.role_name,
    binding.scope_type,
    binding.org_id ?? '',
    binding.app_id ?? '',
    binding.channel_id ?? '',
  ].join('|')).sort()
}

export function aggregateCliKeyPolicy(orgs: CliLoginOrganization[], now = new Date()): CliKeyPolicy {
  const requiresExpiration = orgs.some(org => org.require_apikey_expiration)
  if (!requiresExpiration) {
    return {
      hashed: orgs.some(org => org.enforce_hashed_api_keys),
      expiresAt: null,
    }
  }

  const limits = orgs
    .map(org => org.max_apikey_expiration_days)
    .filter((days): days is number => typeof days === 'number' && days > 0)
  const days = limits.length ? Math.min(...limits) : 365
  return {
    hashed: orgs.some(org => org.enforce_hashed_api_keys),
    expiresAt: new Date(now.getTime() + days * DAY_MS - CLOCK_MARGIN_MS).toISOString(),
  }
}

export function isValidCliLoginSession(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{22,}$/.test(value)
}

export function isMatchingCliLoginEvent(
  payload: { event?: string, channel?: string, description?: string },
  session: string,
): boolean {
  return payload.event === 'User CLI login'
    && payload.channel === 'user-login'
    && payload.description === `cli-login:${session}`
}

export function getCliLoginDestination(
  organizationCount: number,
  apps: Array<{ app_id: string, need_onboarding: boolean }>,
): string {
  if (organizationCount !== 1 || apps.length !== 1 || !apps[0].need_onboarding)
    return '/dashboard'
  return `/app/new?resume=${encodeURIComponent(apps[0].app_id)}`
}

function orgPassesStaticChecks(org: CliLoginOrganization): boolean {
  if (org.is_invite || !roleForCliKey(org.role))
    return false
  if (org.enforcing_2fa && !org['2fa_has_access'])
    return false
  return !(org.password_policy_config?.enabled && !org.password_has_access)
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function candidatePolicyAllows(
  key: CliOwnedKey,
  metadata: CliApiKeyMetadata,
  policy: CliKeyPolicy,
  now: Date,
): boolean {
  if (!key.key || metadata.is_hashed_key || policy.hashed)
    return false
  const expiresAt = key.expires_at ? new Date(key.expires_at).getTime() : null
  if (expiresAt !== null && expiresAt <= now.getTime())
    return false
  if (!policy.expiresAt)
    return true
  return expiresAt !== null && expiresAt <= new Date(policy.expiresAt).getTime()
}

export async function prepareCliLoginKey(
  organizations: CliLoginOrganization[],
  dependencies: CliLoginKeyDependencies,
  now = new Date(),
): Promise<CliLoginKeyPreparation> {
  const checks = await Promise.all(organizations.map(async (organization) => {
    if (!orgPassesStaticChecks(organization))
      return { organization, eligible: false }
    const eligible = await dependencies.hasRequiredPermissions(organization.gid).catch(() => false)
    return { organization, eligible }
  }))
  const eligible = checks.filter(check => check.eligible).map(check => check.organization)
  const skippedOrganizationNames = checks.filter(check => !check.eligible).map(check => check.organization.name)
  if (!eligible.length)
    return { status: 'empty', skippedOrganizationNames }

  const expectedBindings: CliKeyBinding[] = eligible.map(organization => ({
    role_name: roleForCliKey(organization.role)!,
    scope_type: 'org',
    org_id: organization.gid,
  }))
  const expectedCanonical = canonicalizeCliBindings(expectedBindings)
  const policy = aggregateCliKeyPolicy(eligible, now)
  const [metadata, ownedKeys] = await Promise.all([
    dependencies.listMetadata(),
    dependencies.listOwnedKeys(),
  ])
  const managedOwnedKeys = ownedKeys.filter(key => managedNameNumber(key.name) !== null)
  const metadataById = new Map(metadata.map(key => [key.id, key]))
  const principalIds = managedOwnedKeys.map(key => key.rbac_id).filter((id): id is string => !!id)
  const allBindings = await dependencies.listBindings(principalIds)

  const candidates = [...managedOwnedKeys].sort((left, right) => {
    const byName = managedNameNumber(left.name)! - managedNameNumber(right.name)!
    return byName || new Date(right.created_at ?? 0).getTime() - new Date(left.created_at ?? 0).getTime()
  })
  for (const key of candidates) {
    const keyMetadata = metadataById.get(key.id)
    if (!keyMetadata || !Array.isArray(keyMetadata.global_permissions) || keyMetadata.global_permissions.length !== 0)
      continue
    const bindings = allBindings.filter(binding => binding.principal_id === key.rbac_id)
    if (!sameStringArray(canonicalizeCliBindings(bindings), expectedCanonical))
      continue
    if (!candidatePolicyAllows(key, keyMetadata, policy, now))
      continue
    return {
      status: 'ready',
      keyName: key.name,
      secret: key.key!,
      eligibleOrgIds: eligible.map(org => org.gid),
      skippedOrganizationNames,
      policy,
      reused: true,
    }
  }

  const keyName = nextManagedCliKeyName(ownedKeys.map(key => key.name))
  const created = await dependencies.createKey({
    name: keyName,
    hashed: policy.hashed,
    expires_at: policy.expiresAt,
    bindings: expectedBindings,
    global_permissions: [],
  })
  if (!created.key)
    throw new Error('CLI API key creation did not return a secret')
  return {
    status: 'ready',
    keyName,
    secret: created.key,
    eligibleOrgIds: eligible.map(org => org.gid),
    skippedOrganizationNames,
    policy,
    reused: false,
  }
}

export function createCliLoginKeyDependencies(
  supabase: SupabaseClient<Database>,
  userId: string,
): CliLoginKeyDependencies {
  return {
    hasRequiredPermissions: orgId => checkPermissions([
      'org.manage_apikeys',
      'org.update_user_roles',
    ], { orgId }),
    listMetadata: async () => {
      const { data, error } = await invokeCapgoApi<CliApiKeyMetadata[]>('apikey', {
        client: supabase,
        method: 'GET',
      })
      if (error)
        throw error
      return data ?? []
    },
    listOwnedKeys: async () => {
      const { data, error } = await supabase
        .from('apikeys')
        .select('id, name, key, rbac_id, created_at, expires_at')
        .eq('user_id', userId)
      if (error)
        throw error
      return data ?? []
    },
    listBindings: async (principalIds) => {
      if (!principalIds.length)
        return []
      const { data, error } = await supabase
        .from('role_bindings')
        .select('principal_id, scope_type, org_id, app_id, channel_id, roles(name)')
        .eq('principal_type', 'apikey')
        .in('principal_id', principalIds)
      if (error)
        throw error
      return (data ?? []).map((row) => {
        const relation = row.roles as { name?: string | null } | Array<{ name?: string | null }> | null
        const role = Array.isArray(relation) ? relation[0] : relation
        return {
          principal_id: row.principal_id,
          role_name: role?.name ?? '',
          scope_type: row.scope_type,
          org_id: row.org_id,
          app_id: row.app_id,
          channel_id: row.channel_id,
        }
      })
    },
    createKey: async (input) => {
      const { data, error } = await invokeCapgoApi<{ key?: string | null }>('apikey', {
        client: supabase,
        method: 'POST',
        body: input,
      })
      if (error)
        throw error
      return { key: data?.key ?? null }
    },
  }
}
