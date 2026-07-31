import type { SupabaseClient } from '@supabase/supabase-js'
import type { OptionsBase } from '../schemas/base'
import type { Database } from '../types/supabase.types'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { trackEvent, withSupabaseSource } from '../analytics/track'
import { checkAlerts } from '../api/update'
import { createSupabaseClient, findSavedKey, getHumanDate, resolveUserIdFromApiKey } from '../utils'

function displayApps(data: Database['public']['Tables']['apps']['Row'][]) {
  const table = new Table()
  table.headers = ['Name', 'id', 'Created']
  table.rows = []

  for (const row of data.toReversed())
    table.rows.push([row.name ?? '', row.app_id, getHumanDate(row.created_at)])

  log.success('Apps')
  log.success(table.toString())
}

async function getActiveApps(supabase: SupabaseClient<Database>, silent: boolean, orgIds: string[]) {
  // Scope the list to the caller's orgs. An unfiltered apps select makes Postgres
  // evaluate per-row RBAC across the entire apps table, which can hit the
  // statement timeout on large databases and surface as "Apps not found".
  // Filtering by owner_org first restricts the rows RLS evaluates to the caller's.
  const { data, error } = await withSupabaseSource('apps.list', () => supabase
    .from('apps')
    .select()
    .in('owner_org', orgIds)
    .order('created_at', { ascending: false }))

  if (error) {
    if (!silent)
      log.error('Apps not found')
    throw new Error('Apps not found')
  }

  return data ?? []
}

export async function listAppInternal(options: OptionsBase, silent = false) {
  if (!silent)
    intro('List apps in Capgo')

  await checkAlerts()

  options.apikey = options.apikey || findSavedKey()

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)

  await resolveUserIdFromApiKey(supabase, options.apikey)

  if (!silent)
    log.info('Getting active bundle in Capgo')

  // Resolve the orgs this identity can access (RBAC-aware, SECURITY DEFINER — works for
  // both API keys and logged-in sessions) so the list can be scoped to them. Without
  // this, the unfiltered apps query times out on large databases (see getActiveApps).
  const { data: orgs, error: orgsError } = await supabase.rpc('get_orgs_v6')
  if (orgsError) {
    if (!silent)
      log.error('Could not load your organizations')
    throw new Error(`Could not load organizations: ${orgsError.message}`)
  }
  const orgIds = (orgs ?? []).map(org => org.gid).filter(Boolean)
  if (!orgIds.length) {
    if (!silent)
      log.error('No apps found')
    throw new Error('No apps found')
  }

  const allApps = await getActiveApps(supabase, silent, orgIds)

  void trackEvent({ channel: 'app', event: 'Apps Listed', icon: '📋', tags: { app_count: allApps.length } })

  if (!allApps.length) {
    if (!silent)
      log.error('No apps found')
    throw new Error('No apps found')
  }

  if (!silent) {
    log.info(`Active app in Capgo: ${allApps.length}`)
    displayApps(allApps)
    outro('Done ✅')
  }

  return allApps
}

export async function listApp(options: OptionsBase) {
  return listAppInternal(options, false)
}
