import type { OptionsBase } from '../schemas/base'
import type { Database } from '../types/supabase.types'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { trackEvent } from '../analytics/track'
import { checkAlerts } from '../api/update'
import { createSupabaseClient, findSavedKey, formatError, getHumanDate, invokeCapgoCliApi, resolveUserIdFromApiKey } from '../utils'

interface AppListOptions extends OptionsBase {
  filterByOrgId?: string
}

export const APP_LIST_ORG_FILTER_WARNING = 'You have passed "--filter-by-org-id". You might have access to more apps. Remove the filter to see all apps'

export function getAppListPath(page: number, orgId?: string) {
  const query = new URLSearchParams({ page: String(page) })
  if (orgId)
    query.set('org_id', orgId)
  return `app?${query.toString()}`
}

function displayApps(data: Database['public']['Tables']['apps']['Row'][]) {
  const table = new Table()
  table.headers = ['Name', 'id', 'Created']
  table.rows = []

  for (const row of data.toReversed())
    table.rows.push([row.name ?? '', row.app_id, getHumanDate(row.created_at)])

  log.success('Apps')
  log.success(table.toString())
}

async function getActiveApps(
  apikey: string,
  silent: boolean,
  options: { supaHost?: string, supaAnon?: string, filterByOrgId?: string },
) {
  const all: Database['public']['Tables']['apps']['Row'][] = []
  let page = 0
  while (true) {
    const { data, error } = await invokeCapgoCliApi<Database['public']['Tables']['apps']['Row'][]>(
      getAppListPath(page, options.filterByOrgId),
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

  if (!silent) {
    if (options.filterByOrgId)
      log.warn(APP_LIST_ORG_FILTER_WARNING)
    log.info('Getting active bundle in Capgo')
  }

  // TODO(cli-http): previously scoped via get_orgs_v6; GET app already scopes to key orgs server-side
  const allApps = await getActiveApps(options.apikey!, silent, {
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
    filterByOrgId: options.filterByOrgId,
  })

  void trackEvent({ channel: 'app', event: 'Apps Listed', tags: { app_count: allApps.length } })

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

export async function listApp(options: AppListOptions, silent = false) {
  return listAppInternal(options, silent)
}
