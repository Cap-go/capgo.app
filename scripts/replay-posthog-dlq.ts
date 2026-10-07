import type { QueueApi, QueueEnvironment } from './lib/posthog-queues.ts'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { replayablePostHogMessage } from '../supabase/functions/_backend/utils/posthog_queue.ts'
import { createQueueApi, queueEnvironment, verifiedQueue } from './lib/posthog-queues.ts'

interface PullMessage {
  body: string
  attempts: number
  lease_id?: string
  metadata?: { 'CF-Content-Type'?: string }
}

function decodeMessage(entry: PullMessage) {
  try {
    if (entry.metadata?.['CF-Content-Type'] !== 'json' || typeof entry.body !== 'string' || entry.body.length > 180 * 1024
      || !/^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i.test(entry.body)) {
      return undefined
    }
    return replayablePostHogMessage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(entry.body, 'base64'))))
  }
  catch {
    return undefined
  }
}

export async function replayPostHogDlq(api: QueueApi, environment: QueueEnvironment, execute = false, limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Replay limit must be an integer from 1 to 100')
  const main = await verifiedQueue(api, `capgo-posthog-events-${environment}`)
  const dlq = await verifiedQueue(api, `capgo-posthog-events-${environment}-dlq`)
  if (!execute) {
    // Dry run never acquires a lease (pulling changes queue state and attempts).
    const metrics = await api<{ backlog_count: number }>(`/${dlq.queue_id}/metrics`)
    if (typeof metrics.backlog_count !== 'number' || !Number.isFinite(metrics.backlog_count) || metrics.backlog_count < 0)
      throw new Error('Invalid backlog metrics')
    console.log(JSON.stringify({ mode: 'dry_run', backlog_count: metrics.backlog_count, limit }))
    return { published: 0, refused: 0 }
  }
  if (dlq.consumers?.length !== 1 || dlq.consumers[0].type !== 'http_pull')
    throw new Error('DLQ requires the provisioned HTTP pull consumer')
  let published = 0
  let refused = 0
  const deadline = Date.now() + 8 * 60 * 1000
  // At most ten leased messages at once; never pull more than this run's bound.
  while (published + refused < limit && Date.now() < deadline) {
    // Peek does not consume retry budget. Refuse known-invalid or near-exhaustion
    // messages before leasing; run only one operator replay process per environment.
    const size = Math.min(10, limit - published - refused)
    const preview = await api<{ messages: PullMessage[] }>(`/${dlq.queue_id}/messages/peek`, 'POST', { batch_size: size })
    if (!Array.isArray(preview.messages) || preview.messages.length > size)
      throw new Error('Invalid preview response')
    refused = preview.messages.filter(entry => !decodeMessage(entry) || !Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts >= 4).length
    if (refused || !preview.messages.length)
      break
    const leaseStarted = Date.now()
    const result = await api<{ messages: PullMessage[] }>(`/${dlq.queue_id}/messages/pull`, 'POST', {
      batch_size: size,
      visibility_timeout_ms: 600000,
    })
    if (!Array.isArray(result.messages) || result.messages.length > size)
      throw new Error('Invalid pull response')
    if (!result.messages.length)
      break
    for (const entry of result.messages) {
      if (Date.now() >= deadline || Date.now() - leaseStarted > 9 * 60 * 1000)
        throw new Error('Replay deadline reached; remaining leases are unacknowledged')
      const message = typeof entry.lease_id === 'string' && entry.lease_id ? decodeMessage(entry) : undefined
      if (!message) {
        refused++
        continue
      }
      await api(`/${main.queue_id}/messages`, 'POST', { body: message, content_type: 'json' })
      // A crash after publish and before ack duplicates delivery; canonical IDs dedupe it.
      const ack = await api<{ ackCount: number, warnings?: Record<string, unknown> }>(`/${dlq.queue_id}/messages/ack`, 'POST', {
        acks: [{ lease_id: entry.lease_id }],
        retries: [],
      })
      if (ack.ackCount !== 1 || (ack.warnings && Object.keys(ack.warnings).length))
        throw new Error('DLQ acknowledgement was not confirmed')
      published++
    }
    // Stop after invalid data rather than repeatedly leasing it until retries exhaust.
    if (refused)
      break
  }
  console.log(JSON.stringify({ mode: 'execute', published, refused }))
  return { published, refused }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const environment = queueEnvironment(args[0] ?? '')
    if (args.slice(1).some(arg => arg !== '--execute' && !/^--limit=\d+$/.test(arg)))
      throw new Error('Usage: bun scripts/replay-posthog-dlq.ts <alpha|preprod|prod> [--execute] [--limit=10]')
    const limitArg = args.find(arg => arg.startsWith('--limit='))
    const result = await replayPostHogDlq(createQueueApi(), environment, args.includes('--execute'), limitArg ? Number(limitArg.slice(8)) : 10)
    if (result.refused)
      process.exitCode = 1
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Replay failed; no payload was logged')
    process.exitCode = 1
  }
}
