import type { Context } from 'hono'
import type { PoolClient } from 'pg'
import type { MiddlewareKeyVariables } from './hono.ts'
import { cloudlog } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
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
  const pool = getPgClient(c)
  let client: PoolClient | undefined

  try {
    client = await pool.connect()
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`onboarding-demo:${appId}`])
    return { client, pool }
  }
  catch (error) {
    client?.release(error instanceof Error ? error : true)
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
    lock.client.release(releaseError)
    await closeClient(c, lock.pool)
  }
}
