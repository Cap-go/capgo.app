import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types'
import type { Bindings } from '../../supabase/functions/_backend/utils/cloudflare.ts'
import type { NativeNotificationQueueMessage } from '../../supabase/functions/_backend/utils/nativeNotifications.ts'
import { processNativeNotificationQueueBatch } from '../../supabase/functions/_backend/utils/nativeNotificationSender.ts'
import { processPostHogQueueBatch } from '../../supabase/functions/_backend/utils/posthog_queue.ts'
import { processPgmqRelayBatch } from './pgmq_relay.ts'

export async function processApiQueueBatch(batch: MessageBatch<unknown>, env: Bindings, ctx?: ExecutionContext) {
  const environment = env.ENV_NAME?.replace(/^capgo_api-/, '')
  if (!environment || !['alpha', 'preprod', 'prod', 'local'].includes(environment))
    throw new Error('Unknown API queue environment')
  if (batch.queue === `capgo-native-notifications-${environment}`)
    return processNativeNotificationQueueBatch(batch as MessageBatch<NativeNotificationQueueMessage>, env)
  if (batch.queue === `capgo-posthog-events-${environment}`)
    return processPostHogQueueBatch(batch, env)
  if (batch.queue === `capgo-pgmq-${environment}` && ctx)
    return processPgmqRelayBatch(batch, env, ctx)
  // Throwing leaves every message unacknowledged; never route by body shape.
  throw new Error('Unknown API queue')
}
