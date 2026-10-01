import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { checkKey, supabaseAdmin } from './supabase.ts'
import { backgroundTask } from './utils.ts'

export interface CliUsageEvent {
  cli_version: string
  command: string
  node_version: string
  os_platform: string
  apikey_id: string | null
  org_id: string | null
  source: 'config' | 'api' | 'events'
  api_version: string
}

function usesAnalyticsEngine(c: Context): boolean {
  return getRuntimeKey() === 'workerd' && !!c.env.CLI_USAGE
}

/**
 * Record CLI usage from request headers.
 * Prefer /private/config only for v1 — avoid hot authenticated private routes.
 */
export function trackCliUsage(c: Context, event: CliUsageEvent) {
  if (!event.cli_version)
    return

  try {
    if (usesAnalyticsEngine(c)) {
      backgroundTask(c, Promise.resolve().then(() => {
        try {
          c.env.CLI_USAGE.writeDataPoint({
            blobs: [
              event.cli_version,
              event.command,
              event.node_version,
              event.os_platform,
              event.apikey_id ?? '',
              event.org_id ?? '',
              event.source,
              event.api_version,
            ],
            indexes: [event.apikey_id || 'anonymous'],
          })
        }
        catch (error) {
          cloudlogErr({ requestId: c.get('requestId'), message: 'trackCliUsage AE write failed', error: serializeError(error) })
        }
      }))
      return
    }

    backgroundTask(c, (async () => {
      const pgClient = getPgClient(c, false)
      try {
        await pgClient.query(
          `INSERT INTO public.cli_usage
            (cli_version, command, node_version, os_platform, apikey_id, org_id, source, api_version)
           VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8)`,
          [
            event.cli_version,
            event.command,
            event.node_version,
            event.os_platform,
            event.apikey_id,
            event.org_id,
            event.source,
            event.api_version,
          ],
        )
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'trackCliUsage insert error', error: serializeError(error) })
      }
      finally {
        await closeClient(c, pgClient)
      }
    })())
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackCliUsage error', error: serializeError(error) })
  }
}

export async function resolveCliUsageIdentity(
  c: Context,
  capgkey: string | undefined,
): Promise<{ apikey_id: string | null, org_id: string | null }> {
  if (!capgkey)
    return { apikey_id: null, org_id: null }

  try {
    const apikey = await checkKey(c, capgkey, supabaseAdmin(c))
    if (!apikey)
      return { apikey_id: null, org_id: null }
    return {
      apikey_id: apikey.rbac_id ?? null,
      // API key rows do not carry an owner_org, so CLI events cannot derive one here.
      org_id: null,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'resolveCliUsageIdentity failed', error: serializeError(error) })
    return { apikey_id: null, org_id: null }
  }
}
