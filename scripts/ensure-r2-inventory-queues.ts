import type { QueueApi, QueueEnvironment, QueueInfo } from './lib/posthog-queues.ts'
import process from 'node:process'
import { createQueueApi, findQueue, queueEnvironment } from './lib/posthog-queues.ts'

export const INVENTORY_RETENTION_SECONDS = 4 * 24 * 60 * 60

export async function ensureR2InventoryQueues(api: QueueApi, environment: QueueEnvironment) {
  for (const suffix of ['', '-dlq', '-repair', '-repair-dlq']) {
    const name = `capgo-r2-inventory-${environment}${suffix}`
    let queue = await findQueue(api, name)
    if (!queue) {
      try {
        await api<QueueInfo>('', 'POST', { queue_name: name, settings: { message_retention_period: INVENTORY_RETENTION_SECONDS } })
      }
      catch (error) {
        // A concurrent deployment or a lost response can still have created the queue.
        // Only a successful lookup of the exact name can establish that it exists.
        queue = await findQueue(api, name)
        if (!queue)
          throw error
      }
      queue ??= await findQueue(api, name)
    }
    if (!queue || queue.queue_name !== name)
      throw new Error(`Queue does not exist: ${name}`)
    if (queue.settings?.message_retention_period !== INVENTORY_RETENTION_SECONDS) {
      await api(`/${queue.queue_id}`, 'PATCH', {
        settings: { ...queue.settings, message_retention_period: INVENTORY_RETENTION_SECONDS },
      })
    }
    const verified = await findQueue(api, name)
    if (!verified || verified.queue_name !== name || verified.settings?.message_retention_period !== INVENTORY_RETENTION_SECONDS)
      throw new Error(`Queue missing or retention is not four days: ${name}`)
    console.log(`Verified four-day retention: ${name}`)
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: bun scripts/ensure-r2-inventory-queues.ts <alpha|preprod|prod>')
    const environment = queueEnvironment(process.argv[2])
    await ensureR2InventoryQueues(createQueueApi(), environment)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Inventory queue provisioning failed')
    process.exitCode = 1
  }
}
