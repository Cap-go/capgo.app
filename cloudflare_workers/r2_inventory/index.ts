import type { InventoryConfig, RepairTask } from '../../supabase/functions/_backend/utils/r2_inventory.ts'
import { Client } from 'pg'
import { applyInventoryEvents, applyObservations, INVENTORY_CONFIG, normalizeEtag, parseInventoryEvent, readObservationSnapshot } from '../../supabase/functions/_backend/utils/r2_inventory.ts'

interface RejectedInventoryMessage {
  kind: 'invalid_inventory_message'
  originalQueue: string
  originalMessageId: string
  originalTimestamp: string
  attempts: number
  reason: string
  body: unknown
}

export interface InventoryEnv {
  INVENTORY_BUCKET: string
  HYPERDRIVE_CAPGO_DIRECT_EU: Hyperdrive
  ATTACHMENT_BUCKET: R2Bucket
  REPAIR_QUEUE: Queue<RepairTask>
  EVENT_DLQ: Queue<RejectedInventoryMessage>
  REPAIR_DLQ: Queue<RejectedInventoryMessage>
}

async function withDatabase<T>(env: InventoryEnv, operation: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: env.HYPERDRIVE_CAPGO_DIRECT_EU.connectionString, connectionTimeoutMillis: 5000, query_timeout: 15000 })
  try {
    await db.connect()
    return await operation(db)
  }
  finally {
    await db.end()
  }
}

function parseRepairTask(body: unknown, bucket: string): RepairTask {
  const data = body as Partial<RepairTask> | null
  if (!data || data.bucket !== bucket || data.kind !== 'verify' || typeof data.key !== 'string'
    || new TextEncoder().encode(data.key).length < 1 || new TextEncoder().encode(data.key).length > 1024) {
    throw new Error('Invalid inventory repair task')
  }
  return data as RepairTask
}

export async function repairInventoryBatch(env: InventoryEnv, tasks: RepairTask[], config: InventoryConfig): Promise<Set<string>> {
  const keys = [...new Set(tasks.map(task => task.key))]
  if (keys.length > 10)
    throw new Error('Repair batch exceeds 10 keys')
  const snapshot = await withDatabase(env, db => readObservationSnapshot(db, env.INVENTORY_BUCKET, keys))
  const observations: Parameters<typeof applyObservations>[3] = []
  const failed = new Set<string>()
  // Only two HEAD requests can be in flight, and no DB connection is held during them.
  for (let offset = 0; offset < keys.length; offset += 2) {
    const pairKeys = keys.slice(offset, offset + 2)
    const pair = await Promise.allSettled(pairKeys.map(async (key) => {
      const object = await env.ATTACHMENT_BUCKET.head(key)
      return { key, object: object ? { key, size: object.size, etag: normalizeEtag(object.etag), lastModified: object.uploaded.toISOString() } : null }
    }))
    for (const [index, result] of pair.entries()) {
      if (result.status === 'fulfilled') {
        observations.push(result.value)
      }
      else {
        failed.add(pairKeys[index])
        console.error(JSON.stringify({ event: 'r2_inventory_head_failed', key: pairKeys[index], error: result.reason instanceof Error ? result.reason.message : 'Unknown error' }))
      }
    }
  }
  if (observations.length) {
    const conflicts = await withDatabase(env, db => applyObservations(db, env.INVENTORY_BUCKET, snapshot, observations, config))
    for (const key of conflicts)
      failed.add(key)
  }
  return failed
}

function parseMessages<T>(messages: readonly Message<unknown>[], parse: (body: unknown) => T) {
  const valid: { value: T, message: Message<unknown> }[] = []
  const invalid: { message: Message<unknown>, reason: string }[] = []
  for (const message of messages) {
    try {
      valid.push({ value: parse(message.body), message })
    }
    catch (error) {
      invalid.push({ message, reason: error instanceof Error ? error.message : 'Invalid inventory message' })
    }
  }
  return { valid, invalid }
}

async function publishInvalidMessages(batch: MessageBatch<unknown>, invalid: { message: Message<unknown>, reason: string }[], dlq: Queue<RejectedInventoryMessage>) {
  if (!invalid.length)
    return
  try {
    await dlq.sendBatch(invalid.map(({ message, reason }) => {
      const body: RejectedInventoryMessage = {
        kind: 'invalid_inventory_message',
        originalQueue: batch.queue,
        originalMessageId: message.id,
        originalTimestamp: message.timestamp.toISOString(),
        attempts: message.attempts,
        reason,
        body: message.body,
      }
      // Keep ordinary notifications previewable; preserve non-JSON poison bodies too.
      let contentType: 'json' | 'v8' = 'json'
      try {
        JSON.stringify(body)
      }
      catch {
        contentType = 'v8'
      }
      return { body, contentType }
    }))
  }
  catch (error) {
    console.error(JSON.stringify({ event: 'r2_inventory_dlq_publish_failed', queue: batch.queue, rejected: invalid.length, error: error instanceof Error ? error.message : 'Unknown error' }))
    for (const { message } of invalid)
      message.retry({ delaySeconds: 30 })
    return
  }
  // Publication and ACK are separate; source identity permits DLQ deduplication.
  for (const { message } of invalid)
    message.ack()
}

export async function consumeInventoryBatch(batch: MessageBatch<unknown>, env: InventoryEnv) {
  try {
    if (batch.queue.endsWith('-repair')) {
      const { valid, invalid } = parseMessages(batch.messages, body => parseRepairTask(body, env.INVENTORY_BUCKET))
      await publishInvalidMessages(batch, invalid, env.REPAIR_DLQ)
      const failed = valid.length
        ? await repairInventoryBatch(env, valid.map(item => item.value), INVENTORY_CONFIG)
        : new Set<string>()
      let retried = 0
      for (const { message, value } of valid) {
        if (failed.has(value.key)) {
          message.retry({ delaySeconds: 30 })
          retried++
        }
        else {
          message.ack()
        }
      }
      console.log(JSON.stringify({ event: 'r2_inventory_repair_batch', received: batch.messages.length, acknowledged: valid.length - retried, rejected: invalid.length, retried }))
    }
    else {
      const { valid, invalid } = parseMessages(batch.messages, body => parseInventoryEvent(body, env.INVENTORY_BUCKET))
      await publishInvalidMessages(batch, invalid, env.EVENT_DLQ)
      const repairs = valid.length
        ? await withDatabase(env, db => applyInventoryEvents(db, valid.map(item => item.value), INVENTORY_CONFIG))
        : []
      const repairKeys = new Set(repairs.map(task => task.key))
      const pending = valid.filter(item => repairKeys.has(item.value.key))
      for (const { message, value } of valid) {
        if (!repairKeys.has(value.key))
          message.ack()
      }
      // Ambiguous events need durable repair publication before acknowledgement.
      // Other notifications have committed and do not need publication retries.
      if (repairs.length) {
        try {
          await env.REPAIR_QUEUE.sendBatch(repairs.map(body => ({ body, contentType: 'json' })))
        }
        catch (error) {
          console.error(JSON.stringify({ event: 'r2_inventory_repair_publish_failed', repairs: repairs.length, retried: pending.length, error: error instanceof Error ? error.message : 'Unknown error' }))
          for (const { message } of pending)
            message.retry({ delaySeconds: 30 })
          return
        }
      }
      for (const { message } of pending)
        message.ack()
      console.log(JSON.stringify({ event: 'r2_inventory_batch', received: batch.messages.length, accepted: valid.length, rejected: invalid.length, repairs: repairs.length }))
    }
  }
  catch (error) {
    console.error(JSON.stringify({ event: 'r2_inventory_batch_failed', error: error instanceof Error ? error.message : 'Unknown error' }))
    batch.retryAll({ delaySeconds: 30 })
  }
}

export default { queue: consumeInventoryBatch }
