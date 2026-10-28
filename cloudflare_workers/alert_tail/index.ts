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

let warnedMissingWebhookSecrets = false

export default {
  async tail(events: TailTraceEvent[], env: Env): Promise<void> {
    const webhookUrl = env.ALERT_WEBHOOK_URL
    const webhookAuth = env.ALERT_WEBHOOK_AUTH
    if (!webhookUrl || !webhookAuth) {
      if (!warnedMissingWebhookSecrets) {
        console.warn('alert tail webhook secrets missing, skipping delivery')
        warnedMissingWebhookSecrets = true
      }
      return
    }

    try {
      const alerts = capPostBodyAlerts(processTailBatch(events))
      if (alerts.length === 0)
        return

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: webhookAuth,
      }

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ alerts }),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok)
        console.error('alert webhook rejected batch', response.status, alerts.length)
    }
    catch (error) {
      console.error('alert webhook delivery failed', error instanceof Error ? error.name : 'unknown')
    }
  },
}
