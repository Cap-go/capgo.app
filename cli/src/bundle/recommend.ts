import type { OptionsBase } from '../schemas/base'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { log } from '@clack/prompts'
import { checkAlerts } from '../api/update'
import { createCapgoClient, findSavedKey, formatCapgoCliInvokeError, formatError, getAppId, getConfig, invokeCapgoCliApi } from '../utils'
import { collectReleaseContext } from './recommend-context'

interface RecommendOptions extends Partial<OptionsBase> {
  baseVersion?: string
  since?: string
  ref?: string
  repo?: string
  changelog?: boolean
  json?: boolean
  dryRun?: boolean
}
interface Recommendation {
  nextVersion: string
  baseVersion: string
  level: string
  reason: string
  changelog?: string
  contextTruncated: boolean
}

export async function recommendBundle(appId: string | undefined, options: RecommendOptions) {
  await checkAlerts({ warn: message => process.stderr.write(`${message}\n`) })
  if (!appId) {
    const config = await getConfig(true)
    appId = getAppId(appId, config?.config)
  }
  if (!appId)
    throw new Error('Provide an app ID or run inside a Capacitor project')
  const context = await collectReleaseContext(options).catch((error) => {
    throw new Error(`Cannot read release context: ${formatError(error)}`)
  })
  const body = { appId, baseVersion: options.baseVersion, changelog: !!options.changelog, context }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
    return
  }
  const apikey = options.apikey || findSavedKey()
  if (!apikey)
    throw new Error('Missing API key. Log in or provide --apikey.')
  const client = await createCapgoClient(apikey, options.apiHost, true)
  if (!options.json)
    log.info('Sending commit summaries, file statistics, tags, and Capgo release metadata to Cloudflare AI. Use --dry-run to inspect local context first.')
  const { data, error } = await invokeCapgoCliApi<Recommendation>('bundle/recommend', { apikey, body, apiHost: client.apiHost, signal: AbortSignal.timeout(120000) })
  if (error)
    throw new Error(`Release recommendation failed: ${await formatCapgoCliInvokeError(error)}`)
  if (!data?.nextVersion || !data.reason)
    throw new Error('Invalid release recommendation response')
  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  }
  else {
    log.success(`Suggested version: ${data.nextVersion} (${data.baseVersion} → ${data.level})`)
    log.info(stripVTControlCharacters(data.reason))
    if (data.contextTruncated)
      log.warn('History was limited. Review the suggestion or narrow the range with --since.')
    if (data.changelog)
      log.message(stripVTControlCharacters(data.changelog))
  }
}
