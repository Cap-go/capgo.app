import type { Context } from 'hono'
import { cloudlogErr, serializeError } from './logging.ts'
import { checkKey, supabaseAdmin } from './supabase.ts'

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

/**
 * Workers RPC service binding to the admin dashboard API Worker's
 * `CliUsageIngest` entrypoint. Only the prod API Worker has it; the admin
 * dashboard owns the CLI_USAGE dataset writer.
 */
export interface CliUsageIngestBinding {
  record: (event: CliUsageEvent) => Promise<unknown>
}

function getCliUsageIngest(c: Context): CliUsageIngestBinding | undefined {
  return (c.env as { ADMIN_CLI_USAGE?: CliUsageIngestBinding } | undefined)?.ADMIN_CLI_USAGE
}

export function hasCliUsageIngest(c: Context): boolean {
  return !!getCliUsageIngest(c)
}

/**
 * Forward CLI usage to the admin dashboard. Never throws; without the
 * ADMIN_CLI_USAGE binding (preprod, local, Supabase Edge Functions) it records nothing.
 * Prefer /private/config only for v1 — avoid hot authenticated private routes.
 */
export async function trackCliUsage(c: Context, event: CliUsageEvent): Promise<void> {
  const ingest = getCliUsageIngest(c)
  if (!event.cli_version || !ingest)
    return

  try {
    await ingest.record(event)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackCliUsage admin ingest failed', error: serializeError(error) })
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
