import type { Context } from 'hono'
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
  const consoleEvents = c.env?.CONSOLE_EVENTS
  if (consoleEvents) {
    await consoleEvents.get(consoleEvents.idFromName(payload.org_id)).fetch('https://console-events/broadcast', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).catch(() => {})
  }
  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  const serviceRoleKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey)
    return

  const channelName = `cli-events:org:${payload.org_id}`

  await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
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
}
