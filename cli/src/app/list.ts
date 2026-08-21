import type { OptionsBase } from '../schemas/base'
import type { Database } from '../types/supabase.types'
import { stderr, stdout } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { trackEvent } from '../analytics/track'
import { checkAlerts } from '../api/update'
import { createSupabaseClient, findSavedKey, formatError, getHumanDate, invokeCapgoCliApi, resolveUserIdFromApiKey } from '../utils'

interface AppListOptions extends OptionsBase {
  outputText?: boolean
}

function writePlain(message: string) {
  stdout.write(`${message}\n`)
}

function escapeCsv(value: string) {
  const safeValue = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue
}

export function formatAppsCsv(data: Database['public']['Tables']['apps']['Row'][]) {
  const rows = data.toReversed().map(row => [row.name ?? '', row.app_id, getHumanDate(row.created_at)])
  return [['Name', 'id', 'Created'], ...rows].map(row => row.map(escapeCsv).join(',')).join('\n')
}

export function formatAppListText(data: Database['public']['Tables']['apps']['Row'][]) {
  return `Getting active bundle in Capgo\n\nActive app in Capgo: ${data.length}\n\nApps (CSV)\n${formatAppsCsv(data)}\n\nDone ✅`
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
  const outputText = !silent && options.outputText
  if (!silent && !outputText)
    intro('List apps in Capgo')

  await checkAlerts(outputText ? { warn: message => stderr.write(`${message}\n`) } : undefined)

  if (outputText && options.apikey)
    writePlain('Use provided API key')
  options.apikey = options.apikey || findSavedKey(false, outputText ? writePlain : undefined)

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon, Boolean(outputText))

  // TODO(cli-http): identity still uses rpc via resolveUserIdFromApiKey
  await resolveUserIdFromApiKey(supabase, options.apikey)

  if (!silent && !outputText)
    log.info('Getting active bundle in Capgo')

  // TODO(cli-http): previously scoped via get_orgs_v6; GET app already scopes to key orgs server-side
  const allApps = await getActiveApps(options.apikey!, silent || Boolean(outputText), {
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  void trackEvent({ channel: 'app', event: 'Apps Listed', tags: { app_count: allApps.length } })

  if (!allApps.length) {
    if (!silent && !outputText)
      log.error('No apps found')
    throw new Error('No apps found')
  }

  if (!silent) {
    if (outputText) {
      writePlain(`\n${formatAppListText(allApps)}`)
    }
    else {
      log.info(`Active app in Capgo: ${allApps.length}`)
      displayApps(allApps)
      outro('Done ✅')
    }
  }

  return allApps
}

export async function listApp(options: AppListOptions, silent = false) {
  return listAppInternal(options, silent)
}
