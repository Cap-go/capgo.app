import { z } from 'zod'

// Supabase Auth attribute_mapping key under which the IdP attribute used for
// role mapping is captured. Unknown keys land in identity_data.custom_claims,
// refreshed by Supabase Auth on every SAML login.
export const SSO_ROLE_SOURCE_CLAIM = 'capgo_role_source'

export const SSO_MAPPABLE_ORG_ROLES = ['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin'] as const
export type SsoMappableOrgRole = typeof SSO_MAPPABLE_ORG_ROLES[number]

const roleSchema = z.enum(SSO_MAPPABLE_ORG_ROLES)

export const roleMappingSchema = z.object({
  attribute: z.string().trim().min(1).max(256),
  rules: z.array(z.object({
    value: z.string().trim().min(1).max(256),
    role: roleSchema.nullable().default(null),
    group_id: z.uuid().nullable().default(null),
  }).refine(rule => rule.role !== null || rule.group_id !== null, {
    message: 'Each rule must grant a role, a group, or both',
  })).max(100),
  // null = no access when no rule grants a role.
  default_role: roleSchema.nullable(),
})

export type SsoRoleMapping = z.infer<typeof roleMappingSchema>

export interface SsoAccess {
  role: SsoMappableOrgRole | null
  groupIds: string[]
  // Every group referenced by the mapping: memberships in these groups are
  // owned by SSO and removed when the user stops matching.
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

// Role: the first matching rule that grants one (rule order = priority), else
// default_role. Groups: every matching rule. No role means no access, so no
// group either.
export function resolveSsoAccess(mapping: SsoRoleMapping, attributeValues: string[]): SsoAccess {
  const values = new Set(attributeValues)
  const matching = mapping.rules.filter(rule => values.has(rule.value))
  const role = matching.find(rule => rule.role !== null)?.role ?? mapping.default_role
  const managedGroupIds = [...new Set(mapping.rules.map(rule => rule.group_id).filter((id): id is string => id !== null))]
  const groupIds = role === null
    ? []
    : [...new Set(matching.map(rule => rule.group_id).filter((id): id is string => id !== null))]
  return { role, groupIds, managedGroupIds }
}
