import type { OrganizationSetOptions, PasswordPolicyConfig } from '../schemas/organization'
import { confirm as confirmC, intro, isCancel, log, outro, text } from '@clack/prompts'
import { checkAlerts } from '../api/update'
import {
  assertOrgPermission,
  check2FAAccessForOrg,
  createSupabaseClient,
  findSavedKey,
  formatError,
  resolveCapgoPublicApiHost,
  resolveConfiguredCapgoPublicApiHost,
  sendEvent,
} from '../utils'

interface OrganizationUpdatePayload {
  orgId: string
  name?: string
  management_email?: string
  enforcing_2fa?: boolean
  password_policy_config?: PasswordPolicyConfig | null
  require_apikey_expiration?: boolean
  max_apikey_expiration_days?: number | null
  enforce_hashed_api_keys?: boolean
}

interface OrganizationUpdateResponse {
  data?: {
    id: string
    name: string
    management_email: string
    enforcing_2fa: boolean
  }
  error?: string
  message?: string
}

export const resolveConfiguredOrganizationUpdateApiHost = resolveConfiguredCapgoPublicApiHost

export async function resolveOrganizationUpdateApiHost(options: Pick<OrganizationSetOptions, 'supaHost' | 'supaAnon'>, silent: boolean) {
  return resolveCapgoPublicApiHost(options, silent)
}

async function updateOrganizationViaApi(apikey: string, payload: OrganizationUpdatePayload, silent: boolean, apiHost: string) {
  const response = await fetch(`${apiHost}/organization`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      'capgkey': apikey,
    },
  })

  const responseText = await response.text()
  let body: OrganizationUpdateResponse | undefined
  if (responseText) {
    try {
      body = JSON.parse(responseText) as OrganizationUpdateResponse
    }
    catch {
      body = undefined
    }
  }

  if (!response.ok) {
    const errorMessage = body?.message ?? body?.error ?? response.statusText
    throw new Error(errorMessage || `HTTP ${response.status}`)
  }

  if (!body?.data)
    throw new Error('Invalid organization update response')

  return body.data
}

export async function setOrganizationInternal(
  orgId: string,
  options: OrganizationSetOptions,
  silent = false,
) {
  if (!silent)
    intro('Updating organization')

  await checkAlerts()

  const enrichedOptions: OrganizationSetOptions = {
    ...options,
    apikey: options.apikey || findSavedKey(),
  }

  if (!enrichedOptions.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to update an organization')
    throw new Error('Missing API key')
  }

  if (!orgId) {
    if (!silent)
      log.error('Missing argument, you need to provide an organization ID')
    throw new Error('Missing organization id')
  }

  const supabase = await createSupabaseClient(
    enrichedOptions.apikey,
    enrichedOptions.supaHost,
    enrichedOptions.supaAnon,
  )
  const organizationApiHost = await resolveOrganizationUpdateApiHost(enrichedOptions, silent)
  await assertOrgPermission(supabase, enrichedOptions.apikey, 'org.update_settings', orgId, `Insufficient permissions to update organization ${orgId}`, silent)

  await check2FAAccessForOrg(supabase, orgId, silent)

  const { data: orgData, error: orgError } = await supabase
    .from('orgs')
    .select('name, management_email, created_by, enforcing_2fa, password_policy_config, require_apikey_expiration, max_apikey_expiration_days, enforce_hashed_api_keys')
    .eq('id', orgId)
    .single()

  if (orgError || !orgData) {
    if (!silent)
      log.error(`Cannot get organization details ${formatError(orgError)}`)
    throw new Error(`Cannot get organization details: ${formatError(orgError)}`)
  }

  let { name, email, enforce2fa } = enrichedOptions
  const { passwordPolicy, minLength, requireUppercase, requireNumber, requireSpecial } = enrichedOptions
  const { requireApikeyExpiration, maxApikeyExpirationDays, enforceHashedApiKeys } = enrichedOptions

  // Handle 2FA enforcement changes
  if (enforce2fa !== undefined) {
    if (!silent) {
      if (enforce2fa && !orgData.enforcing_2fa) {
        // Enabling 2FA enforcement - check members and warn
        log.info('Checking organization members 2FA status...')

        const { data: membersStatus, error: membersError } = await supabase
          .rpc('check_org_members_2fa_enabled', { org_id: orgId })

        if (membersError) {
          log.error(`Cannot check members 2FA status: ${formatError(membersError)}`)
          throw new Error('Cannot check members 2FA status')
        }

        // Also check if the current user has 2FA enabled
        const { data: userHas2FA, error: user2FAError } = await supabase
          .rpc('has_2fa_enabled')

        if (user2FAError) {
          log.error(`Cannot check your 2FA status: ${formatError(user2FAError)}`)
          throw new Error('Cannot check your 2FA status')
        }

        // Get current user ID to exclude from member count
        const { data: currentUserId, error: identityError } = await supabase.rpc('request_actor_user_id')

        if (identityError || !currentUserId) {
          log.error(`Cannot get current user identity: ${identityError ? formatError(identityError) : 'No user ID returned'}`)
          throw new Error('Cannot get current user identity')
        }

        // Filter out members without 2FA, excluding the current user (they're warned separately)
        const membersWithout2FA = (membersStatus?.filter(m => !m['2fa_enabled'] && m.user_id !== currentUserId) || [])

        if (membersWithout2FA.length > 0 || !userHas2FA) {
          log.warn('⚠️  Warning: Enabling 2FA enforcement will affect access')
          log.message('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

          if (!userHas2FA) {
            log.warn('🔐 YOU do not have 2FA enabled! By enabling 2FA enforcement, you will LOSE ACCESS to this organization until you enable 2FA on your account.')
          }

          if (membersWithout2FA.length > 0) {
            // Get member details
            const { data: members, error: membersListError } = await supabase
              .rpc('get_org_members', { guild_id: orgId })

            if (membersListError) {
              log.error(`Cannot get organization members: ${formatError(membersListError)}`)
              throw new Error('Cannot get organization members')
            }

            // Create a Map for O(1) lookups instead of O(n) .find() calls
            const membersByUid = new Map(members?.map(m => [m.uid, m]) || [])
            const emails = membersWithout2FA.map((member) => {
              const memberInfo = membersByUid.get(member.user_id)
              return memberInfo?.email || member.user_id
            })

            const memberWord = membersWithout2FA.length === 1 ? 'member does' : 'members do'
            const thisThese = membersWithout2FA.length === 1 ? 'This member will' : 'These members will'
            log.warn(`${membersWithout2FA.length} ${memberWord} not have 2FA enabled: ${emails.join(', ')}`)
            log.warn(`${thisThese} lose access until they enable 2FA.`)
          }

          const shouldContinue = await confirmC({
            message: 'Are you sure you want to enable 2FA enforcement?',
          })

          if (isCancel(shouldContinue) || !shouldContinue) {
            log.error('Canceled enabling 2FA enforcement')
            throw new Error('2FA enforcement cancelled')
          }
        }

        log.info('Enabling 2FA enforcement for organization...')
      }
      else if (!enforce2fa && orgData.enforcing_2fa) {
        log.info('Disabling 2FA enforcement for organization...')
      }
    }

    try {
      await updateOrganizationViaApi(enrichedOptions.apikey, {
        orgId,
        enforcing_2fa: enforce2fa,
      }, silent, organizationApiHost)
    }
    catch (twoFaError) {
      if (!silent)
        log.error(`Could not update 2FA enforcement: ${formatError(twoFaError)}`)
      throw new Error(`Could not update 2FA enforcement: ${formatError(twoFaError)}`)
    }

    if (!silent) {
      if (enforce2fa) {
        log.success('✓ 2FA enforcement enabled for this organization')
      }
      else {
        log.success('✓ 2FA enforcement disabled for this organization')
      }
    }

    // If only changing 2FA enforcement and no other security settings, we can skip the rest
    const hasOtherSecuritySettings = passwordPolicy !== undefined
      || requireApikeyExpiration !== undefined
      || maxApikeyExpirationDays !== undefined
      || enforceHashedApiKeys !== undefined

    if (name === undefined && email === undefined && !hasOtherSecuritySettings) {
      await sendEvent(enrichedOptions.apikey, {
        channel: 'organization',
        event: enforce2fa ? 'Organization 2FA Enabled' : 'Organization 2FA Disabled',
        icon: '🔐',
        org_id: orgId,
        tracking_version: 2,
        tags: {
          'org-name': orgData.name,
          'enforce-2fa': enforce2fa.toString(),
        },
        notify: false,
      }).catch(() => {})

      if (!silent) {
        outro('Done ✅')
      }

      return { orgId, name: orgData.name, email: orgData.management_email, enforce2fa }
    }
  }

  // Handle password policy changes
  if (passwordPolicy !== undefined) {
    if (!silent) {
      if (passwordPolicy) {
        log.info('Configuring password policy for organization...')

        // Check which members will be affected
        const { data: membersStatus, error: membersError } = await supabase
          .rpc('check_org_members_password_policy', { org_id: orgId })

        if (membersError) {
          if (!membersError.message?.includes('NO_RIGHTS')) {
            log.warn(`Cannot check members password policy status: ${formatError(membersError)}`)
          }
        }
        else if (membersStatus) {
          const nonCompliantMembers = membersStatus.filter((m: { password_policy_compliant: boolean }) => !m.password_policy_compliant)
          if (nonCompliantMembers.length > 0) {
            log.warn(`⚠️  Warning: ${nonCompliantMembers.length} member(s) do not meet the password policy requirements`)
            log.warn('These members will need to update their passwords to regain access.')

            const shouldContinue = await confirmC({
              message: 'Are you sure you want to enable the password policy?',
            })

            if (isCancel(shouldContinue) || !shouldContinue) {
              log.error('Canceled enabling password policy')
              throw new Error('Password policy configuration cancelled')
            }
          }
        }
      }
      else {
        log.info('Disabling password policy for organization...')
      }
    }

    const policyConfig: PasswordPolicyConfig = {
      enabled: passwordPolicy,
      min_length: minLength ?? 10,
      require_uppercase: requireUppercase ?? true,
      require_number: requireNumber ?? true,
      require_special: requireSpecial ?? true,
    }

    try {
      await updateOrganizationViaApi(enrichedOptions.apikey, {
        orgId,
        password_policy_config: policyConfig,
      }, silent, organizationApiHost)
    }
    catch (policyError) {
      if (!silent)
        log.error(`Could not update password policy: ${formatError(policyError)}`)
      throw new Error(`Could not update password policy: ${formatError(policyError)}`)
    }

    if (!silent) {
      if (passwordPolicy) {
        log.success('✓ Password policy enabled for this organization')
        log.info(`  - Minimum length: ${policyConfig.min_length} characters`)
        log.info(`  - Require uppercase: ${policyConfig.require_uppercase ? 'Yes' : 'No'}`)
        log.info(`  - Require number: ${policyConfig.require_number ? 'Yes' : 'No'}`)
        log.info(`  - Require special character: ${policyConfig.require_special ? 'Yes' : 'No'}`)
      }
      else {
        log.success('✓ Password policy disabled for this organization')
      }
    }

    // If only changing password policy and no name/email/other settings, we're done
    if (name === undefined && email === undefined
      && enforce2fa === undefined
      && requireApikeyExpiration === undefined
      && maxApikeyExpirationDays === undefined
      && enforceHashedApiKeys === undefined) {
      await sendEvent(enrichedOptions.apikey, {
        channel: 'organization',
        event: passwordPolicy ? 'Password Policy Enabled' : 'Password Policy Disabled',
        icon: '🔑',
        org_id: orgId,
        tracking_version: 2,
        tags: {
          'org-name': orgData.name,
        },
        notify: false,
      }).catch(() => {})

      if (!silent) {
        outro('Done ✅')
      }

      return { orgId, name: orgData.name, email: orgData.management_email, passwordPolicy }
    }
  }

  // Handle API key security settings
  const hasApiKeySettings = requireApikeyExpiration !== undefined
    || maxApikeyExpirationDays !== undefined
    || enforceHashedApiKeys !== undefined

  if (hasApiKeySettings) {
    if (!silent) {
      log.info('Updating API key security settings...')
    }

    // Validate maxApikeyExpirationDays if provided
    if (maxApikeyExpirationDays !== undefined && maxApikeyExpirationDays !== null) {
      if (maxApikeyExpirationDays < 1 || maxApikeyExpirationDays > 365) {
        if (!silent)
          log.error('Maximum API key expiration days must be between 1 and 365')
        throw new Error('Maximum API key expiration days must be between 1 and 365')
      }
    }

    const updateFields: OrganizationUpdatePayload = { orgId }
    if (requireApikeyExpiration !== undefined)
      updateFields.require_apikey_expiration = requireApikeyExpiration
    if (maxApikeyExpirationDays !== undefined)
      updateFields.max_apikey_expiration_days = maxApikeyExpirationDays
    if (enforceHashedApiKeys !== undefined)
      updateFields.enforce_hashed_api_keys = enforceHashedApiKeys

    try {
      await updateOrganizationViaApi(enrichedOptions.apikey, updateFields, silent, organizationApiHost)
    }
    catch (apiKeyError) {
      if (!silent)
        log.error(`Could not update API key settings: ${formatError(apiKeyError)}`)
      throw new Error(`Could not update API key settings: ${formatError(apiKeyError)}`)
    }

    if (!silent) {
      if (requireApikeyExpiration !== undefined) {
        log.success(`✓ API key expiration requirement: ${requireApikeyExpiration ? 'Enabled' : 'Disabled'}`)
      }
      if (maxApikeyExpirationDays !== undefined) {
        if (maxApikeyExpirationDays === null) {
          log.success('✓ Maximum API key expiration days: No limit')
        }
        else {
          log.success(`✓ Maximum API key expiration days: ${maxApikeyExpirationDays}`)
        }
      }
      if (enforceHashedApiKeys !== undefined) {
        log.success(`✓ Hashed API keys enforcement: ${enforceHashedApiKeys ? 'Enabled' : 'Disabled'}`)
      }
    }

    // If only changing API key settings and no name/email, we're done
    if (name === undefined && email === undefined && enforce2fa === undefined && passwordPolicy === undefined) {
      await sendEvent(enrichedOptions.apikey, {
        channel: 'organization',
        event: 'API Key Settings Updated',
        icon: '🔐',
        org_id: orgId,
        tracking_version: 2,
        tags: {
          'org-name': orgData.name,
        },
        notify: false,
      }).catch(() => {})

      if (!silent) {
        outro('Done ✅')
      }

      return { orgId, name: orgData.name, email: orgData.management_email }
    }
  }

  if (!silent && !name) {
    const nameInput = await text({
      message: 'New organization name:',
      placeholder: orgData.name || 'My Organization',
    })

    if (isCancel(nameInput)) {
      log.error('Canceled updating organization')
      throw new Error('Organization update cancelled')
    }
    name = nameInput as string
  }

  if (!silent && !email) {
    const emailInput = await text({
      message: 'Management email:',
      placeholder: orgData.management_email || 'admin@example.com',
    })

    if (isCancel(emailInput)) {
      log.error('Canceled updating organization')
      throw new Error('Organization update cancelled')
    }
    email = emailInput as string
  }

  if (!name || !email) {
    if (!silent)
      log.error('Missing arguments, you need to provide an organization name and management email')
    throw new Error('Missing organization name or management email')
  }

  if (!silent)
    log.info(`Updating organization "${orgId}"`)

  let updatedOrg: Awaited<ReturnType<typeof updateOrganizationViaApi>>
  try {
    updatedOrg = await updateOrganizationViaApi(enrichedOptions.apikey, {
      orgId,
      name,
      management_email: email,
    }, silent, organizationApiHost)
  }
  catch (dbError) {
    if (!silent)
      log.error(`Could not update organization ${formatError(dbError)}`)
    throw new Error(`Could not update organization: ${formatError(dbError)}`)
  }

  await sendEvent(enrichedOptions.apikey, {
    channel: 'organization',
    event: 'Organization Updated',
    icon: '✏️',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'org-name': name,
    },
    notify: false,
  }).catch(() => {})

  if (!silent) {
    log.success('Organization updated')
    outro('Done ✅')
  }

  return { orgId, name: updatedOrg.name, email: updatedOrg.management_email, enforce2fa: enforce2fa ?? updatedOrg.enforcing_2fa }
}

export async function setOrganization(orgId: string, options: OrganizationSetOptions) {
  await setOrganizationInternal(orgId, options, false)
}
