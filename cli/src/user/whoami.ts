import type { Options } from '../api/app'
import { intro, log, outro } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { formatTable } from '../terminal-table'
import { findSavedKey, formatError, invokeCapgoCliApi } from '../utils'

export async function resolveAccountIdentity(
  apikey: string,
  options: { supaHost?: string, supaAnon?: string } = {},
) {
  const { data, error } = await invokeCapgoCliApi<{
    userId?: string
    email?: string | null
  }>('private/cli/identity', {
    apikey,
    method: 'GET',
    body: undefined,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (error)
    throw error

  const userId = (data?.userId || '').toString()
  if (!userId)
    throw new Error('Account identity not found for this API key')

  const email = data?.email
  if (!email)
    throw new Error('Account email not found for this API key')

  return { userId, email }
}

export async function whoami(options: Options) {
  intro('Account details')
  const apikey = options.apikey || findSavedKey()
  if (!apikey) {
    log.error('Missing API key, you need to provide an API key to fetch account details')
    throw new Error('Missing API key')
  }

  try {
    const { userId, email } = await resolveAccountIdentity(apikey, {
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })

    log.info(formatTable({
      headers: ['Account ID', 'Account email'],
      rows: [[userId, email]],
    }))
    void trackEvent({ channel: 'account', event: 'Account Identity Viewed', apikey, tags: {} })
    outro('Done ✅')
  }
  catch (error) {
    log.error(`Error getting account details ${formatError(error)}`)
    throw error instanceof Error ? error : new Error(String(error))
  }
}
