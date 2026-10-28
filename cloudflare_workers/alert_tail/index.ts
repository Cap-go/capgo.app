import { isAllowedAlertWebhookUrl } from './redact.ts'
import {
  processTailBatch,
  type TailTraceEvent,
} from './tail_logic.ts'
import { AlertThrottle } from './throttle_do.ts'
import {
  parseThrottleSummaryIntervalSec,
  parseThrottleWindowSec,
} from './throttle_logic.ts'

export { AlertThrottle }

export interface Env {
  ALERT_WEBHOOK_URL?: string
  ALERT_WEBHOOK_AUTH?: string
  ENV_NAME?: string
  ALERT_THROTTLE?: DurableObjectNamespace
  ALERT_THROTTLE_WINDOW_SEC?: string
  ALERT_THROTTLE_SUMMARY_INTERVAL_SEC?: string
}

let warnedMissingWebhookSecrets = false
let warnedInsecureWebhookUrl = false

async function applyDurableThrottle(
  namespace: DurableObjectNamespace,
  envName: string,
  records: Awaited<ReturnType<typeof processTailBatch>>,
  env: Env,
): Promise<Awaited<ReturnType<typeof processTailBatch>>> {
  const id = namespace.idFromName(envName)
  const stub = namespace.get(id)
  const applyUrl = 'https://alert-throttle/apply'
  const response = await stub.fetch(applyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      records,
      nowMs: Date.now(),
      windowSec: parseThrottleWindowSec(env.ALERT_THROTTLE_WINDOW_SEC),
      summaryIntervalSec: parseThrottleSummaryIntervalSec(env.ALERT_THROTTLE_SUMMARY_INTERVAL_SEC),
    }),
  })
  if (!response.ok) {
    console.error('alert tail throttle DO failed', response.status)
    await stub.fetch('https://alert-throttle/rollback', { method: 'POST' })
    return []
  }
  const body = await response.json() as { alerts?: Awaited<ReturnType<typeof processTailBatch>> }
  return body.alerts ?? []
}

async function finalizeDurableThrottle(
  namespace: DurableObjectNamespace,
  envName: string,
  delivered: boolean,
): Promise<void> {
  const id = namespace.idFromName(envName)
  const stub = namespace.get(id)
  const path = delivered ? 'https://alert-throttle/ack' : 'https://alert-throttle/rollback'
  await stub.fetch(path, { method: 'POST' })
}

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

      let alerts = batch
      const throttleNamespace = env.ALERT_THROTTLE
      const throttleEnvName = env.ENV_NAME ?? 'capgo_alert_tail'
      if (throttleNamespace) {
        alerts = await applyDurableThrottle(
          throttleNamespace,
          throttleEnvName,
          batch,
          env,
        )
      }

      if (alerts.length === 0) {
        if (throttleNamespace)
          await finalizeDurableThrottle(throttleNamespace, throttleEnvName, false)
        return
      }

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
      if (throttleNamespace)
        await finalizeDurableThrottle(throttleNamespace, throttleEnvName, response.ok)

      if (!response.ok)
        console.error('alert webhook rejected batch', response.status, alerts.length)
    }
    catch (error) {
      console.error('alert webhook delivery failed', error instanceof Error ? error.name : 'unknown')
    }
  },
}
