import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import { eq, sql } from 'drizzle-orm'
import { cloudlog } from './logging.ts'
import { logPgError } from './pg.ts'
import * as schema from './postgres_schema.ts'

/**
 * Get user_id from apikey using the existing Postgres function
 */
export async function getUserIdFromApikey(
  c: Context,
  apikey: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<string | null> {
  try {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'getUserIdFromApikey - querying',
      apikeyPrefix: apikey?.substring(0, 15),
    })

    // Call the existing Postgres function
    const result = await drizzleClient.execute<{ get_user_id: string }>(
      sql`SELECT get_user_id(${apikey})`,
    )

    const userId = result.rows[0]?.get_user_id ?? null

    cloudlog({
      requestId: c.get('requestId'),
      message: 'getUserIdFromApikey - result',
      userId,
    })

    return userId
  }
  catch (e: unknown) {
    logPgError(c, 'getUserIdFromApikey', e)
    return null
  }
}

/**
 * Get app by app_id with owner_org
 */
export async function getAppByAppIdPg(
  c: Context,
  appId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ app_id: string, owner_org: string } | null> {
  try {
    const app = await drizzleClient
      .select({
        app_id: schema.apps.app_id,
        owner_org: schema.apps.owner_org,
      })
      .from(schema.apps)
      .where(eq(schema.apps.app_id, appId))
      .limit(1)
      .then(data => data[0])

    return app ?? null
  }
  catch (e: unknown) {
    logPgError(c, 'getAppByAppIdPg', e)
    return null
  }
}
