import type { Options } from '../api/app'
import { intro, log, outro } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { findSavedKey, formatError, resolveUserIdFromApiKey } from '../utils'

export async function getUserIdInternal(options: Options, silent = false) {
  if (!silent)
    intro('Getting user id')

  const enrichedOptions: Options = {
    ...options,
    apikey: options.apikey || findSavedKey(),
  }

  if (!enrichedOptions.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to fetch the user id')
    throw new Error('Missing API key')
  }

  try {
    const userId = await resolveUserIdFromApiKey(null, enrichedOptions.apikey, silent, {
      supaHost: enrichedOptions.supaHost,
      supaAnon: enrichedOptions.supaAnon,
    })

    void trackEvent({ channel: 'account', event: 'Account Id Viewed', tags: {} })

    if (!silent)
      outro(`Done ✅: ${userId}`)

    return userId
  }
  catch (error) {
    if (!silent)
      log.error(`Error getting user id ${formatError(error)}`)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function getUserId(options: Options) {
  await getUserIdInternal(options, false)
}
