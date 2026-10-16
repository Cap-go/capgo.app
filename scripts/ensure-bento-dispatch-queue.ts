import type { QueueApi, QueueInfo } from './lib/posthog-queues.ts'
import process from 'node:process'
import { createQueueApi, findQueue } from './lib/posthog-queues.ts'

export const BENTO_QUEUE_NAME = 'capgo-bento-dispatch-prod'
export const BENTO_QUEUE_RETENTION_SECONDS = 4 * 24 * 60 * 60

export async function ensureBentoDispatchQueue(api: QueueApi) {
  let queue = await findQueue(api, BENTO_QUEUE_NAME)
  if (!queue) {
    try {
      await api<QueueInfo>('', 'POST', {
        queue_name: BENTO_QUEUE_NAME,
        settings: { message_retention_period: BENTO_QUEUE_RETENTION_SECONDS },
      })
    }
    catch (error) {
      queue = await findQueue(api, BENTO_QUEUE_NAME)
      if (!queue)
        throw error
    }
    queue ??= await findQueue(api, BENTO_QUEUE_NAME)
  }
  if (!queue || queue.queue_name !== BENTO_QUEUE_NAME)
    throw new Error('Bento dispatch queue does not exist')
  if (queue.settings?.message_retention_period !== BENTO_QUEUE_RETENTION_SECONDS) {
    await api(`/${queue.queue_id}`, 'PATCH', {
      settings: { ...queue.settings, message_retention_period: BENTO_QUEUE_RETENTION_SECONDS },
    })
  }
  const verified = await findQueue(api, BENTO_QUEUE_NAME)
  if (!verified || verified.settings?.message_retention_period !== BENTO_QUEUE_RETENTION_SECONDS)
    throw new Error('Bento dispatch queue retention verification failed')
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'prod')
      throw new Error('Usage: bun scripts/ensure-bento-dispatch-queue.ts prod')
    await ensureBentoDispatchQueue(createQueueApi())
  }
  catch {
    console.error('Bento dispatch queue provisioning failed')
    process.exitCode = 1
  }
}
