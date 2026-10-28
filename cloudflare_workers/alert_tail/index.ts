import { isAllowedAlertWebhookUrl } from './redact.ts'
import {
  processTailBatch,
  type AlertTailRecord,
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

type ThrottleApplyResult = {
  alerts: AlertTailRecord[]
  planId: string
}

async function applyDurableThrottle(
  namespace: DurableObjectNamespace,
  envName: string,
  records: AlertTailRecord[],
  env: Env,
): Promise<ThrottleApplyResult | null> {
  const id = namespace.idFromName(envName)
  const stub = namespace.get(id)
  const response = await stub.fetch('https://alert-throttle/apply', {
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
    return null
  }
  const body = await response.json() as { alerts?: AlertTailRecord[], planId?: string }
  if (!body.planId)
    return null
  return { alerts: body.alerts ?? [], planId: body.planId }
}

async function finalizeDurableThrottle(
  namespace: DurableObjectNamespace,
  envName: string,
  planId: string,
  delivered: boolean,
): Promise<void> {
  const id = namespace.idFromName(envName)
  const stub = namespace.get(id)
  const path = delivered ? 'https://alert-throttle/ack' : 'https://alert-throttle/rollback'
  await stub.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId }),
  })
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

    const throttleNamespace = env.ALERT_THROTTLE
    const throttleEnvName = env.ENV_NAME ?? 'capgo_alert_tail'
    let throttlePlanId: string | undefined

    try {
      const batch = processTailBatch(events)
      if (batch.length === 0)
        return

      let alerts = batch
      if (throttleNamespace) {
        const applied = await applyDurableThrottle(
          throttleNamespace,
          throttleEnvName,
          batch,
          env,
        )
        if (!applied)
          return
        alerts = applied.alerts
        throttlePlanId = applied.planId
      }

      if (alerts.length === 0) {
        if (throttleNamespace && throttlePlanId)
          await finalizeDurableThrottle(throttleNamespace, throttleEnvName, throttlePlanId, true)
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
      if (throttleNamespace && throttlePlanId)
        await finalizeDurableThrottle(throttleNamespace, throttleEnvName, throttlePlanId, response.ok)

      if (!response.ok)
        console.error('alert webhook rejected batch', response.status, alerts.length)
    }
    catch (error) {
      if (throttleNamespace && throttlePlanId) {
        await finalizeDurableThrottle(throttleNamespace, throttleEnvName, throttlePlanId, false)
          .catch(() => undefined)
      }
      console.error('alert webhook delivery failed', error instanceof Error ? error.name : 'unknown')
    }
  },
}
