import type { OptionsBase } from '../schemas/base'
import type { Database } from '../types/supabase.types'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { trackEvent } from '../analytics/track'
import { checkAlerts } from '../api/update'
import { createSupabaseClient, findSavedKey, formatError, getHumanDate, invokeCapgoCliApi, resolveUserIdFromApiKey } from '../utils'

interface AppListOptions extends OptionsBase {
  showOrg?: boolean
  showOrgId?: boolean
}

type AppRow = Database['public']['Tables']['apps']['Row']

export function getAppListHeaders(options: AppListOptions) {
  const headers = ['Name', 'id']
  if (options.showOrg)
    headers.push('Organization')
  headers.push('Created')
  if (options.showOrgId)
    headers.push('Organization ID')
  return headers
}

export function getAppListRow(row: AppRow, options: AppListOptions, orgNames: Map<string, string>) {
  const values = [row.name ?? '', row.app_id]
  if (options.showOrg)
    values.push(orgNames.get(row.owner_org) ?? 'Unknown')
  values.push(getHumanDate(row.created_at))
  if (options.showOrgId)
    values.push(row.owner_org)
  return values
}

function displayApps(data: AppRow[], options: AppListOptions, orgNames: Map<string, string>) {
  const table = new Table()
  table.headers = getAppListHeaders(options)
  table.rows = []

  for (const row of data.toReversed())
    table.rows.push(getAppListRow(row, options, orgNames))

  log.success('Apps')
  log.success(table.toString())
}

async function getActiveApps(
  apikey: string,
  silent: boolean,
  options: { supaHost?: string, supaAnon?: string },
) {
  const all: Database['public']['Tables']['apps']['Row'][] = []
  let page = 0
  while (true) {
    const { data, error } = await invokeCapgoCliApi<Database['public']['Tables']['apps']['Row'][]>(
      `app?page=${page}`,
      {
        apikey,
        method: 'GET',
        body: undefined,
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      },
    )

    if (error) {
      if (!silent)
        log.error('Apps not found')
      throw new Error(`Apps not found: ${formatError(error)}`)
    }

    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    all.push(...batch)
    if (batch.length < 50)
      break
    page += 1
  }

  return all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

export async function listAppInternal(options: AppListOptions, silent = false) {
  if (!silent)
    intro('List apps in Capgo')

  await checkAlerts()

  options.apikey = options.apikey || findSavedKey()

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)

  // TODO(cli-http): identity still uses rpc via resolveUserIdFromApiKey
  await resolveUserIdFromApiKey(supabase, options.apikey)

  if (!silent)
    log.info('Getting active bundle in Capgo')

  // TODO(cli-http): previously scoped via get_orgs_v6; GET app already scopes to key orgs server-side
  const allApps = await getActiveApps(options.apikey!, silent, {
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  void trackEvent({ channel: 'app', event: 'Apps Listed', tags: { app_count: allApps.length } })

  if (!allApps.length) {
    if (!silent)
      log.error('No apps found')
    throw new Error('No apps found')
  }

  if (!silent) {
    const orgNames = new Map<string, string>()
    if (options.showOrg) {
      const { data, error } = await supabase.rpc('get_orgs_v7')
      if (error)
        throw new Error(`Cannot get organizations: ${formatError(error)}`)
      for (const org of data ?? [])
        orgNames.set(org.gid, org.name ?? 'Unknown')
    }

    log.info(`Active app in Capgo: ${allApps.length}`)
    displayApps(allApps, options, orgNames)
    outro('Done ✅')
  }

  return allApps
}

export async function listApp(options: AppListOptions, silent = false) {
  return listAppInternal(options, silent)
}
