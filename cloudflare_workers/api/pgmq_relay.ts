import type { ExecutionContext, Message, MessageBatch } from '@cloudflare/workers-types'
import type { Bindings } from '../../supabase/functions/_backend/utils/cloudflare.ts'
import type { RelayedQueueMessage } from '../../supabase/functions/_backend/triggers/queue_consumer.ts'
import { processRelayedQueueMessages, relayedQueueMessageSchema } from '../../supabase/functions/_backend/triggers/queue_consumer.ts'
import { BRES, createAllCatch, createHono } from '../../supabase/functions/_backend/utils/hono.ts'
import { version } from '../../supabase/functions/_backend/utils/version.ts'

// Consumer of the pgmq relay queue (see triggers/queue_relay.ts). The batch
// goes through a Hono app so the queue code gets the same context (request id,
// logging, bindings, waitUntil) as the HTTP queue_consumer it replaces.
const functionName = 'api-pgmq-relay'
const appPgmqRelay = createHono(functionName, version)
const PROCESS_URL = 'https://api-pgmq-relay.capgo.internal/process'
// A failed invocation (database unreachable, crash) is retried by Cloudflare
// Queues. The claim counts the read and only matches the relayed read_ct, so
// a retry skips every message an earlier attempt already claimed: no work runs
// twice for one read or past its five reads.
export const PGMQ_RELAY_RETRY_DELAY_SECONDS = 30

appPgmqRelay.post('/process', async (c) => {
  const messages = await c.req.json<RelayedQueueMessage[]>()
  const results = await processRelayedQueueMessages(c, messages)
  return c.json({ ...BRES, results })
})
createAllCatch(appPgmqRelay, functionName)

function log(event: string, fields: Record<string, unknown>) {
  console.error(JSON.stringify({ event, ...fields }))
}

export async function processPgmqRelayBatch(batch: MessageBatch<unknown>, env: Bindings, ctx: ExecutionContext) {
  const valid: { entry: Message<unknown>, body: RelayedQueueMessage }[] = []
  for (const entry of batch.messages) {
    const parsed = relayedQueueMessageSchema.safeParse(entry.body)
    if (parsed.success) {
      valid.push({ entry, body: parsed.data })
      continue
    }
    // Never processable; the pgmq message (if any) is relayed again by the
    // next wakeup once its visibility timeout ends.
    log('pgmq_relay_invalid_message', { queue: batch.queue, id: entry.id })
    entry.ack()
  }
  if (valid.length === 0)
    return

  try {
    const response = await appPgmqRelay.fetch(new Request(PROCESS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(valid.map(message => message.body)),
    }), env, ctx)
    await response.arrayBuffer()
    if (response.ok) {
      // Failed queue work is not retried here: it stays in pgmq, which counts
      // the attempts (at most five) and makes it readable again.
      for (const { entry } of valid)
        entry.ack()
      return
    }
    log('pgmq_relay_batch_failed', { queue: batch.queue, status: response.status, count: valid.length })
  }
  catch (error) {
    log('pgmq_relay_batch_failed', { queue: batch.queue, error: error instanceof Error ? error.message : String(error), count: valid.length })
  }
  for (const { entry } of valid)
    entry.retry({ delaySeconds: PGMQ_RELAY_RETRY_DELAY_SECONDS })
}
