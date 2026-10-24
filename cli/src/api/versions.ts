import type { AppVersionInsert, AppVersionRow } from '../types/api'
import type { CapgoClient } from '../utils'
import { log } from '@clack/prompts'
import { Table } from '@sauber/table'
import { CliUserError } from '../shared/cli-user-error'
import { invokeCapgoCliApiResultWithRetry } from '../shared/retryable-capgo-api-error'
import { formatCapgoCliInvokeError, formatError, getCapgoCliHttpStatus, getHumanDate, invokeCapgoCliApi, readCapgoCliApiErrorPayload } from '../utils'
import { checkVersionNotUsedInChannel } from './channels'
import { setBundlesDeleted } from './cli-data'

interface VersionOptions {
  silent?: boolean
  apikey?: string
  apiHost?: string
  /** Injectable for unit tests; defaults to invokeCapgoCliApi. */
  invoke?: typeof invokeCapgoCliApi
}

interface DeleteSpecificVersionOptions extends VersionOptions {
  autoUnlink?: boolean
}

interface CapgoHttpOptions {
  apikey: string
  silent?: boolean
  apiHost?: string
}

const LEGACY_BUNDLE_PAGE_SIZE = 50
// Bundle list page size (GET /bundle `limit`, capped server-side at PostgREST max_rows).
const BUNDLE_LIST_LIMIT = 1000

export type BundleVersionLookupRow = Pick<
  AppVersionRow,
  'id' | 'name' | 'checksum' | 'deleted' | 'created_at'
>

export async function fetchBundleVersionRow(
  apikey: string,
  appId: string,
  version: string,
  options: VersionOptions & { includeDeleted?: boolean } = {},
): Promise<BundleVersionLookupRow | null> {
  const params = new URLSearchParams({
    app_id: appId,
    version,
    fields: 'summary',
  })
  if (options.includeDeleted)
    params.set('include_deleted', '1')

  const { data, error } = await invokeCapgoCliApi<BundleVersionLookupRow[]>(
    `bundle?${params.toString()}`,
    {
      apikey,
      method: 'GET',
      body: undefined,
      apiHost: options.apiHost,
    },
  )

  // Any error must stop callers (upload duplicate guard / auto-bump) from reusing an existing name.
  if (error)
    throw new Error(`Cannot check bundle ${appId}@${version}: ${await formatCapgoCliInvokeError(error)}`, { cause: error })
  if (!Array.isArray(data))
    throw new Error(`Cannot check bundle ${appId}@${version}: unexpected response`)
  return data[0] ?? null
}

async function isBundleAccessDeniedError(error: unknown) {
  const status = getCapgoCliHttpStatus(error)
  const payload = await readCapgoCliApiErrorPayload(error)
  if (status === 401 || status === 403 || payload?.error === 'cannot_access_app')
    return true
  if (payload?.error === 'cannot_delete_bundle')
    return true
  return payload?.error === 'cannot_get_bundle'
    && typeof payload.message === 'string'
    && payload.message.toLowerCase().includes('access')
}

async function throwBundleHttpInvokeError(
  appid: string,
  error: unknown,
  action: 'list' | 'delete' | 'channels',
  silent: boolean,
  requiredPermissionKey: string,
): Promise<never> {
  const details = await formatCapgoCliInvokeError(error)

  if (await isBundleAccessDeniedError(error)) {
    const status = getCapgoCliHttpStatus(error)
    const authHint = status === 401
      ? 'Provide a valid API key (capgo login or CAPGO_API_KEY).'
      : 'Your API key is valid but lacks the required permission for this app.'
    const baseMessage = action === 'channels'
      ? `Cannot list channels. ${authHint} Required permission: app.read_channels.`
      : action === 'delete'
        ? `Cannot delete bundles for app ${appid}. ${authHint} Required permission: app bundle delete permissions.`
        : `Cannot list bundles for app ${appid}. ${authHint} Required permission: app.read_bundles.`
    const message = `${baseMessage} (${details})`
    if (!silent)
      log.error(message)
    throw new CliUserError(
      message,
      { appId: appid, requiredPermissionKey, httpStatus: status },
      error,
    )
  }
  const payload = await readCapgoCliApiErrorPayload(error)
  const status = getCapgoCliHttpStatus(error)
  if (status === 404 || payload?.error === 'app_not_found') {
    const message = `App ${appid} not found in database`
    if (!silent)
      log.error(message)
    throw new Error(`${message}: ${details}`, { cause: error })
  }

  const actionLabel = action === 'list'
    ? 'list bundles'
    : action === 'channels'
      ? 'list channel bundle versions'
      : 'delete bundle'
  const message = `Could not ${actionLabel} for app ${appid}: ${details}`
  if (!silent)
    log.error(message)
  throw new Error(message, { cause: error })
}

/** A bundle row without the heavy per-file `manifest` and `native_packages` arrays. */
export type BundleSummaryRow = Omit<AppVersionRow, 'manifest' | 'native_packages'>

async function fetchBundlePages(appid: string, options: CapgoHttpOptions & Pick<VersionOptions, 'invoke'>) {
  const invoke = options.invoke ?? invokeCapgoCliApi
  const all: BundleSummaryRow[] = []
  let page = 0
  while (true) {
    const params = new URLSearchParams({ app_id: appid, page: String(page), limit: String(BUNDLE_LIST_LIMIT), fields: 'summary' })
    const { data, error } = await invoke<BundleSummaryRow[]>(
      `bundle?${params.toString()}`,
      {
        apikey: options.apikey,
        method: 'GET',
        body: undefined,
        apiHost: options.apiHost,
      },
    )
    if (error)
      await throwBundleHttpInvokeError(appid, error, 'list', !!options.silent, 'app.read_bundles')
    const batch = Array.isArray(data) ? data : []
    all.push(...batch)
    // A backend without `limit`/`fields` support answers fixed 50-row pages of full rows (they
    // carry `native_packages`): only then can a 50-row page be followed by more.
    const legacyFullPage = batch.length === LEGACY_BUNDLE_PAGE_SIZE && 'native_packages' in batch[0]
    if (batch.length < BUNDLE_LIST_LIMIT && !legacyFullPage)
      break
    page += 1
  }
  return all
}

export type UpsertAppVersionInput = Pick<AppVersionInsert, 'app_id' | 'name'>
  & Partial<Omit<AppVersionInsert, 'app_id' | 'name'>>

export async function upsertAppVersion(
  apikey: string,
  versionData: UpsertAppVersionInput,
  options: VersionOptions = {},
) {
  const { data, error } = await invokeCapgoCliApiResultWithRetry(() => invokeCapgoCliApi<AppVersionRow>('bundle/upsert', {
    apikey,
    method: 'POST',
    body: {
      app_id: versionData.app_id,
      name: versionData.name,
      ...(versionData.session_key !== undefined ? { session_key: versionData.session_key } : {}),
      ...(versionData.external_url !== undefined ? { external_url: versionData.external_url } : {}),
      ...(versionData.storage_provider !== undefined ? { storage_provider: versionData.storage_provider } : {}),
      ...(versionData.min_update_version !== undefined ? { min_update_version: versionData.min_update_version } : {}),
      ...(versionData.native_packages !== undefined ? { native_packages: versionData.native_packages } : {}),
      ...(versionData.checksum !== undefined ? { checksum: versionData.checksum } : {}),
      ...(versionData.link !== undefined ? { link: versionData.link } : {}),
      ...(versionData.comment !== undefined ? { comment: versionData.comment } : {}),
      ...(versionData.key_id !== undefined ? { key_id: versionData.key_id } : {}),
      ...(versionData.cli_version !== undefined ? { cli_version: versionData.cli_version } : {}),
      ...(versionData.manifest !== undefined ? { manifest: versionData.manifest } : {}),
      ...(versionData.r2_path !== undefined ? { r2_path: versionData.r2_path } : {}),
    },
    apiHost: options.apiHost,
  }), undefined, { retryTransientNetwork: false })

  if (error)
    throw error
  if (typeof data?.id !== 'number')
    throw new Error('bundle/upsert did not return a version id')
  return data.id
}

export async function deleteAppVersion(
  client: CapgoClient | null,
  appid: string,
  bundle: string,
  options: VersionOptions = {},
) {
  const { silent = false, apikey, apiHost } = options

  // Soft-delete through the CLI data endpoint when a client is provided. HTTP DELETE /bundle
  // rejects bundles still linked to a channel; admin channel cleanup needs this path.
  if (client) {
    let updated: string[]
    try {
      updated = await setBundlesDeleted(client, appid, [bundle], true)
    }
    catch (error) {
      const message = `App version ${appid}@${bundle} not found in database`
      if (!silent)
        log.error(message)
      throw new Error(`${message}: ${formatError(error)}`)
    }
    // Zero rows updated: already deleted, renamed or not visible to this key.
    if (!updated.includes(bundle)) {
      const message = `App version ${appid}@${bundle} not found in database`
      if (!silent)
        log.error(message)
      throw new Error(message)
    }
    return
  }

  if (!apikey)
    throw new Error('Missing API key for bundle delete')

  const { error } = await invokeCapgoCliApi('bundle', {
    apikey,
    method: 'DELETE',
    body: { app_id: appid, version: bundle },
    apiHost,
  })
  if (error) {
    await throwBundleHttpInvokeError(appid, error, 'delete', silent, 'bundle.delete')
  }
}

/** A 404 whose code is not a known one means the Capgo API predates this route. */
async function throwIfRouteMissing(appid: string, error: unknown, feature: string, silent: boolean) {
  const payload = await readCapgoCliApiErrorPayload(error)
  if (getCapgoCliHttpStatus(error) !== 404 || payload?.error === 'app_not_found')
    return
  const message = `This Capgo API does not support ${feature}. Update your Capgo backend or use an older CLI.`
  if (!silent)
    log.error(message)
  throw new CliUserError(message, { appId: appid }, error)
}

// capgo_api version where DELETE /bundle answers 404 bundle_not_found / 409 bundle_linked.
const BUNDLE_DELETE_API_VERSION = '2026-10-22'

async function deleteBundleByName(appid: string, bundle: string, options: CapgoHttpOptions & Pick<VersionOptions, 'invoke'>) {
  const invoke = options.invoke ?? invokeCapgoCliApi
  const { error } = await invoke('bundle', {
    apikey: options.apikey,
    method: 'DELETE',
    body: { app_id: appid, version: bundle },
    apiHost: options.apiHost,
    apiVersion: BUNDLE_DELETE_API_VERSION,
  })
  return error
}

/**
 * Deletes one bundle with a single DELETE /bundle on the 2026-10-22 contract: the API resolves
 * the name, reports a missing bundle (`bundle_not_found`) and refuses a linked one
 * (`bundle_linked`, with the bundle id). Only that linked case does extra work: offer to unlink,
 * then retry.
 */
export async function deleteSpecificVersion(
  client: CapgoClient,
  appid: string,
  bundle: string,
  options: DeleteSpecificVersionOptions = {},
) {
  const { silent = false, autoUnlink = false, apikey, apiHost, invoke } = options
  if (!apikey)
    throw new Error('Missing API key for bundle delete')
  const http = { apikey, apiHost, silent, invoke }

  let error = await deleteBundleByName(appid, bundle, http)
  if (!error)
    return

  const payload = await readCapgoCliApiErrorPayload(error)
  if (payload?.error === 'bundle_not_found')
    throwMissingVersion(appid, bundle, silent)
  let bundleId = payload?.error === 'bundle_linked' ? payload.moreInfo?.bundle_id : undefined
  // Backends before the 2026-10-22 contract refuse a linked bundle without its id.
  if (payload?.error === 'cannot_delete_linked_version') {
    const row = await fetchSingleBundle(appid, { version: bundle }, http)
    if (!row)
      throwMissingVersion(appid, bundle, silent)
    bundleId = row.id
  }
  if (typeof bundleId !== 'number')
    await throwBundleHttpInvokeError(appid, error, 'delete', silent, 'bundle.delete')

  await checkVersionNotUsedInChannel(client, appid, { id: bundleId as number, name: bundle }, { silent, autoUnlink, apikey, apiHost })
  error = await deleteBundleByName(appid, bundle, http)
  if (!error)
    return
  if ((await readCapgoCliApiErrorPayload(error))?.error === 'bundle_not_found')
    throwMissingVersion(appid, bundle, silent)
  await throwBundleHttpInvokeError(appid, error, 'delete', silent, 'bundle.delete')
}

export interface CleanupBundleRow {
  id: number
  name: string
  created_at: string | null
  linked: boolean
}

export interface CleanupBundlesResult {
  /** Active bundles of the app (placeholders excluded), before the `bundle` range filter. */
  active: number
  /** Bundles inside the cleanup scope. */
  total: number
  kept: CleanupBundleRow[]
  removed: CleanupBundleRow[]
  dry_run: boolean
}

/** Server-side cleanup: the API selects and soft-deletes old bundles in one request. */
export async function cleanupAppVersions(
  appid: string,
  body: { keep: number, bundle?: string, ignoreChannel?: boolean, dryRun: boolean, ids?: number[] },
  options: CapgoHttpOptions & Pick<VersionOptions, 'invoke'>,
) {
  const invoke = options.invoke ?? invokeCapgoCliApi
  const { data, error } = await invoke<CleanupBundlesResult>('bundle/cleanup', {
    apikey: options.apikey,
    method: 'POST',
    body: {
      app_id: appid,
      keep: body.keep,
      ...(body.bundle ? { bundle: body.bundle } : {}),
      ignore_channel: !!body.ignoreChannel,
      dry_run: body.dryRun,
      ...(body.ids ? { ids: body.ids } : {}),
    },
    apiHost: options.apiHost,
  })
  if (error) {
    await throwIfRouteMissing(appid, error, 'server-side bundle cleanup (POST /bundle/cleanup)', !!options.silent)
    await throwBundleHttpInvokeError(appid, error, 'delete', !!options.silent, 'bundle.delete')
  }
  if (!data || !Array.isArray(data.kept) || !Array.isArray(data.removed))
    throw new Error(`Cannot clean up bundles for app ${appid}: unexpected response`)
  return data
}

export function displayBundles(
  data: (Pick<AppVersionRow, 'name' | 'created_at'> & { keep?: string })[],
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
  apikeyOrClient: string | CapgoClient,
  appid: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options
  const apikey = typeof apikeyOrClient === 'string' ? apikeyOrClient : options.apikey
  if (!apikey) {
    throw new Error('Missing API key for bundle list')
  }

  return await fetchBundlePages(appid, {
    apikey,
    silent,
    apiHost: options.apiHost,
    invoke: options.invoke,
  })
}

async function fetchSingleBundle(
  appid: string,
  filter: { version: string } | { id: number },
  options: CapgoHttpOptions & Pick<VersionOptions, 'invoke'>,
) {
  const invoke = options.invoke ?? invokeCapgoCliApi
  const params = new URLSearchParams({ app_id: appid })
  if ('version' in filter)
    params.set('version', filter.version)
  else
    params.set('id', String(filter.id))
  const { data, error } = await invoke<AppVersionRow[]>(`bundle?${params.toString()}`, {
    apikey: options.apikey,
    method: 'GET',
    body: undefined,
    apiHost: options.apiHost,
  })
  if (error)
    await throwBundleHttpInvokeError(appid, error, 'list', !!options.silent, 'app.read_bundles')
  return (Array.isArray(data) ? data[0] : undefined) ?? null
}

function throwMissingVersion(appid: string, bundle: string | number, silent: boolean): never {
  const message = `App version ${appid}@${bundle} doesn't exist`
  if (!silent)
    log.error(message)
  throw new CliUserError(message, { appId: appid, bundle: String(bundle) })
}

/** Looks up one active bundle by name with a single filtered request. */
export async function getVersionData(
  apikeyOrClient: string | CapgoClient,
  appid: string,
  bundle: string,
  options: VersionOptions = {},
) {
  const { silent = false } = options
  const apikey = typeof apikeyOrClient === 'string' ? apikeyOrClient : options.apikey
  if (!apikey)
    throw new Error('Missing API key for bundle lookup')

  const versionData = await fetchSingleBundle(appid, { version: bundle }, { apikey, silent, apiHost: options.apiHost, invoke: options.invoke })
  if (!versionData)
    throwMissingVersion(appid, bundle, silent)
  return versionData
}

/** Looks up one active bundle by id with a single filtered request. */
export async function getVersionDataById(
  apikey: string,
  appid: string,
  id: number,
  options: VersionOptions = {},
) {
  return fetchSingleBundle(appid, { id }, { apikey, silent: options.silent, apiHost: options.apiHost, invoke: options.invoke })
}

/** Newest active bundle: a one-row list page. */
export async function getLatestAppVersion(
  apikey: string,
  appid: string,
  options: VersionOptions = {},
) {
  const invoke = options.invoke ?? invokeCapgoCliApi
  const params = new URLSearchParams({ app_id: appid, page: '0', limit: '1' })
  const { data, error } = await invoke<AppVersionRow[]>(`bundle?${params.toString()}`, {
    apikey,
    method: 'GET',
    body: undefined,
    apiHost: options.apiHost,
  })
  if (error)
    await throwBundleHttpInvokeError(appid, error, 'list', !!options.silent, 'app.read_bundles')
  return (Array.isArray(data) ? data[0] : undefined) ?? null
}
