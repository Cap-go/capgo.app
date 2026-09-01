import type { OptionsBase } from '../schemas/base'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { trackEvent } from '../analytics/track'
import { checkAlerts } from '../api/update'
import {
  assertOrgPermission,
  check2FAAccessForOrg,
  fetchOrgMemberComplianceViaHttp,
  findSavedKey,
  formatError,
  invokeCapgoCliApi,
} from '../utils'

interface PasswordPolicyConfig {
  enabled: boolean
  min_length: number
  require_uppercase: boolean
  require_number: boolean
  require_special: boolean
}

interface MemberInfo {
  uid: string
  email: string
  role: string
  is_tmp: boolean
  has_2fa: boolean
  password_policy_compliant: boolean
}

interface DisplayOptions {
  orgName: string
  hasPasswordPolicy: boolean
}

function displayMembers(data: MemberInfo[], options: DisplayOptions, silent: boolean) {
  if (silent)
    return

  if (!data.length) {
    log.error('No members found')
    return
  }

  const t = new Table()
  t.headers = options.hasPasswordPolicy
    ? ['Email', 'Role', 'Status', '2FA Enabled', 'Password Policy']
    : ['Email', 'Role', 'Status', '2FA Enabled']
  t.rows = []

  for (const row of data) {
    const status = row.is_tmp ? 'Invited' : 'Active'
    const has2FA = row.has_2fa ? '✓ Yes' : '✗ No'
    const passwordCompliant = row.password_policy_compliant ? '✓ Compliant' : '✗ Non-compliant'

    const rowData = [
      row.email,
      row.role,
      status,
      has2FA,
    ]

    if (options.hasPasswordPolicy) {
      rowData.push(passwordCompliant)
    }

    t.rows.push(rowData)
  }

  log.success(`Members of "${options.orgName}"`)
  log.success(t.toString())
}

export async function listMembersInternal(orgId: string, options: OptionsBase, silent = false) {
  if (!silent)
    intro('List organization members')

  await checkAlerts()

  const enrichedOptions: OptionsBase = {
    ...options,
    apikey: options.apikey || findSavedKey(),
  }

  if (!enrichedOptions.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to list members')
    throw new Error('Missing API key')
  }

  if (!orgId) {
    if (!silent)
      log.error('Missing argument, you need to provide an organization ID')
    throw new Error('Missing organization id')
  }

  const hostOptions = { supaHost: enrichedOptions.supaHost, supaAnon: enrichedOptions.supaAnon }
  await assertOrgPermission(null, enrichedOptions.apikey, 'org.read_members', orgId, `Insufficient permissions to list members of organization ${orgId}`, silent, hostOptions)
  await check2FAAccessForOrg(enrichedOptions.apikey, orgId, silent, hostOptions)

  const { data: orgData, error: orgError } = await invokeCapgoCliApi<{
    name?: string
    enforcing_2fa?: boolean
    password_policy_config?: PasswordPolicyConfig | null
  }>(`organization?orgId=${encodeURIComponent(orgId)}`, {
    apikey: enrichedOptions.apikey,
    method: 'GET',
    body: undefined,
    ...hostOptions,
  })

  if (orgError || !orgData) {
    if (!silent)
      log.error(`Cannot get organization details: ${formatError(orgError)}`)
    throw new Error(`Cannot get organization details: ${formatError(orgError)}`)
  }

  const passwordPolicyConfig = orgData.password_policy_config as unknown as PasswordPolicyConfig | null
  const hasPasswordPolicy = passwordPolicyConfig?.enabled ?? false

  if (!silent)
    log.info(`Getting members of "${orgData.name}" from Capgo`)

  // Get members via HTTP
  const { data: members, error: membersError } = await invokeCapgoCliApi<Array<{
    uid: string
    email: string
    role: string
    is_tmp: boolean
  }>>(`organization/members?orgId=${encodeURIComponent(orgId)}`, {
    apikey: enrichedOptions.apikey!,
    method: 'GET',
    body: undefined,
    supaHost: enrichedOptions.supaHost,
    supaAnon: enrichedOptions.supaAnon,
  })

  if (membersError) {
    if (!silent)
      log.error(`Cannot get organization members: ${formatError(membersError)}`)
    throw new Error(`Cannot get organization members: ${formatError(membersError)}`)
  }

  const { data: compliance } = await fetchOrgMemberComplianceViaHttp(enrichedOptions.apikey!, orgId, hostOptions)
  const membersStatus = compliance?.members_2fa
  if (compliance?.members_2fa_error) {
    if (!silent) {
      if (compliance.members_2fa_error.includes('NO_RIGHTS')) {
        log.warn('You need super_admin rights to view 2FA status of members')
      }
      else {
        log.error(`Cannot get 2FA status: ${compliance.members_2fa_error}`)
      }
    }
  }

  let passwordPolicyStatus: Array<{ user_id: string, password_policy_compliant: boolean }> | null = null
  if (hasPasswordPolicy) {
    passwordPolicyStatus = compliance?.members_password ?? null
    if (compliance?.members_password_error) {
      if (!silent) {
        if (compliance.members_password_error.includes('NO_RIGHTS')) {
          log.warn('You need super_admin rights to view password policy compliance status')
        }
        else {
          log.warn(`Cannot get password policy status: ${compliance.members_password_error}`)
        }
      }
    }
  }

  // Merge member info with 2FA status and password policy status
  const memberInfoList: MemberInfo[] = (members || []).map((m) => {
    const twoFaStatus = membersStatus?.find(s => s.user_id === m.uid)
    const pwPolicyStatus = passwordPolicyStatus?.find(s => s.user_id === m.uid)
    return {
      uid: m.uid,
      email: m.email,
      role: m.role,
      is_tmp: m.is_tmp,
      has_2fa: twoFaStatus?.['2fa_enabled'] ?? false,
      password_policy_compliant: pwPolicyStatus?.password_policy_compliant ?? false,
    }
  })

  void trackEvent({ channel: 'organization', event: 'Org Members Listed', tags: { member_count: memberInfoList.length, with_2fa_count: memberInfoList.filter(m => m.has_2fa).length } })

  if (!silent) {
    log.info(`Members found: ${memberInfoList.length}`)

    // Display security enforcement status
    log.info('')
    log.info('Security Settings:')
    if (orgData.enforcing_2fa) {
      log.info(`  🔐 2FA enforcement: ENABLED`)
    }
    else {
      log.info(`  2FA enforcement: Disabled`)
    }

    if (hasPasswordPolicy) {
      log.info(`  🔑 Password policy: ENABLED`)
      log.info(`     - Minimum length: ${passwordPolicyConfig!.min_length} characters`)
      log.info(`     - Require uppercase: ${passwordPolicyConfig!.require_uppercase ? 'Yes' : 'No'}`)
      log.info(`     - Require number: ${passwordPolicyConfig!.require_number ? 'Yes' : 'No'}`)
      log.info(`     - Require special: ${passwordPolicyConfig!.require_special ? 'Yes' : 'No'}`)
    }
    else {
      log.info(`  Password policy: Disabled`)
    }

    if (orgData.require_apikey_expiration) {
      log.info(`  ⏰ API key expiration required: ENABLED`)
      if (orgData.max_apikey_expiration_days) {
        log.info(`     - Maximum expiration: ${orgData.max_apikey_expiration_days} days`)
      }
    }
    else {
      log.info(`  API key expiration required: Disabled`)
    }

    if (orgData.enforce_hashed_api_keys) {
      log.info(`  🔒 Hashed API keys: ENABLED`)
    }
    else {
      log.info(`  Hashed API keys: Disabled`)
    }

    log.info('')

    // Display member summary
    const activeMembers = memberInfoList.filter(m => !m.is_tmp)
    const membersWithout2FA = activeMembers.filter(m => !m.has_2fa)

    log.info('Member Summary:')
    log.info(`  Total active members: ${activeMembers.length}`)
    log.info(`  Members with 2FA: ${activeMembers.length - membersWithout2FA.length}`)
    log.info(`  Members without 2FA: ${membersWithout2FA.length}`)

    if (hasPasswordPolicy) {
      const membersNonCompliant = activeMembers.filter(m => !m.password_policy_compliant)
      log.info(`  Password policy compliant: ${activeMembers.length - membersNonCompliant.length}`)
      log.info(`  Password policy non-compliant: ${membersNonCompliant.length}`)
    }

    log.info('')

    displayMembers(memberInfoList, { orgName: orgData.name, hasPasswordPolicy }, silent)
    outro('Done ✅')
  }

  return memberInfoList
}

export async function listMembers(orgId: string, options: OptionsBase) {
  await listMembersInternal(orgId, options, false)
}
