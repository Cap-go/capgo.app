import type { ExecutionContext, MessageBatch, Queue } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { Bindings, ManifestCleanupQueueMessage } from '../utils/cloudflare.ts'
import { asc, eq } from 'drizzle-orm'
import { BRES, createAllCatch, createHono, middlewareAPISecret, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { manifest } from '../utils/postgres_schema.ts'
import { getEnv } from '../utils/utils.ts'
import { version } from '../utils/version.ts'

export const MANIFEST_CLEANUP_QUEUE_PREFIX = 'capgo-manifest-cleanup-'
const MANIFEST_IDS_PER_MESSAGE = 5
const QUEUE_SEND_BATCH_SIZE = 100
const QUEUE_RETRY_DELAY_SECONDS = 30
const FORWARDED_HEADER = 'x-capgo-manifest-cleanup-forwarded'

function isManifestCleanupQueueMessage(value: unknown): value is ManifestCleanupQueueMessage {
  if (!value || typeof value !== 'object')
    return false
  const message = value as Partial<ManifestCleanupQueueMessage>
  return Number.isInteger(message.versionId)
    && Number(message.versionId) > 0
    && Array.isArray(message.manifestIds)
    && message.manifestIds.length <= MANIFEST_IDS_PER_MESSAGE
    && message.manifestIds.every(id => Number.isInteger(id) && id > 0)
}

function buildManifestCleanupMessages(versionId: number, manifestIds: number[]) {
  if (manifestIds.length === 0)
    return [{ body: { versionId, manifestIds: [] } }]
  const messages: Array<{ body: ManifestCleanupQueueMessage }> = []
  for (let i = 0; i < manifestIds.length; i += MANIFEST_IDS_PER_MESSAGE)
    messages.push({ body: { versionId, manifestIds: manifestIds.slice(i, i + MANIFEST_IDS_PER_MESSAGE) } })
  return messages
}

async function loadManifestIds(c: Context, versionId: number) {
  const pool = getPgClient(c, false)
  try {
    const database = getDrizzleClient(pool)
    const rows = await database
      .select({ id: manifest.id })
      .from(manifest)
      .where(eq(manifest.app_version_id, versionId))
      .orderBy(asc(manifest.id))
    return rows.map(row => row.id)
  }
  finally {
    await closeClient(c, pool)
  }
}

async function enqueueWithBinding(c: Context, versionId: number, queue: Queue<ManifestCleanupQueueMessage>) {
  const manifestIds = await loadManifestIds(c, versionId)
  const messages = buildManifestCleanupMessages(versionId, manifestIds)
  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_SIZE)
    await queue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_SIZE))
  cloudlog({
    requestId: c.get('requestId'),
    message: 'queued manifest cleanup batches',
    versionId,
    manifestRows: manifestIds.length,
    queueMessages: messages.length,
  })
}

async function forwardManifestCleanup(c: Context, versionId: number, cloudflareUrl: string) {
  const response = await fetch(`${cloudflareUrl.replace(/\/$/, '')}/triggers/manifest_cleanup_enqueue`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'apisecret': getEnv(c, 'API_SECRET'),
      [FORWARDED_HEADER]: '1',
    },
    body: JSON.stringify({ versionId }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok)
    throw simpleError('manifest_cleanup_queue_forward_failed', 'Manifest cleanup queue forward failed', { status: response.status })
}

async function processManifestCleanupInline(c: Context, versionId: number) {
  const manifestIds = await loadManifestIds(c, versionId)
  const messages = buildManifestCleanupMessages(versionId, manifestIds)
  const { processManifestCleanupIds } = await import('./on_version_update.ts')
  for (const message of messages)
    await processManifestCleanupIds(c, message.body.versionId, message.body.manifestIds)
}

export async function enqueueManifestCleanup(c: Context, versionId: number) {
  const queue = c.env.MANIFEST_CLEANUP_QUEUE as Queue<ManifestCleanupQueueMessage> | undefined
  if (queue)
    return enqueueWithBinding(c, versionId, queue)

  const cloudflareUrl = getEnv(c, 'CLOUDFLARE_FUNCTION_URL')
  if (cloudflareUrl && c.req.header(FORWARDED_HEADER) !== '1')
    return forwardManifestCleanup(c, versionId, cloudflareUrl)

  // Self-hosted/local Supabase deployments have no Cloudflare Queue. Preserve
  // cleanup correctness there with the same five-row batches, processed serially.
  return processManifestCleanupInline(c, versionId)
}

export const manifestCleanupEnqueueApp = createHono('manifest-cleanup-enqueue', version)
manifestCleanupEnqueueApp.post('/', middlewareAPISecret, async (c) => {
  let body: unknown
  try {
    body = await c.req.json<unknown>()
  }
  catch {
    throw simpleError('invalid_manifest_cleanup_enqueue_request', 'Invalid manifest cleanup enqueue request')
  }
  if (!body || typeof body !== 'object')
    throw simpleError('invalid_manifest_cleanup_enqueue_request', 'Invalid manifest cleanup enqueue request')
  const versionId = (body as { versionId?: unknown }).versionId
  if (!Number.isInteger(versionId) || Number(versionId) <= 0)
    throw simpleError('invalid_manifest_cleanup_enqueue_request', 'Invalid manifest cleanup enqueue request')
  await enqueueManifestCleanup(c, Number(versionId))
  return c.json(BRES)
})
createAllCatch(manifestCleanupEnqueueApp, 'manifest-cleanup-enqueue')

const queueApp = createHono('manifest-cleanup-queue', version)
queueApp.post('/', async (c) => {
  const message = await c.req.json<unknown>()
  if (!isManifestCleanupQueueMessage(message))
    throw simpleError('invalid_manifest_cleanup_message', 'Invalid manifest cleanup queue message')
  const { processManifestCleanupIds } = await import('./on_version_update.ts')
  await processManifestCleanupIds(c, message.versionId, message.manifestIds)
  return c.json(BRES)
})
createAllCatch(queueApp, 'manifest-cleanup-queue')

export function isManifestCleanupQueue(queueName: string) {
  return queueName.startsWith(MANIFEST_CLEANUP_QUEUE_PREFIX)
}

export async function processManifestCleanupQueueBatch(
  batch: MessageBatch<unknown>,
  env: Bindings,
  executionContext: ExecutionContext,
) {
  for (const queueMessage of batch.messages) {
    if (!isManifestCleanupQueueMessage(queueMessage.body)) {
      cloudlog({ message: 'discarding invalid manifest cleanup queue message', queue: batch.queue })
      queueMessage.ack()
      continue
    }

    try {
      const response = await queueApp.fetch(new Request('https://manifest-cleanup-queue.capgo.internal/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-ray': queueMessage.id },
        body: JSON.stringify(queueMessage.body),
      }), env, executionContext)
      if (!response.ok)
        throw new Error(`Manifest cleanup queue handler returned HTTP ${response.status}`)
      queueMessage.ack()
    }
    catch (error) {
      cloudlog({ message: 'manifest cleanup queue message failed', error, queue: batch.queue })
      queueMessage.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
    }
  }
}

export const manifestCleanupQueueTestUtils = {
  buildManifestCleanupMessages,
  isManifestCleanupQueueMessage,
}
