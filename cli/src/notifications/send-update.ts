import { log, spinner } from '@clack/prompts'
import { findSavedKey, formatError, getLocalConfig } from '../utils'

interface SendUpdateNotificationsOptions {
  appId: string
  apikey?: string
  channels?: string[]
  silent?: boolean
  verbose?: boolean
}

interface UpdateCheckResponse {
  queued?: boolean
  campaignId?: string
  queuedBuckets?: number
}

function normalizeChannels(channels: string[] | undefined) {
  return Array.from(new Set((channels ?? []).map(channel => channel.trim()).filter(Boolean)))
}

export async function sendUpdateNotificationsForChannels(options: SendUpdateNotificationsOptions) {
  const channels = normalizeChannels(options.channels)
  if (channels.length === 0) {
    if (!options.silent)
      log.warn('No channel bundle changed, skipping update notification')
    return []
  }

  const apikey = options.apikey || findSavedKey()
  if (!apikey)
    throw new Error('Missing API key')

  const progress = spinner()
  const results: UpdateCheckResponse[] = []

  try {
    const localConfig = await getLocalConfig(true)
    if (!options.silent)
      progress.start(channels.length === 1 ? 'Queueing update notification' : `Queueing update notifications for ${channels.length} channels`)

    for (const channel of channels) {
      if (options.verbose)
        log.info(`[Verbose] Queueing update notification for ${channel} channel...`)

      const response = await fetch(`${localConfig.hostApi}/notifications/update-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          capgkey: apikey,
        },
        body: JSON.stringify({
          appId: options.appId,
          target: { broadcast: true },
          channel,
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Cannot queue update notification for ${channel}: HTTP ${response.status}${body ? ` ${body}` : ''}`)
      }

      const result = await response.json() as UpdateCheckResponse
      if (!result.queued)
        throw new Error(`Cannot queue update notification for ${channel}: notifications are not enabled`)

      results.push(result)
    }

    if (!options.silent)
      progress.stop(channels.length === 1 ? 'Update notification queued' : 'Update notifications queued')
    return results
  }
  catch (error) {
    if (!options.silent) {
      progress.stop('Update notification failed')
      log.error(formatError(error))
    }
    throw error
  }
}
