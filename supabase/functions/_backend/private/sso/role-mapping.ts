import { z } from 'zod'

// Supabase Auth attribute_mapping key under which the IdP attribute used for
// role mapping is captured. Unknown keys land in identity_data.custom_claims,
// refreshed by Supabase Auth on every SAML login.
export const SSO_ROLE_SOURCE_CLAIM = 'capgo_role_source'

// Ordered from least to most privileged: when several rules match, the
// highest role wins.
export const SSO_MAPPABLE_ORG_ROLES = ['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin'] as const
export const SSO_MAPPABLE_APP_ROLES = ['app_reader', 'app_uploader', 'app_developer', 'app_admin'] as const
export type SsoOrgRole = typeof SSO_MAPPABLE_ORG_ROLES[number]
export type SsoAppRole = typeof SSO_MAPPABLE_APP_ROLES[number]

const orgRoleSchema = z.enum(SSO_MAPPABLE_ORG_ROLES)

export const roleMappingSchema = z.object({
  attribute: z.string().trim().min(1).max(256),
  rules: z.array(z.object({
    value: z.string().trim().min(1).max(256),
    org_role: orgRoleSchema.nullable().default(null),
    apps: z.array(z.object({
      app_id: z.uuid(),
      role: z.enum(SSO_MAPPABLE_APP_ROLES),
    })).max(100).default([]),
    group_id: z.uuid().nullable().default(null),
  }).refine(rule => rule.org_role !== null || rule.apps.length > 0 || rule.group_id !== null, {
    message: 'Each rule must grant an org role, an app role or a group',
  })).max(100),
  // Org role when no matching rule grants one; null = no access.
  default_role: orgRoleSchema.nullable(),
})

export type SsoRoleMapping = z.infer<typeof roleMappingSchema>

export interface SsoAccess {
  orgRole: SsoOrgRole | null
  // app uuid -> role, for the apps the user matches.
  appRoles: Record<string, SsoAppRole>
  groupIds: string[]
  // Every app and group referenced by the mapping: the user's bindings and
  // memberships on them are owned by SSO and removed when they stop matching.
  managedAppIds: string[]
  managedGroupIds: string[]
}

export function parseStoredRoleMapping(value: unknown): SsoRoleMapping | null {
  if (value === null || value === undefined)
    return null
  const parsed = roleMappingSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function readRoleSourceValues(identityData: unknown): string[] {
  const customClaims = (identityData as { custom_claims?: Record<string, unknown> } | null)?.custom_claims
  const raw = customClaims?.[SSO_ROLE_SOURCE_CLAIM]
  const values = Array.isArray(raw) ? raw : [raw]
  return values.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean)
}

function highest<T extends string>(order: readonly T[], roles: T[]): T | null {
  return roles.reduce<T | null>((best, role) => best === null || order.indexOf(role) > order.indexOf(best) ? role : best, null)
}

function unique(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))]
}

// The user gets the highest org role and, per app, the highest app role
// granted by any matching rule. Without an org role there is no org access,
// so no app role or group either.
export function resolveSsoAccess(mapping: SsoRoleMapping, attributeValues: string[]): SsoAccess {
  const values = new Set(attributeValues)
  const matching = mapping.rules.filter(rule => values.has(rule.value))
  const orgRole = highest(SSO_MAPPABLE_ORG_ROLES, matching.flatMap(rule => rule.org_role ?? [])) ?? mapping.default_role
  const managedAppIds = unique(mapping.rules.flatMap(rule => rule.apps.map(app => app.app_id)))
  const managedGroupIds = unique(mapping.rules.map(rule => rule.group_id))
  if (orgRole === null)
    return { orgRole, appRoles: {}, groupIds: [], managedAppIds, managedGroupIds }

  const appRoles: Record<string, SsoAppRole> = {}
  for (const appId of managedAppIds) {
    const role = highest(SSO_MAPPABLE_APP_ROLES, matching.flatMap(rule => rule.apps.filter(app => app.app_id === appId).map(app => app.role)))
    if (role)
      appRoles[appId] = role
  }
  return { orgRole, appRoles, groupIds: unique(matching.map(rule => rule.group_id)), managedAppIds, managedGroupIds }
}
