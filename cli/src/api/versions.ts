import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { log } from '@clack/prompts'
import { Table } from '@sauber/table'
import { CliUserError } from '../shared/cli-user-error'
import { formatError, getHumanDate, invokeCapgoCliApi, readCapgoCliApiErrorPayload } from '../utils'
import { checkVersionNotUsedInChannel } from './channels'

interface VersionOptions {
  silent?: boolean
  apikey?: string
  supaHost?: string
  supaAnon?: string
}

interface DeleteSpecificVersionOptions extends VersionOptions {
  autoUnlink?: boolean
}

interface CapgoHttpOptions {
  apikey: string
  silent?: boolean
  supaHost?: string
  supaAnon?: string
}

const BUNDLE_PAGE_SIZE = 50

async function isEmptyBundleListError(error: unknown) {
  const payload = await readCapgoCliApiErrorPayload(error)
  return payload?.error === 'cannot_get_bundle' && payload?.message === 'Cannot get bundle'
}

async function fetchBundlePages(appid: string, options: CapgoHttpOptions) {
  const all: Database['public']['Tables']['app_versions']['Row'][] = []
  let page = 0
  while (true) {
    const params = new URLSearchParams({ app_id: appid, page: String(page) })
    const { data, error } = await invokeCapgoCliApi<Database['public']['Tables']['app_versions']['Row'][]>(
      `bundle?${params.toString()}`,
      {
        apikey: options.apikey,
        method: 'GET',
        body: undefined,
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      },
    )
    if (error) {
      if (page === 0 && await isEmptyBundleListError(error))
        return []
      throw error
    }
    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    all.push(...batch)
    if (batch.length < BUNDLE_PAGE_SIZE)
      break
    page += 1
  }
  return all
}

export async function deleteAppVersion(
  supabase: SupabaseClient<Database> | null,
  appid: string,
  bundle: string,
  options: VersionOptions = {},
) {
  const { silent = false, apikey, supaHost, supaAnon } = options

  // Soft-delete via PostgREST when a client is provided. HTTP DELETE /bundle
  // rejects bundles still linked to a channel; admin channel cleanup needs this path.
  if (supabase) {
    const { error: delAppSpecVersionError } = await supabase
      .from('app_versions')
      .update({ deleted: true })
      .eq('app_id', appid)
      .eq('deleted', false)
      .eq('name', bundle)

    if (delAppSpecVersionError) {
      if (!silent)
        log.error(`App version ${appid}@${bundle} not found in database`)
      throw new CliUserError('App version not found in database', {
        appId: appid,
        version: bundle,
        detail: formatError(delAppSpecVersionError),
      })
    }
    return
  }

  if (!apikey)
    throw new Error('Missing API key for bundle delete')

  const { error } = await invokeCapgoCliApi('bundle', {
    apikey,
    method: 'DELETE',
    body: { app_id: appid, version: bundle },
    supaHost,
    supaAnon,
  })
  if (error) {
    if (!silent)
      log.error(`App version ${appid}@${bundle} not found in database`)
    throw new CliUserError('App version not found in database', {
      appId: appid,
      version: bundle,
      detail: formatError(error),
    })
  }
}

export async function deleteSpecificVersion(
  supabase: SupabaseClient<Database>,
  appid: string,
  bundle: string,
  options: DeleteSpecificVersionOptions = {},
) {
  const { silent = false, autoUnlink = false, apikey, supaHost, supaAnon } = options
  if (!apikey)
    throw new Error('Missing API key for bundle delete')
  const versionData = await getVersionData(apikey, appid, bundle, { silent, apikey, supaHost, supaAnon })
  await checkVersionNotUsedInChannel(supabase, appid, versionData, { silent, autoUnlink, apikey, supaHost, supaAnon })
  await deleteAppVersion(null, appid, bundle, { silent, apikey, supaHost, supaAnon })
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
  apikeyOrClient: string | SupabaseClient<Database>,
  appid: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options
  const apikey = typeof apikeyOrClient === 'string' ? apikeyOrClient : options.apikey
  if (!apikey) {
    throw new Error('Missing API key for bundle list')
  }

  try {
    return await fetchBundlePages(appid, {
      apikey,
      silent,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
  }
  catch (vError) {
    const message = `App ${appid} not found in database`
    if (!silent)
      log.error(message)
    throw new Error(`${message}: ${formatError(vError)}`)
  }
}

export async function getChannelsVersion(
  options: CapgoHttpOptions,
  appid: string,
) {
  const versions: Array<number | null> = []
  let page = 0
  while (true) {
    const params = new URLSearchParams({ app_id: appid, page: String(page) })
    const { data: channels, error: channelsError } = await invokeCapgoCliApi<Array<{ version?: { id?: number } | null }>>(
      `channel?${params.toString()}`,
      {
        apikey: options.apikey,
        method: 'GET',
        body: undefined,
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      },
    )
    if (channelsError) {
      const message = `App ${appid} not found in database`
      if (!options.silent)
        log.error(message)
      throw new Error(`${message}: ${formatError(channelsError)}`)
    }
    const batch = Array.isArray(channels) ? channels : []
    if (!batch.length)
      break
    versions.push(...batch.map(c => c.version?.id ?? null))
    if (batch.length < 50)
      break
    page += 1
  }
  return versions
}

export async function getVersionData(
  apikeyOrClient: string | SupabaseClient<Database>,
  appid: string,
  bundle: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options
  const apikey = typeof apikeyOrClient === 'string' ? apikeyOrClient : options.apikey
  if (!apikey)
    throw new Error('Missing API key for bundle lookup')

  const all = await getActiveAppVersions(apikey, appid, options)
  const versionData = all.find(row => row.name === bundle)
  if (!versionData) {
    // A named bundle that is not in the active list is a user typo or a version
    // that was never uploaded, not a CLI crash. Throw a CliUserError so error
    // tracking skips it, and keep the app id and version in `context` (not the
    // message) so one problem stays one issue instead of one per version string.
    if (!silent)
      log.error(`App version ${appid}@${bundle} doesn't exist`)
    throw new CliUserError('App version doesn\'t exist', { appId: appid, version: bundle })
  }
  return versionData
}
