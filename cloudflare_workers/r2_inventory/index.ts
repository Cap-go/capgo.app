import type { InventoryConfig, InventoryEvent, RepairTask } from '../../supabase/functions/_backend/utils/r2_inventory.ts'
import { Client } from 'pg'
import { applyInventoryEvents, applyObservations, loadInventoryConfig, normalizeEtag, parseInventoryEvent, readObservationSnapshot } from '../../supabase/functions/_backend/utils/r2_inventory.ts'

export interface InventoryEnv {
  INVENTORY_BUCKET: string
  HYPERDRIVE_CAPGO_DIRECT_EU: Hyperdrive
  ATTACHMENT_BUCKET: R2Bucket
  REPAIR_QUEUE: Queue<RepairTask>
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

export async function repairInventoryBatch(env: InventoryEnv, tasks: RepairTask[], config: InventoryConfig) {
  const keys = [...new Set(tasks.map(task => task.key))]
  if (keys.length > 10)
    throw new Error('Repair batch exceeds 10 keys')
  const snapshot = await withDatabase(env, db => readObservationSnapshot(db, env.INVENTORY_BUCKET, keys))
  const observations: Parameters<typeof applyObservations>[3] = []
  // Only two HEAD requests can be in flight, and no DB connection is held during them.
  for (let offset = 0; offset < keys.length; offset += 2) {
    const pair = await Promise.all(keys.slice(offset, offset + 2).map(async (key) => {
      const object = await env.ATTACHMENT_BUCKET.head(key)
      return { key, object: object ? { key, size: object.size, etag: normalizeEtag(object.etag), lastModified: object.uploaded.toISOString() } : null }
    }))
    observations.push(...pair)
  }
  const conflicts = await withDatabase(env, db => applyObservations(db, env.INVENTORY_BUCKET, snapshot, observations, config))
  if (conflicts.length)
    throw new Error('Concurrent inventory changes require another observation')
}

export async function consumeInventoryBatch(batch: MessageBatch<unknown>, env: InventoryEnv) {
  const started = Date.now()
  let minBatchMs = 500
  try {
    let config: InventoryConfig
    if (batch.queue.endsWith('-repair')) {
      config = await withDatabase(env, loadInventoryConfig)
      minBatchMs = config.minBatchMs
      if (!config.enabled)
        throw new Error('R2 inventory ingestion is disabled in Vault')
      const valid = batch.messages.flatMap((message) => {
        try {
          return [parseRepairTask(message.body, env.INVENTORY_BUCKET)]
        }
        catch {
          message.retry({ delaySeconds: 60 })
          return []
        }
      })
      if (valid.length)
        await repairInventoryBatch(env, valid, config)
      for (const message of batch.messages) {
        try {
          parseRepairTask(message.body, env.INVENTORY_BUCKET)
          message.ack()
        }
        catch { /* Poison messages reach the configured DLQ within five deliveries. */ }
      }
    }
    else {
      const valid: { event: InventoryEvent, message: Message<unknown> }[] = []
      for (const message of batch.messages) {
        try {
          valid.push({ event: parseInventoryEvent(message.body, env.INVENTORY_BUCKET), message })
        }
        catch { message.retry({ delaySeconds: 60 }) }
      }
      const repairs = await withDatabase(env, async (db) => {
        config = await loadInventoryConfig(db)
        minBatchMs = config.minBatchMs
        if (!config.enabled)
          throw new Error('R2 inventory ingestion is disabled in Vault')
        return applyInventoryEvents(db, valid.map(item => item.event), config)
      })
      // Publication must succeed before acknowledging the source. Ambiguous events
      // remain unmodified, so replay retries publication rather than losing repair.
      if (repairs.length)
        await env.REPAIR_QUEUE.sendBatch(repairs.map(body => ({ body, contentType: 'json' })))
      for (const item of valid)
        item.message.ack()
      console.log(JSON.stringify({ event: 'r2_inventory_batch', received: batch.messages.length, accepted: valid.length, repairs: repairs.length }))
    }
  }
  catch (error) {
    console.error(JSON.stringify({ event: 'r2_inventory_batch_failed', error: error instanceof Error ? error.message : 'Unknown error' }))
    batch.retryAll({ delaySeconds: 30 })
  }
  finally {
    // Full batches bypass max_batch_timeout. Pacing bounds batch-start frequency
    // even during a sustained backlog; the connection has already been released.
    const remaining = minBatchMs - (Date.now() - started)
    if (remaining > 0)
      await new Promise(resolve => setTimeout(resolve, remaining))
  }
}

export default { queue: consumeInventoryBatch }
