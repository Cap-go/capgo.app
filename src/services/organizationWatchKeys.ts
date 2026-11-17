/**
 * Stable watch keys for the current organization.
 *
 * The organization store replaces the current organization object whenever it
 * refetches the list or finishes loading a signed logo. Watching the object
 * reran every page loader (and the dashboard refresh) on each of those swaps.
 * These keys only change when the fields a watcher actually depends on change.
 */

type OrganizationLike = Partial<Record<string, unknown>> & { gid?: string | null, role?: string | null }

function keyOf(org: OrganizationLike | null | undefined, fields: readonly string[]): string {
  if (!org?.gid)
    return ''
  return JSON.stringify([org.gid, ...fields.map(field => org[field] ?? null)])
}

/** Organization identity and the caller's role in it. */
export function organizationIdentityKey(org: OrganizationLike | null | undefined): string {
  return keyOf(org, ['role'])
}

/** Identity plus the access gates (2FA / password policy) pages check before loading. */
export function organizationAccessKey(org: OrganizationLike | null | undefined): string {
  return keyOf(org, ['role', 'enforcing_2fa', '2fa_has_access', 'password_policy_config', 'password_has_access'])
}

/** Identity plus every security setting the security page reads from the organization. */
export function organizationSecurityKey(org: OrganizationLike | null | undefined): string {
  return keyOf(org, [
    'role',
    'enforcing_2fa',
    '2fa_has_access',
    'password_policy_config',
    'password_has_access',
    'enforce_hashed_api_keys',
    'enforce_encrypted_bundles',
    'required_encryption_key',
    'require_apikey_expiration',
    'max_apikey_expiration_days',
  ])
}

/** Identity plus the billing state the plans page derives its data from. */
export function organizationBillingKey(org: OrganizationLike | null | undefined): string {
  return keyOf(org, ['role', 'paying', 'is_yearly', 'trial_left', 'can_use_more', 'is_canceled', 'subscription_start', 'subscription_end'])
}

/** Identity plus the settings fields shown on the organization settings page. */
export function organizationSettingsKey(org: OrganizationLike | null | undefined): string {
  return keyOf(org, ['role', 'name', 'management_email'])
}
