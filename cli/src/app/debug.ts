import type { AppDebugOptions } from '../schemas/app'
import type { Database } from '../types/supabase.types'
import process from 'node:process'
import { confirm as confirmC, intro, isCancel, log, outro, spinner } from '@clack/prompts'
import { Table } from '@sauber/table'
// Native fetch is available in Node.js >= 18
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { checkAlerts } from '../api/update'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, formatError, getAppId, getConfig, getLocalConfig, getOrganizationId, sendEvent } from '../utils'
import { buildWaitLogQuery, isWaitLogContinueKey, WAIT_LOG_CONTINUE_HINT, WAIT_LOG_POLL_MS } from './wait-log-query'

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function formatTimeOnly(createdAt: string) {
  const d = new Date(createdAt || '')
  // Show only local time; include seconds for clarity
  return d.toLocaleTimeString()
}

function describeFetchFailure(error: unknown, endpoint: string) {
  const details = error as {
    message?: string
    name?: string
    cause?: {
      message?: string
      name?: string
      code?: string
    }
    code?: string
  }

  const causeName = details?.cause?.name
  const causeCode = details?.cause?.code || details?.code
  const message = (details?.message || '').toLowerCase()

  if (causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    || causeName === 'UND_ERR_CONNECT_TIMEOUT'
    || /connect timeout/.test(message)
    || /timed out/.test(message)) {
    return `Cannot reach ${endpoint} (connection timeout after 10s). Check VPN/firewall/network rules or update API host settings in capacitor.config.json.`
  }

  if (causeCode === 'ENOTFOUND' || causeCode === 'ECONNREFUSED' || message.includes('fetch failed')) {
    return `Cannot reach ${endpoint} (network error). Verify internet connectivity and that ${endpoint} is reachable from this machine.`
  }

  if (message.startsWith('http error! status: ')) {
    return details?.message || 'Capgo API returned an HTTP error.'
  }

  return formatError(error)
}


export async function markSnag(channel: string, orgId: string, apikey: string, event: string, appId?: string, icon = '✅', tags?: Record<string, string | number | boolean>) {
  await sendEvent(apikey, {
    channel,
    event,
    icon,
    org_id: orgId,
    tracking_version: 2,
    ...((appId || tags) ? { tags: { ...(appId ? { 'app-id': appId } : {}), ...tags } } : {}),
    notify: false,
  })
}

export async function cancelCommand(channel: string, command: boolean | symbol, orgId: string, apikey: string) {
  if (!isCancel(command))
    return

  await markSnag(channel, orgId, apikey, 'canceled', undefined, '🤷')
  log.warn('Command cancelled')
  throw new CliUserError('Command cancelled')
}

interface Order {
  key: string
  sortable?: 'asc' | 'desc'
}

interface QueryStats {
  appId: string
  devicesId?: string[]
  search?: string
  order?: Order[]
  rangeStart?: string
  rangeEnd?: string
  limit?: number
}
interface LogData {
  app_id: string
  device_id: string
  action: Database['public']['Enums']['stats_action']
  version_id: number
  version?: number
  created_at: string
}
export async function getStats(apikey: string, query: QueryStats, after: string | null, signal?: AbortSignal): Promise<LogData[]> {
  const localConfig = await getLocalConfig()
  const statsEndpoint = `${localConfig.hostApi}/private/stats`

  try {
    // If we already have a latest timestamp, query only after that point
    const effectiveQuery: QueryStats = after ? { ...query, rangeStart: after } : { ...query }

    const response = await fetch(statsEndpoint, {
      method: 'POST',
      headers: buildCliRequestHeaders({ 'Content-Type': 'application/json', capgkey: apikey }),
      body: JSON.stringify(effectiveQuery),
      signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const dataD = await response.json() as LogData[]
    // Always return data; deduping and ordering handled upstream
    if (dataD?.length > 0)
      return dataD
  }
  catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
      return []
    log.error(`Cannot get stats: ${describeFetchFailure(error, statsEndpoint)}`)
  }
  return []
}

type Level = 'info' | 'warn' | 'error'
interface LogSpec { summary: (ctx: { data: LogData, baseAppUrl: string, baseUrl: string }) => string, level: Level, snag?: string, stop?: boolean }

function summarizeAction(data: LogData): LogSpec | null {
  const map: Record<string, LogSpec> = {
    get: { summary: () => 'Update request by device. Waiting for download…', level: 'info', snag: 'done' },
    delete: { summary: () => 'Bundle deleted on device', level: 'info' },
    set: { summary: () => 'Bundle set on device ❤️', level: 'info', snag: 'set', stop: true },
    NoChannelOrOverride: { summary: () => 'No default channel/override; create it in channel settings', level: 'error' },
    needPlanUpgrade: { summary: ({ baseUrl }) => `Out of quota. Upgrade plan: ${baseUrl}/settings/organization/plans`, level: 'error' },
    missingBundle: { summary: () => 'Requested bundle not found on server', level: 'error' },
    noNew: { summary: () => 'Device already has latest available version', level: 'info' },
    disablePlatformIos: { summary: () => 'iOS platform disabled in channel', level: 'error' },
    disablePlatformAndroid: { summary: () => 'Android platform disabled in channel', level: 'error' },
    disableAutoUpdate: { summary: () => 'Automatic updates disabled in channel', level: 'error' },
    disableAutoUpdateToMajor: { summary: () => 'Auto-update to major versions disabled', level: 'error' },
    disableAutoUpdateToMinor: { summary: () => 'Auto-update to minor versions disabled', level: 'error' },
    disableAutoUpdateToPatch: { summary: () => 'Auto-update to patch versions disabled', level: 'error' },
    disableAutoUpdateUnderNative: { summary: () => 'Channel update version is lower than device native', level: 'error' },
    disableDevBuild: { summary: () => 'Dev build updates disabled in channel', level: 'error' },
    disableProdBuild: { summary: () => 'Prod build updates disabled in channel', level: 'error' },
    disableEmulator: { summary: () => 'Emulator updates disabled in channel', level: 'error' },
    disableDevice: { summary: () => 'Physical device updates disabled in channel', level: 'error' },
    cannotGetBundle: { summary: () => 'Cannot retrieve bundle from channel', level: 'error' },
    cannotUpdateViaPrivateChannel: { summary: () => 'No access to private channel', level: 'error' },
    channelMisconfigured: { summary: () => 'Channel configuration invalid or incomplete', level: 'error' },
    disableAutoUpdateMetadata: { summary: () => 'Auto-update on metadata disabled', level: 'error' },
    set_fail: { summary: () => 'Bundle set failed. Possibly corrupted', level: 'error' },
    reset: { summary: () => 'Device reset to builtin bundle', level: 'warn' },
    update_fail: { summary: () => 'Installed bundle failed to call notifyAppReady', level: 'error' },
    checksum_fail: { summary: () => 'Downloaded bundle checksum validation failed', level: 'error' },
    windows_path_fail: { summary: () => 'Bundle contains illegal Windows-style paths', level: 'error' },
    canonical_path_fail: { summary: () => 'Bundle contains non-canonical paths', level: 'error' },
    directory_path_fail: { summary: () => 'Bundle ZIP contains invalid directory paths', level: 'error' },
    unzip_fail: { summary: () => 'Failed to unzip bundle on device', level: 'error' },
    low_mem_fail: { summary: () => 'Download failed due to low device memory', level: 'error' },
    app_moved_to_background: { summary: () => 'App moved to background', level: 'info' },
    app_moved_to_foreground: { summary: () => 'App moved to foreground', level: 'info' },
    decrypt_fail: { summary: () => 'Failed to decrypt downloaded bundle', level: 'error' },
    getChannel: { summary: () => 'Queried current channel on device', level: 'info' },
    setChannel: { summary: () => 'Channel set on device', level: 'info' },
    InvalidIp: { summary: () => 'Device appears in Google datacenter; blocking recent updates (<4h)', level: 'warn' },
    uninstall: { summary: () => 'App uninstalled or Capgo data cleared on device', level: 'warn' },
  }
  if (data.action.startsWith('download_')) {
    const part = data.action.split('_')[1]
    if (part === 'complete')
      return { summary: () => 'Download complete; relaunch app to apply', level: 'info', snag: 'downloaded' }
    if (part === 'fail')
      return { summary: () => 'Download failed on device', level: 'error' }
    return { summary: () => `Downloading ${part}%`, level: 'info' }
  }
  return map[data.action] || null
}

async function toTableRow(data: LogData, channel: string, orgId: string, apikey: string, baseAppUrl: string, baseUrl: string): Promise<{ row?: string[], stop?: boolean }> {
  const spec = summarizeAction(data)
  if (!spec)
    return {}
  if (spec.snag)
    await markSnag(channel, orgId, apikey, spec.snag)
  const time = formatTimeOnly(data.created_at)
  const key = data.action
  const versionId = data.version_id ? `(version #${data.version_id})` : ''
  const versionInfo = data.version ? ` (version ${data.version})` : versionId
  const msg = `${spec.summary({ data, baseAppUrl, baseUrl })}${versionInfo}`
  return { row: [time, data.device_id, key, msg], stop: spec.stop }
}

export interface WaitLogOptions {
  deviceId?: string
  lookbackMs?: number
  pollMs?: number
  now?: Date
  waitForSkip?: (signal: AbortSignal) => Promise<void>
  spinner?: {
    start: (message: string) => void
    stop: (message?: string) => void
  }
  logInfo?: (message: string) => void
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function listenForWaitLogContinue(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    const canUseRawMode = Boolean(stdin.isTTY && typeof stdin.setRawMode === 'function')
    const previousRawMode = canUseRawMode ? stdin.isRaw : undefined
    const finish = () => {
      cleanup()
      resolve()
    }
    const onData = (chunk: string | Uint8Array) => {
      const input = String(chunk)
      if (input === '\u0003' || isWaitLogContinueKey(input))
        finish()
    }
    const cleanup = () => {
      stdin.off('data', onData)
      signal.removeEventListener('abort', finish)
      if (canUseRawMode && previousRawMode !== undefined)
        stdin.setRawMode(previousRawMode)
    }
    signal.addEventListener('abort', finish, { once: true })
    if (canUseRawMode) {
      stdin.setRawMode(true)
      stdin.resume()
    }
    if (stdin.isTTY)
      stdin.on('data', onData)
  })
}

export async function waitLog(channel: string, apikey: string, appId: string, orgId: string, options: WaitLogOptions = {}): Promise<{ skipped: boolean }> {
  const config = await getLocalConfig()
  const baseAppUrl = `${config.hostWeb}/app/${appId}`
  await markSnag(channel, orgId, apikey, 'Use waitlog', appId)
  const query = buildWaitLogQuery(appId, options.deviceId, options.now, options.lookbackMs)
  let after: string | null = null
  // Track displayed log items to avoid duplicates across rounds
  const seen = new Set<string>()
  const s = options.spinner ?? spinner()
  const logInfo = options.logInfo ?? ((message: string) => { log.info(message) })
  const sleep = options.sleep ?? wait
  const pollMs = options.pollMs ?? WAIT_LOG_POLL_MS
  const docsUrl = `${config.host}/docs/plugins/updater/debugging/#sent-from-the-backend`
  const waitingMessage = `Waiting for logs (expect ~30s delay). ${WAIT_LOG_CONTINUE_HINT}. More info: ${docsUrl}`
  s.start(waitingMessage)

  const abort = new AbortController()
  const skipPromise = options.waitForSkip
    ? options.waitForSkip(abort.signal)
    : listenForWaitLogContinue(abort.signal)

  const poll = async (): Promise<'set' | 'aborted'> => {
    let first = true
    while (!abort.signal.aborted) {
      if (!first)
        await sleep(pollMs, abort.signal)
      first = false
      if (abort.signal.aborted)
        return 'aborted'

      const data = await getStats(apikey, query, after, abort.signal)
      if (abort.signal.aborted)
        return 'aborted'
      if (data.length === 0)
        continue

      const newest: number = data.reduce<number>((acc, d) => {
        const t = new Date(d.created_at).getTime()
        return Math.max(acc, t)
      }, after ? new Date(after).getTime() : 0)
      if (newest > 0)
        after = new Date(newest).toISOString()

      const fresh = data.filter((d) => {
        const key = `${d.app_id}|${d.device_id}|${d.action}|${d.version_id}|${d.created_at}`
        if (seen.has(key))
          return false
        seen.add(key)
        return true
      }).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      const t = new Table()
      t.headers = ['Time', 'Device', 'Key', 'Message']
      t.theme = Table.roundTheme
      t.rows = []
      let shouldStop = false
      for (const d of fresh) {
        const { row, stop } = await toTableRow(d, channel, orgId, apikey, baseAppUrl, config.hostWeb)
        if (row)
          t.rows.push(row)
        if (stop)
          shouldStop = true
      }
      if (abort.signal.aborted)
        return 'aborted'
      if (t.rows.length) {
        s.stop('')
        logInfo(t.toString())
        if (!shouldStop)
          s.start(waitingMessage)
      }
      if (shouldStop)
        return 'set'
    }
    return 'aborted'
  }

  const pollTask = poll()
  try {
    const result = await Promise.race([
      pollTask,
      skipPromise.then(() => 'skip' as const),
    ])
    abort.abort()
    await pollTask
    if (result === 'skip') {
      s.stop('Skipped waiting for logs')
      logInfo('You can confirm the update in the Capgo dashboard anytime.')
      return { skipped: true }
    }
    s.stop('Stop watching logs')
    return { skipped: false }
  }
  catch (error) {
    abort.abort()
    await pollTask.catch(() => undefined)
    s.stop('Stop watching logs')
    throw error
  }
}

export async function debugApp(appId: string, options: AppDebugOptions) {
  intro('Debug Live update in Capgo')

  await checkAlerts()
  options.apikey = options.apikey || findSavedKey()
  const extConfig = await getConfig()
  appId = getAppId(appId, extConfig?.config)
  const deviceId = options.device
  if (!options.apikey) {
    log.error('Missing API key, you need to provide an API key to delete your app')
    throw new Error('Missing API key')
  }
  if (!appId) {
    log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  const orgId = await getOrganizationId(options.apikey!, appId, { supaHost: options.supaHost, supaAnon: options.supaAnon })

  const doRun = await confirmC({ message: `Automatic check if update working in device ?` })
  await cancelCommand('debug', doRun, orgId, options.apikey)
  if (doRun) {
    log.info(`Wait logs sent to Capgo from ${appId} device, Please background your app and open it again 💪`)
    log.info(WAIT_LOG_CONTINUE_HINT)
    await waitLog('debug', options.apikey, appId, orgId, { deviceId })
    outro('Done ✅')
  }
  else {
    outro('Canceled ❌')
  }
}
