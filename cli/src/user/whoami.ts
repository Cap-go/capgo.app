import type { SupabaseClient } from '@supabase/supabase-js'
import type { Options } from '../api/app'
import type { Database } from '../types/supabase.types'
import { intro, log, outro } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { formatTable } from '../terminal-table'
import { createSupabaseClient, findSavedKey, formatError, resolveUserIdFromApiKey } from '../utils'

export async function resolveAccountIdentity(supabase: SupabaseClient<Database>, apikey: string) {
  const [userId, emailResult] = await Promise.all([
    resolveUserIdFromApiKey(supabase, apikey, true),
    supabase.rpc('request_actor_email_adress'),
  ])

  if (emailResult.error)
    throw emailResult.error
  if (!emailResult.data)
    throw new Error('Account email not found for this API key')

  return { userId, email: emailResult.data }
}

export async function whoami(options: Options) {
  intro('Account details')
  const apikey = options.apikey || findSavedKey()
  if (!apikey) {
    log.error('Missing API key, you need to provide an API key to fetch account details')
    throw new Error('Missing API key')
  }

  try {
    const supabase = await createSupabaseClient(apikey, options.supaHost, options.supaAnon)
    const { userId, email } = await resolveAccountIdentity(supabase, apikey)

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
