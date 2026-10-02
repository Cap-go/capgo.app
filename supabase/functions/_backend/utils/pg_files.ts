import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import type { PgAuthLookupResult } from './pg_auth_lookup.ts'
import { eq, sql } from 'drizzle-orm'
import { cloudlog } from './logging.ts'
import { logPgError } from './pg.ts'
import { withAuthPgRetry } from './pg_auth_retry.ts'
import * as schema from './postgres_schema.ts'

/**
 * Get user_id from apikey using the existing Postgres function
 */
export async function getUserIdFromApikey(
  c: Context,
  apikey: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<PgAuthLookupResult<string>> {
  try {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'getUserIdFromApikey - querying',
      apikeyPrefix: apikey?.substring(0, 15),
    })

    const result = await withAuthPgRetry(() => drizzleClient.execute<{ get_user_id: string }>(
      sql`SELECT get_user_id(${apikey})`,
    ))

    const userId = result.rows[0]?.get_user_id ?? null

    cloudlog({
      requestId: c.get('requestId'),
      message: 'getUserIdFromApikey - result',
      userId,
    })

    if (!userId)
      return { kind: 'not_found' }

    return { kind: 'ok', value: userId }
  }
  catch (e: unknown) {
    logPgError(c, 'getUserIdFromApikey', e)
    return { kind: 'db_error', error: e }
  }
}

/**
 * Get app by app_id with owner_org
 */
export async function getAppByAppIdPg(
  c: Context,
  appId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<PgAuthLookupResult<{ app_id: string, owner_org: string }>> {
  try {
    const app = await withAuthPgRetry(() => drizzleClient
      .select({
        app_id: schema.apps.app_id,
        owner_org: schema.apps.owner_org,
      })
      .from(schema.apps)
      .where(eq(schema.apps.app_id, appId))
      .limit(1)
      .then(data => data[0]))

    if (!app)
      return { kind: 'not_found' }

    return { kind: 'ok', value: app }
  }
  catch (e: unknown) {
    logPgError(c, 'getAppByAppIdPg', e)
    return { kind: 'db_error', error: e }
  }
}
