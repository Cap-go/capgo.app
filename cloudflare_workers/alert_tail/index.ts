import { isAllowedAlertWebhookUrl } from './redact.ts'
import {
  capPostBodyAlerts,
  processTailBatch,
  type TailTraceEvent,
} from './tail_logic.ts'
import {
  applyCrossCallThrottle,
  kvThrottleStore,
  parseThrottleSummaryIntervalSec,
  parseThrottleWindowSec,
} from './throttle_logic.ts'

export interface Env {
  ALERT_WEBHOOK_URL?: string
  ALERT_WEBHOOK_AUTH?: string
  ENV_NAME?: string
  ALERT_THROTTLE_STORE?: KVNamespace
  ALERT_THROTTLE_WINDOW_SEC?: string
  ALERT_THROTTLE_SUMMARY_INTERVAL_SEC?: string
}

let warnedMissingWebhookSecrets = false
let warnedInsecureWebhookUrl = false

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

    if (!isAllowedAlertWebhookUrl(webhookUrl)) {
      if (!warnedInsecureWebhookUrl) {
        console.warn('alert tail webhook URL must use https, skipping delivery')
        warnedInsecureWebhookUrl = true
      }
      return
    }

    try {
      const batch = processTailBatch(events)
      if (batch.length === 0)
        return

      const windowSec = parseThrottleWindowSec(env.ALERT_THROTTLE_WINDOW_SEC)
      const summarySec = parseThrottleSummaryIntervalSec(env.ALERT_THROTTLE_SUMMARY_INTERVAL_SEC)
      const windowMs = windowSec * 1000
      const summaryIntervalMs = summarySec * 1000
      const nowMs = Date.now()

      let alerts = batch
      if (env.ALERT_THROTTLE_STORE) {
        const store = kvThrottleStore(
          env.ALERT_THROTTLE_STORE,
          Math.max(windowSec * 2, 600),
        )
        alerts = await applyCrossCallThrottle(batch, store, nowMs, {
          windowMs,
          summaryIntervalMs,
        })
      }

      alerts = capPostBodyAlerts(alerts)
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
