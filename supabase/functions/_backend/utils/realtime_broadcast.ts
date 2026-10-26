import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import { cloudlog } from './logging.ts'
import { getEnv } from './utils.ts'

export interface CLIActivityPayload {
  event: string
  channel: string
  description?: string
  icon?: string
  app_id?: string
  org_id: string
  channel_name?: string
  bundle_name?: string
  timestamp: string
}

export async function broadcastCLIEvent(
  c: Context,
  payload: CLIActivityPayload,
): Promise<void> {
  // The console subscribes through /private/console/events (server-sent events).
  // Both fan-outs start together so neither delays the other.
  const consoleEvents = (c.env as { CONSOLE_EVENTS?: DurableObjectNamespace } | undefined)?.CONSOLE_EVENTS
  const consoleBroadcast = consoleEvents
    ? consoleEvents.get(consoleEvents.idFromName(payload.org_id)).fetch('https://console-events/broadcast', {
        method: 'POST',
        body: JSON.stringify(payload),
      }).then((response) => {
        // The object refuses oversized events (413); a rejection must not vanish silently.
        if (!response.ok)
          cloudlog({ requestId: c.get('requestId'), message: 'console events broadcast rejected', org_id: payload.org_id, status: response.status })
      }).catch((error: unknown) => cloudlog({ requestId: c.get('requestId'), message: 'console events broadcast failed', org_id: payload.org_id, error: error instanceof Error ? error.message : String(error) }))
    : Promise.resolve()

  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  const serviceRoleKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    await consoleBroadcast
    return
  }

  const channelName = `cli-events:org:${payload.org_id}`

  const supabaseBroadcast = fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      messages: [{
        topic: channelName,
        event: 'cli-activity',
        payload,
      }],
    }),
  }).catch(() => {
    // Silently ignore broadcast failures - this is non-critical
  })

  await Promise.all([consoleBroadcast, supabaseBroadcast])
}
