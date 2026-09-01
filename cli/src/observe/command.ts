import type { ObserveOptions, ObserveView } from '../schemas/sdk'
import { stderr, stdout } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { checkAlerts } from '../api/update'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, formatCapgoCliInvokeError, formatError, getAppId, getConfig, invokeCapgoCliApi } from '../utils'

export interface ObserveCliOptions {
  apikey?: string
  days?: string
  action?: string
  device?: string
  versionName?: string
  sort?: string
  limit?: string
  json?: boolean
  supaHost?: string
  supaAnon?: string
}

interface ObserveFinding {
  severity?: string
  title?: string
  detail?: string
  next?: { view?: string, action?: string, sort?: string, deviceId?: string }
}

function parsePositiveInt(value: string | undefined, label: string) {
  if (value == null || value === '')
    return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new CliUserError(`${label} must be a positive integer`)
  return parsed
}

function parseObserveDays(value: string | undefined) {
  const parsed = parsePositiveInt(value, '--days')
  if (parsed == null)
    return undefined
  if (![1, 3, 7, 30].includes(parsed))
    throw new CliUserError('--days must be 1, 3, 7, or 30')
  return parsed
}

function parseObserveSort(value: string | undefined): ObserveOptions['sort'] | undefined {
  if (!value)
    return undefined
  if (!['slowest', 'fastest', 'newest', 'oldest'].includes(value))
    throw new CliUserError('--sort must be slowest, fastest, newest, or oldest')
  return value as ObserveOptions['sort']
}

function writeJson(payload: unknown) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
}

function printFindings(findings: ObserveFinding[] | undefined) {
  if (!findings?.length)
    return
  const table = new Table()
  table.headers = ['Severity', 'Finding', 'Next']
  table.rows = findings.map((finding) => {
    const next = finding.next
      ? `${finding.next.view ?? ''}${finding.next.action ? ` ${finding.next.action}` : ''}${finding.next.sort ? ` ${finding.next.sort}` : ''}`
      : ''
    return [finding.severity ?? '', finding.title ?? '', next.trim()]
  })
  log.info('Findings')
  log.info(table.toString())
  for (const finding of findings) {
    if (finding.detail)
      log.message(`${finding.title}: ${finding.detail}`)
  }
}

export async function fetchObserve(options: ObserveOptions): Promise<Record<string, unknown>> {
  const apikey = options.apikey || findSavedKey(true)
  const { data, error } = await invokeCapgoCliApi<Record<string, unknown>>('private/observe', {
    apikey,
    method: 'POST',
    body: {
      appId: options.appId,
      view: options.view ?? 'summary',
      days: options.days,
      action: options.action,
      deviceId: options.deviceId,
      versionName: options.versionName,
      sort: options.sort,
      limit: options.limit,
    },
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  if (error)
    throw new CliUserError(await formatCapgoCliInvokeError(error))
  return data ?? {}
}

export async function observeCommand(
  view: ObserveView,
  appIdArg: string | undefined,
  options: ObserveCliOptions,
  deviceIdArg?: string,
) {
  if (!options.json)
    intro('Capgo Observe')
  try {
    await checkAlerts(options.json ? { warn: message => stderr.write(`${message}\n`) } : undefined)
    const extConfig = await getConfig()
    const appId = getAppId(appIdArg, extConfig?.config)
    if (!appId)
      throw new CliUserError('Missing app ID. Pass it as an argument or set it in capacitor.config.')

    const deviceId = deviceIdArg || options.device
    if (view === 'device' && !deviceId)
      throw new CliUserError('Missing device ID. Example: npx @capgo/cli@latest observe device DEVICE_ID')

    const payload = await fetchObserve({
      appId,
      view,
      days: parseObserveDays(options.days),
      action: options.action,
      deviceId,
      versionName: options.versionName,
      sort: parseObserveSort(options.sort),
      limit: parsePositiveInt(options.limit, '--limit'),
      apikey: options.apikey,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })

    if (options.json) {
      writeJson(payload)
      return
    }

    const findings = payload.findings as ObserveFinding[] | undefined
    printFindings(findings)

    if (typeof payload.handoff_prompt === 'string')
      log.info(payload.handoff_prompt)

    if (view === 'metrics' || view === 'device') {
      const rows = (payload.samples ?? payload.events) as Array<Record<string, unknown>> | undefined
      if (rows?.length) {
        const table = new Table()
        table.headers = ['Time', 'Action', 'Device', 'Version', 'Duration', 'Route']
        table.rows = rows.map(row => [
          String(row.created_at ?? ''),
          String(row.action ?? ''),
          String(row.device_id ?? ''),
          String(row.version_name ?? ''),
          row.duration_ms == null ? '' : String(row.duration_ms),
          String(row.route ?? ''),
        ])
        log.info(table.toString())
      }
      else {
        log.warn('No samples in this window.')
      }
    }
    else if (view === 'routes') {
      const routes = payload.routes as Array<Record<string, unknown>> | undefined
      if (routes?.length) {
        const table = new Table()
        table.headers = ['Route', 'Events', 'Devices', 'P50', 'P90']
        table.rows = routes.map(row => [
          String(row.route ?? ''),
          String(row.events ?? ''),
          String(row.devices ?? ''),
          row.p50_ms == null ? '' : String(row.p50_ms),
          row.p90_ms == null ? '' : String(row.p90_ms),
        ])
        log.info(table.toString())
      }
      else {
        log.warn('No route metadata yet. Listen to history/popstate/hashchange and send action=app_nav with metadata.route.')
      }
    }
    else if (view === 'events') {
      const actions = payload.actions as Array<Record<string, unknown>> | undefined
      if (actions?.length) {
        const table = new Table()
        table.headers = ['Action', 'Events', 'Devices', 'Last seen']
        table.rows = actions.map(row => [
          String(row.action ?? ''),
          String(row.total ?? ''),
          String(row.device_count ?? ''),
          String(row.last_seen ?? ''),
        ])
        log.info(table.toString())
      }
      else {
        log.warn('No observe events in this window.')
      }
    }
    else if (view === 'versions' || view === 'summary') {
      const versions = payload.versions as Array<Record<string, unknown>> | undefined
      if (versions?.length) {
        const table = new Table()
        table.headers = ['Version', 'Devices', 'Issue-free', 'Launch P90']
        table.rows = versions.map(row => [
          String(row.version_name ?? ''),
          String(row.devices ?? ''),
          row.issue_free_rate == null ? '' : String(row.issue_free_rate),
          row.launch_p90_ms == null ? '' : String(row.launch_p90_ms),
        ])
        log.info(table.toString())
      }
    }

    outro('Done')
  }
  catch (error) {
    const message = formatError(error)
    if (options.json)
      stderr.write(`${message}\n`)
    else
      log.error(message)
    throw error
  }
}
