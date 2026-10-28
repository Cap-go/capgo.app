import {
  capPostBodyAlerts,
  processTailBatch,
  type TailTraceEvent,
} from './tail_logic.ts'

export interface Env {
  ALERT_WEBHOOK_URL?: string
  ALERT_WEBHOOK_AUTH?: string
  ENV_NAME?: string
}

export default {
  async tail(events: TailTraceEvent[], env: Env): Promise<void> {
    const webhookUrl = env.ALERT_WEBHOOK_URL
    const webhookAuth = env.ALERT_WEBHOOK_AUTH
    if (!webhookUrl || !webhookAuth)
      return

    try {
      const alerts = capPostBodyAlerts(processTailBatch(events))
      if (alerts.length === 0)
        return

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: webhookAuth,
      }

      await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ alerts }),
      })
    }
    catch {
      // Never throw from tail handler
    }
  },
}
