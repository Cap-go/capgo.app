import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { cloudlog } from './logging.ts'
import { checkoutPgClient, closeClient, getPgClient, releasePgClient, type PgQueryClient } from './pg.ts'
import { supabaseAdmin } from './supabase.ts'

export function isDemoAppRow(app?: { need_onboarding?: boolean | null }): boolean {
  return app?.need_onboarding === true
}

export async function isDemoApp(c: Context<MiddlewareKeyVariables>, appId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin(c)
    .from('apps')
    .select('need_onboarding')
    .eq('app_id', appId)
    .maybeSingle()

  if (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot load onboarding app flag', error, app_id: appId })
    throw error
  }

  if (!data) {
    return false
  }

  return isDemoAppRow(data)
}

export async function lockOnboardingApp(c: Context<MiddlewareKeyVariables>, appId: string) {
  const pool = await getPgClient(c)
  let client: PgQueryClient | undefined

  try {
    client = await checkoutPgClient(pool)
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`onboarding-demo:${appId}`])
    return { client, pool }
  }
  catch (error) {
    if (client)
      releasePgClient(pool, client, error instanceof Error ? error : true)
    await closeClient(c, pool)
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot acquire onboarding app lock', error, app_id: appId })
    throw error
  }
}

export async function unlockOnboardingApp(
  c: Context<MiddlewareKeyVariables>,
  lock: Awaited<ReturnType<typeof lockOnboardingApp>>,
  appId: string,
) {
  let releaseError: Error | undefined
  try {
    await lock.client.query('SELECT pg_advisory_unlock(hashtext($1))', [`onboarding-demo:${appId}`])
  }
  catch (error) {
    releaseError = error instanceof Error ? error : new Error('Cannot release onboarding app lock')
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot release onboarding app lock', error, app_id: appId })
  }
  finally {
    releasePgClient(lock.pool, lock.client, releaseError)
    await closeClient(c, lock.pool)
  }
}
