import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { PgQueryClient } from './pg.ts'
import { cloudlog } from './logging.ts'
import { checkoutPgClient, closeClient, getPgClient, releasePgClient } from './pg.ts'

export function isDemoAppRow(app?: { need_onboarding?: boolean | null }): boolean {
  return app?.need_onboarding === true
}

export async function isDemoApp(c: Context<MiddlewareKeyVariables>, appId: string): Promise<boolean> {
  let data: { need_onboarding: boolean | null } | undefined
  try {
    const pg = await getPgClient(c)
    try {
      const result = await pg.query<{ need_onboarding: boolean | null }>('SELECT need_onboarding FROM public.apps WHERE app_id = $1 LIMIT 1', [appId])
      data = result.rows[0]
    }
    finally {
      closeClient(c, pg)
    }
  }
  catch (error) {
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
