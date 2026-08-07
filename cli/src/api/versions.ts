import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { log } from '@clack/prompts'
import { Table } from '@sauber/table'
import { formatError, getHumanDate } from '../utils'
import { checkVersionNotUsedInChannel } from './channels'

interface VersionOptions {
  silent?: boolean
}

interface DeleteSpecificVersionOptions extends VersionOptions {
  autoUnlink?: boolean
}

export async function deleteAppVersion(
  supabase: SupabaseClient<Database>,
  appid: string,
  bundle: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options

  const { error: delAppSpecVersionError } = await supabase
    .from('app_versions')
    .update({ deleted: true })
    .eq('app_id', appid)
    .eq('deleted', false)
    .eq('name', bundle)

  if (delAppSpecVersionError) {
    const message = `App version ${appid}@${bundle} not found in database`
    if (!silent)
      log.error(message)
    throw new Error(`${message}: ${formatError(delAppSpecVersionError)}`)
  }
}

export async function deleteSpecificVersion(
  supabase: SupabaseClient<Database>,
  appid: string,
  bundle: string,
  options: DeleteSpecificVersionOptions = {},
) {
  const { silent = false, autoUnlink = false } = options
  const versionData = await getVersionData(supabase, appid, bundle, { silent })
  await checkVersionNotUsedInChannel(supabase, appid, versionData, { silent, autoUnlink })
  await deleteAppVersion(supabase, appid, bundle, { silent })
}

export function displayBundles(
  data: (Database['public']['Tables']['app_versions']['Row'] & { keep?: string })[],
  silent = false,
) {
  if (silent)
    return

  if (!data.length) {
    log.info('No bundles found')
    return
  }

  const t = new Table()
  t.theme = Table.roundTheme
  t.headers = ['Version', 'Created', 'Keep']
  t.rows = []

  for (const row of data.toReversed()) {
    t.rows.push([
      row.name,
      getHumanDate(row.created_at),
      row.keep ?? '',
    ])
  }

  log.success('Bundles')
  log.success(t.toString())
}

export async function getActiveAppVersions(
  supabase: SupabaseClient<Database>,
  appid: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options

  const { data, error: vError } = await supabase
    .from('app_versions')
    .select()
    .eq('app_id', appid)
    .eq('deleted', false)
    .order('created_at', { ascending: false })

  if (vError) {
    const message = `App ${appid} not found in database`
    if (!silent)
      log.error(message)
    throw new Error(`${message}: ${formatError(vError)}`)
  }

  return data ?? []
}

export async function getChannelsVersion(
  supabase: SupabaseClient<Database>,
  appid: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options

  const { data: channels, error: channelsError } = await supabase
    .from('channels')
    .select('version')
    .eq('app_id', appid)

  if (channelsError) {
    const message = `App ${appid} not found in database`
    if (!silent)
      log.error(message)
    throw new Error(`${message}: ${formatError(channelsError)}`)
  }

  return (channels ?? []).map(c => c.version)
}

export async function getVersionData(
  supabase: SupabaseClient<Database>,
  appid: string,
  bundle: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options

  const { data: versionData, error: versionIdError } = await supabase
    .from('app_versions')
    .select()
    .eq('app_id', appid)
    .eq('name', bundle)
    .eq('deleted', false)
    .single()

  if (!versionData || versionIdError) {
    const message = `App version ${appid}@${bundle} doesn't exist`
    if (!silent)
      log.error(message)
    throw new Error(`${message}${versionIdError ? `: ${formatError(versionIdError)}` : ''}`)
  }

  return versionData
}
