import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types'
import type { SnippetEdgeStatsEnv } from '../../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'
import { app as channel_self } from '../../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts'
import { app as stats } from '../../supabase/functions/_backend/plugin_runtime/plugins/stats.ts'
import { app as updates } from '../../supabase/functions/_backend/plugin_runtime/plugins/updates.ts'
import { app as cache_purge_local } from '../../supabase/functions/_backend/plugin_runtime/private/cache_purge_local.ts'
import { app as latency } from '../../supabase/functions/_backend/plugin_runtime/private/latency.ts'
import { app as ok } from '../../supabase/functions/_backend/plugin_runtime/public/ok.ts'
import { createAllCatch, createHono, useCors } from '../../supabase/functions/_backend/plugin_runtime/utils/hono.ts'
import { cloudlog } from '../../supabase/functions/_backend/plugin_runtime/utils/logging.ts'
import { startPluginStateReadMetrics } from '../../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts'
import { parsePluginStateShareBps, pluginStateBucket } from '../../supabase/functions/_backend/plugin_runtime/utils/pluginStateSwitch.ts'
import { handleSnippetEdgeStatsMessage } from '../../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'
import { getEnv } from '../../supabase/functions/_backend/plugin_runtime/utils/utils.ts'
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

// Sample both read paths during rollout. This measures Worker wall time;
// external probes measure device-to-edge latency and release propagation.
app.use('*', async (c, next) => {
  const share = parsePluginStateShareBps(getEnv(c, 'PLUGIN_STATE_TIMING'))
  if (share === 0 || pluginStateBucket('timing', c.get('requestId')) >= share) {
    await next()
    return
  }
  const startedAt = performance.now()
  const reads = startPluginStateReadMetrics(c)
  await next()
  cloudlog({
    requestId: c.get('requestId'),
    message: 'plugin_state_request_timing',
    path: c.req.path,
    method: c.req.method,
    source: c.res.headers.get('X-Plugin-State') ?? 'db-or-prevalidation',
    status: c.res.status,
    duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    colo: c.req.raw.cf?.colo ?? null,
    sample_bps: share,
    ...reads,
  })
})

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

async function queue(batch: MessageBatch<unknown>, env: SnippetEdgeStatsEnv, ctx: ExecutionContext) {
  for (const message of batch.messages) {
    try {
      await handleSnippetEdgeStatsMessage(env, message.id, message.body, request => app.fetch(request, env, ctx))
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
