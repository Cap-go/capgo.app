import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { WebhookDeliveryPayload } from '../utils/webhook.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { sendNotifOrg } from '../utils/notifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { backgroundTask } from '../utils/utils.ts'
import {
  deliverWebhook,
  disableWebhook,
  getDeliveryById,
  getWebhookById,
  getWebhookLogUrlMetadata,
  getWebhookPayloadEvent,
  getWebhookPayloadEventId,
  incrementAttemptCount,
  markDeliveryFailed,
  normalizeWebhookDeliveryVersion,
  queueWebhookDeliveryWithDelay,
  scheduleRetry,
  updateDeliveryResult,
  WEBHOOK_MAX_ATTEMPTS,
} from '../utils/webhook.ts'

export const app = new Hono<MiddlewareKeyVariables>()

interface DeliveryMessage {
  delivery_id: string
  webhook_id: string
  url: string
  payload: WebhookDeliveryPayload
}

/**
 * Webhook Delivery Handler
 *
 * This trigger processes individual webhook deliveries.
 *
 * Flow:
 * 1. Receive delivery data from queue
 * 2. Deliver the webhook to the user's endpoint
 * 3. On success: mark as success
 * 4. On failure: retry with backoff (hard max WEBHOOK_MAX_ATTEMPTS = 5)
 * 5. After max retries: mark as failed and send notification via Bento
 */
app.post('/', middlewareAPISecret, async (c) => {
  try {
    const body = await c.req.json()

    // queue_consumer posts the queue payload directly, while direct trigger calls may
    // still send the full pgmq envelope. Only unwrap when the delivery envelope is
    // not already present on the body.
    const deliveryData: DeliveryMessage = body?.delivery_id && body?.webhook_id && body?.url
      ? body
      : (body.payload || body)
    const urlInfo = getWebhookLogUrlMetadata(typeof deliveryData?.url === 'string' ? deliveryData.url : '')

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Webhook delivery handler received',
      deliveryId: deliveryData.delivery_id,
      webhookId: deliveryData.webhook_id,
      urlInfo,
    })

    if (!deliveryData.delivery_id || !deliveryData.webhook_id || !deliveryData.url || !deliveryData.payload) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Invalid delivery data',
        hasDeliveryId: Boolean(deliveryData.delivery_id),
        hasWebhookId: Boolean(deliveryData.webhook_id),
        hasUrl: Boolean(deliveryData.url),
        hasPayload: Boolean(deliveryData.payload),
        urlInfo,
      })
      return c.json(BRES)
    }

    // Get the current delivery record
    const delivery = await getDeliveryById(c, deliveryData.delivery_id)
    if (!delivery) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Delivery record not found',
        deliveryId: deliveryData.delivery_id,
      })
      return c.json(BRES)
    }

    // Skip if already completed successfully
    if (delivery.status === 'success') {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Delivery already successful, skipping',
        deliveryId: deliveryData.delivery_id,
      })
      return c.json(BRES)
    }

    // Get webhook to retrieve secret for signing
    const webhook = await getWebhookById(c, deliveryData.webhook_id)
    if (!webhook) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Webhook not found for delivery',
        webhookId: deliveryData.webhook_id,
      })
      return c.json(BRES)
    }

    // Increment attempt count
    const attemptCount = await incrementAttemptCount(c, deliveryData.delivery_id)
    const deliveryVersion = normalizeWebhookDeliveryVersion(delivery.delivery_version ?? webhook.delivery_version)

    // Attempt delivery with signature
    const result = await deliverWebhook(
      c,
      deliveryData.delivery_id,
      deliveryData.url,
      deliveryData.payload,
      webhook.secret,
      deliveryVersion,
    )

    // Update delivery record with result
    await updateDeliveryResult(
      c,
      deliveryData.delivery_id,
      result.success,
      result.status || null,
      result.body || null,
      result.duration || 0,
    )

    if (result.success) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Webhook delivered successfully',
        deliveryId: deliveryData.delivery_id,
        status: result.status,
        duration: result.duration,
      })
      return c.json(BRES)
    }

    // 410 Gone is an explicit opt-out: disable the endpoint and stop retrying.
    if (result.status === 410) {
      await markDeliveryFailed(c, deliveryData.delivery_id)
      await disableWebhook(c, deliveryData.webhook_id)

      cloudlog({
        requestId: c.get('requestId'),
        message: 'Webhook endpoint disabled after 410 Gone response',
        deliveryId: deliveryData.delivery_id,
        webhookId: deliveryData.webhook_id,
      })

      return c.json(BRES)
    }

    // Handle failure
    // HARD RULE: never more than WEBHOOK_MAX_ATTEMPTS (matches MAX_QUEUE_READS).
    const maxAttempts = Math.min(delivery.max_attempts || WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS)

    if (attemptCount < maxAttempts) {
      const retryDelaySeconds = await scheduleRetry(
        c,
        deliveryData.delivery_id,
        attemptCount,
        result.retryAfter,
        result.status ?? null,
      )

      cloudlog({
        requestId: c.get('requestId'),
        message: 'Scheduling webhook retry',
        deliveryId: deliveryData.delivery_id,
        attemptCount,
        maxAttempts,
        retryDelaySeconds,
      })

      // Queue for retry
      await backgroundTask(c, queueWebhookDeliveryWithDelay(
        c,
        deliveryData.delivery_id,
        deliveryData.webhook_id,
        deliveryData.url,
        deliveryData.payload,
        retryDelaySeconds,
      ))
    }
    else {
      // Max retries reached, mark as permanently failed
      await markDeliveryFailed(c, deliveryData.delivery_id)
      await disableWebhook(c, deliveryData.webhook_id)

      cloudlog({
        requestId: c.get('requestId'),
        message: 'Webhook delivery permanently failed',
        deliveryId: deliveryData.delivery_id,
        attemptCount,
        maxAttempts,
      })

      // Send failure notification via Bento (webhook already fetched above)
      if (webhook) {
        const pgClient = getPgClient(c, true)
        const drizzleClient = getDrizzleClient(pgClient)
        try {
          await backgroundTask(c, sendNotifOrg(
            c,
            'webhook:delivery_failed',
            {
              webhook_name: webhook.name,
              webhook_id: webhook.id,
              webhook_url_info: getWebhookLogUrlMetadata(webhook.url),
              event_type: getWebhookPayloadEvent(deliveryData.payload),
              attempts: attemptCount,
              last_error: result.body?.slice(0, 500) || 'Unknown error',
              delivery_id: deliveryData.delivery_id,
            },
            webhook.org_id,
            `webhook_failure_${webhook.id}_${getWebhookPayloadEventId(deliveryData.payload)}`,
            '0 0 * * *', // Rate limit to once per day per webhook+event
            webhook.orgs.management_email,
            drizzleClient,
          ))

          cloudlog({
            requestId: c.get('requestId'),
            message: 'Sent webhook failure notification',
            webhookId: webhook.id,
            webhookName: webhook.name,
            orgId: webhook.org_id,
          })
        }
        finally {
          closeClient(c, pgClient)
        }
      }
    }

    return c.json(BRES)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Webhook delivery handler error',
      error: serializeError(error),
    })
    return c.json(BRES)
  }
})
