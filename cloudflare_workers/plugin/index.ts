import type { ExecutionContext, MessageBatch, Queue, R2Bucket } from '@cloudflare/workers-types'
import { app as channel_self } from '../../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts'
import { app as stats } from '../../supabase/functions/_backend/plugin_runtime/plugins/stats.ts'
import { app as updates } from '../../supabase/functions/_backend/plugin_runtime/plugins/updates.ts'
import { app as cache_purge_local } from '../../supabase/functions/_backend/plugin_runtime/private/cache_purge_local.ts'
import { app as latency } from '../../supabase/functions/_backend/plugin_runtime/private/latency.ts'
import { app as ok } from '../../supabase/functions/_backend/plugin_runtime/public/ok.ts'
import { createAllCatch, createHono, useCors } from '../../supabase/functions/_backend/plugin_runtime/utils/hono.ts'
import { cloudlog } from '../../supabase/functions/_backend/plugin_runtime/utils/logging.ts'
import { chunkSnippetEdgeRecords, getR2NotificationObjectKey, groupForSendBatch, isSnippetEdgeReplayMessage, readLogpushRecords, replaySnippetEdgeRecords } from '../../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'
import { version } from '../../supabase/functions/_backend/plugin_runtime/utils/version.ts'

const functionName = 'plugin'
const app = createHono(functionName, version)

app.use('*', async (c, next) => {
  c.set('skipSupabaseStatsFallback', true)
  c.set('skipSupabaseNotificationWrites', true)
  c.set('queuePluginNotifications', true)
  c.set('skipChannelSelfPostgresFallback', true)
  c.set('requireReadReplica', true)
  await next()
})

app.use('*', useCors)

// TODO: deprecated remove when everyone use the new endpoint
app.route('/plugin/ok', ok)
app.route('/plugin/channel_self', channel_self)
app.route('/plugin/updates', updates)
app.route('/plugin/stats', stats)

// Plugin API
app.route('/channel_self', channel_self)
app.route('/updates', updates)
app.route('/stats', stats)
app.route('/ok', ok)
app.route('/latency', latency)
// Local-only purge-by-tag emulation for the /updates edge cache.
app.route('/cache_purge_local', cache_purge_local)

createAllCatch(app, functionName)

interface SnippetEdgeStatsEnv {
  SNIPPET_EDGE_STATS_LOGS?: R2Bucket
  SNIPPET_EDGE_STATS_REPLAY?: Queue
}

/** Logpush file -> replay messages (see snippetEdgeReplay.ts). */
async function enqueueSnippetEdgeStatsFile(env: SnippetEdgeStatsEnv, key: string) {
  if (!env.SNIPPET_EDGE_STATS_LOGS || !env.SNIPPET_EDGE_STATS_REPLAY)
    throw new Error('Snippet edge stats bindings are missing')
  const object = await env.SNIPPET_EDGE_STATS_LOGS.get(key)
  if (!object)
    return { records: 0, chunks: 0, invalid: 0 }
  const records = []
  const stats = { invalid: 0 }
  for await (const record of readLogpushRecords(object.body as unknown as ReadableStream<Uint8Array>, key.endsWith('.gz'), stats))
    records.push(record)
  const chunks = chunkSnippetEdgeRecords(records)
  for (const group of groupForSendBatch(chunks))
    await env.SNIPPET_EDGE_STATS_REPLAY.sendBatch(group.map(chunk => ({ body: { snippetEdgeStats: chunk } })))
  return { records: records.length, chunks: chunks.length, invalid: stats.invalid }
}

async function queue(batch: MessageBatch<unknown>, env: SnippetEdgeStatsEnv, ctx: ExecutionContext) {
  for (const message of batch.messages) {
    try {
      if (isSnippetEdgeReplayMessage(message.body)) {
        const result = await replaySnippetEdgeRecords(message.body.snippetEdgeStats, request => app.fetch(request, env, ctx))
        if (result.failed > 0)
          cloudlog({ requestId: message.id, message: 'snippet edge stats replay failures', ...result })
        message.ack()
        continue
      }
      const key = getR2NotificationObjectKey(message.body)
      if (key) {
        const result = await enqueueSnippetEdgeStatsFile(env, key)
        cloudlog({ requestId: message.id, message: 'snippet edge stats file queued', key, ...result })
      }
      message.ack()
    }
    catch (error) {
      cloudlog({ requestId: message.id, message: 'snippet edge stats queue error', error })
      message.retry()
    }
  }
}

export default {
  fetch: app.fetch,
  queue,
}
