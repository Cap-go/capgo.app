import type { QueueApi, QueueEnvironment, QueueInfo } from './lib/posthog-queues.ts'
import process from 'node:process'
import { createQueueApi, findQueue, POSTHOG_RETENTION_SECONDS, queueEnvironment, verifiedQueue } from './lib/posthog-queues.ts'

export async function ensurePostHogQueues(api: QueueApi, environment: QueueEnvironment, verifyOnly = false) {
  // Create DLQ first; Worker deployment may only reference resources that already exist.
  for (const name of [`capgo-posthog-events-${environment}-dlq`, `capgo-posthog-events-${environment}`]) {
    let queue = await findQueue(api, name)
    if (!queue && !verifyOnly) {
      try {
        await api<QueueInfo>('', 'POST', { queue_name: name, settings: { message_retention_period: POSTHOG_RETENTION_SECONDS } })
      }
      catch {
        // Recover an uncertain create or a concurrent deployment's create by discovery.
      }
      queue = await findQueue(api, name)
    }
    if (!queue)
      throw new Error(`Queue does not exist: ${name}`)
    if (queue.settings?.message_retention_period !== POSTHOG_RETENTION_SECONDS && !verifyOnly)
      await api(`/${queue.queue_id}`, 'PATCH', { settings: { ...queue.settings, message_retention_period: POSTHOG_RETENTION_SECONDS } })
    await verifiedQueue(api, name)
    console.log(`Verified fourteen-day retention: ${name}`)
    if (name.endsWith('-dlq')) {
      if (queue.consumers?.some(consumer => consumer.type !== 'http_pull'))
        throw new Error('DLQ has an unexpected automatic consumer')
      if (!queue.consumers?.length && !verifyOnly)
        await api(`/${queue.queue_id}/consumers`, 'POST', { type: 'http_pull', settings: { max_retries: 5, visibility_timeout_ms: 600000 } })
      const final = await verifiedQueue(api, name)
      if (final.consumers?.length !== 1 || final.consumers[0].type !== 'http_pull' || final.consumers[0].settings?.max_retries !== 5)
        throw new Error('DLQ must have one HTTP pull consumer with exactly five retries')
    }
  }
}

// Only prod runs the QueueDispatcher, which feeds this queue (sender:
// supabase/functions/_backend/triggers/queue_relay.ts; consumer:
// cloudflare_workers/api/pgmq_relay.ts). Messages hold only pgmq ids and read
// counts, and a late copy is claimed only while its read_ct still matches, so
// the default retention is enough.
export const PGMQ_RELAY_ENVIRONMENTS: readonly QueueEnvironment[] = ['prod']

export async function ensurePgmqRelayQueue(api: QueueApi, environment: QueueEnvironment, verifyOnly = false) {
  const name = `capgo-pgmq-${environment}`
  let queue = await findQueue(api, name)
  if (!queue && !verifyOnly) {
    try {
      await api<QueueInfo>('', 'POST', { queue_name: name })
    }
    catch {
      // Recover an uncertain create or a concurrent deployment's create by discovery.
    }
    queue = await findQueue(api, name)
  }
  if (!queue)
    throw new Error(`Queue does not exist: ${name}`)
  console.log(`Verified queue: ${name}`)
}

/** Every Cloudflare Queue the API worker of this environment needs before it deploys. */
export async function ensureApiQueues(api: QueueApi, environment: QueueEnvironment, verifyOnly = false) {
  await ensurePostHogQueues(api, environment, verifyOnly)
  if (PGMQ_RELAY_ENVIRONMENTS.includes(environment))
    await ensurePgmqRelayQueue(api, environment, verifyOnly)
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const env = args[0] ?? 'all'
    if (args.slice(1).some(arg => arg !== '--verify-only'))
      throw new Error('Usage: bun scripts/ensure-posthog-queues.ts [alpha|preprod|prod|all] [--verify-only]')
    const api = createQueueApi()
    for (const environment of env === 'all' ? ['alpha', 'preprod', 'prod'] as const : [queueEnvironment(env)])
      await ensureApiQueues(api, environment, args.includes('--verify-only'))
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Queue provisioning failed')
    process.exitCode = 1
  }
}
