import type { OptionsBase } from '../schemas/base'
import type { Organization } from '../utils'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { trackEvent } from '../analytics/track'
import { checkAlerts } from '../api/update'
import {
  consoleWebUrl,
  createSupabaseClient,
  findSavedKey,
  formatError,
  resolveUserIdFromApiKey,
} from '../utils'

function displayOrganizations(data: Organization[], silent: boolean) {
  if (silent)
    return

  if (!data.length) {
    log.error('No organizations found')
    return
  }

  const t = new Table()
  t.headers = ['Name', 'ID', 'Role', 'Apps', '2FA Required', '2FA Access']
  t.rows = []

  for (const row of data.toReversed()) {
    const twoFaRequired = row.enforcing_2fa ? '✓ Yes' : '✗ No'
    const twoFaAccess = row['2fa_has_access'] ? '✓ Yes' : '✗ No'

    t.rows.push([
      row.name ?? 'Unknown',
      row.gid,
      row.role,
      row.app_count?.toString() || '0',
      twoFaRequired,
      twoFaAccess,
    ])
  }

  log.success('Organizations')
  log.success(t.toString())

  // Warn about organizations where user doesn't have 2FA access
  const noAccessOrgs = data.filter(org => org.enforcing_2fa && !org['2fa_has_access'])
  if (noAccessOrgs.length > 0) {
    log.warn(`\n⚠️  You don't have access to ${noAccessOrgs.length} organization(s) due to 2FA enforcement:`)
    for (const org of noAccessOrgs) {
      log.warn(`   - ${org.name} (${org.gid})`)
    }
    log.warn(`\nTo regain access, enable 2FA on your account at ${consoleWebUrl('/settings/account')}`)
  }
}

export async function listOrganizationsInternal(options: OptionsBase, silent = false) {
  if (!silent)
    intro('List organizations')

  await checkAlerts()

  const enrichedOptions: OptionsBase = {
    ...options,
    apikey: options.apikey || findSavedKey(),
  }

  if (!enrichedOptions.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to list organizations')
    throw new Error('Missing API key')
  }

  const supabase = await createSupabaseClient(
    enrichedOptions.apikey,
    enrichedOptions.supaHost,
    enrichedOptions.supaAnon,
  )
  await resolveUserIdFromApiKey(supabase, enrichedOptions.apikey)

  if (!silent)
    log.info('Getting organizations from Capgo')

  const { error, data: allOrganizations } = await supabase.rpc('get_orgs_v7')

  if (error) {
    if (!silent)
      log.error(`Cannot get organizations ${formatError(error)}`)
    throw new Error(`Cannot get organizations: ${formatError(error)}`)
  }

  const organizations = allOrganizations || []

  void trackEvent({ channel: 'organization', event: 'Orgs Listed', icon: '📋', tags: { org_count: organizations.length } })

  if (!silent) {
    log.info(`Organizations found: ${organizations.length}`)
    displayOrganizations(organizations, silent)
    outro('Done ✅')
  }

  return organizations
}

export async function listOrganizations(options: OptionsBase) {
  await listOrganizationsInternal(options, false)
}
