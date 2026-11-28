import { readServingPolicy, signServingIngress } from '../../supabase/functions/_backend/plugin_runtime/utils/servingPolicy.ts'
import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types'
import { timingSafeEqual } from 'hono/utils/buffer'
import type { SnippetEdgeStatsEnv } from '../../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'
import { app as channel_self } from '../../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts'
import { app as stats } from '../../supabase/functions/_backend/plugin_runtime/plugins/stats.ts'
import { app as updates } from '../../supabase/functions/_backend/plugin_runtime/plugins/updates.ts'
import { app as cache_purge_local } from '../../supabase/functions/_backend/plugin_runtime/private/cache_purge_local.ts'
import { app as latency } from '../../supabase/functions/_backend/plugin_runtime/private/latency.ts'
import { app as plugin_state_prewarm } from '../../supabase/functions/_backend/plugin_runtime/private/plugin_state_prewarm.ts'
import { app as ok } from '../../supabase/functions/_backend/plugin_runtime/public/ok.ts'
import { BRES, createAllCatch, createHono, quickError, useCors } from '../../supabase/functions/_backend/plugin_runtime/utils/hono.ts'
import { cloudlog } from '../../supabase/functions/_backend/plugin_runtime/utils/logging.ts'
import { startPluginStateReadMetrics } from '../../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts'
import { isPluginStateShared, parsePluginStateShareBps, pluginStateBucket } from '../../supabase/functions/_backend/plugin_runtime/utils/pluginStateSwitch.ts'
import { handleSnippetEdgeStatsMessage, relaySnippetEdgeStatsMessage, SNIPPET_EDGE_STATS_CONSUME_PATH } from '../../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'
import { getEnv } from '../../supabase/functions/_backend/plugin_runtime/utils/utils.ts'
import { version } from '../../supabase/functions/_backend/plugin_runtime/utils/version.ts'

import { servingRegionReaderEpoch } from '../../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js'

const functionName = 'plugin'
const app = createHono(functionName, version)

app.use('*', async (c, next) => {
  const requestSignal = c.req.raw.signal
  if (requestSignal)
    c.set('pluginReadAbortSignal', requestSignal)

  c.set('skipSupabaseStatsFallback', true)
  c.set('skipSupabaseNotificationWrites', true)
  c.set('queuePluginNotifications', true)
  c.set('skipChannelSelfPostgresFallback', true)
  c.set('requireReadReplica', true)
  await next()
})

app.use('*', useCors)

// Once KV is authoritative at 100% every device reads it, so the snippet may
// learn its on-prem / plan answers like database ones (snippet
// canCacheWorkerAnswer). Only pure KV answers: kv-escaped read the database.
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('X-Plugin-State') === 'kv' && isPluginStateShared(c)) {
    try {
      c.res.headers.set('X-Plugin-State-Shared', '1')
    }
    catch {
      // Immutable response: the snippet keeps treating it as a canary answer.
    }
  }
})

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

// Public control metadata only; no app payload/replica/cache access.
app.get('/serving_policy/:appId', async (c) => {
  c.header('Cache-Control', 'no-store')
  if (!servingRegionReaderEpoch)
    return c.json({ app_id: c.req.param('appId'), active: false, phase: 'disabled' })
  try {
    const doc = await readServingPolicy(c, c.req.param('appId'))
    const receipt = c.req.raw.cf?.colo ? await signServingIngress(c, doc.app_id) : undefined
    return c.json({ ...doc, receipt, active: true, epoch: servingRegionReaderEpoch })
  }
  catch {
    return quickError(503, 'serving_policy_unavailable', 'Regional serving policy temporarily unavailable')
  }
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
// API-secret protected: warms this region's plugin state cache after a publication.
app.route('/plugin_state/prewarm', plugin_state_prewarm)
// Local-only purge-by-tag emulation for the /updates edge cache.
app.route('/cache_purge_local', cache_purge_local)
// API-secret protected: a snippet edge stats queue message relayed by queue()
// below, so it runs in this worker's placement data center.
app.post(SNIPPET_EDGE_STATS_CONSUME_PATH, async (c) => {
  const secret = getEnv(c, 'API_SECRET')
  const provided = c.req.header('apisecret')
  if (!secret || !provided || !await timingSafeEqual(provided, secret))
    throw quickError(401, 'invalid_api_secret', 'Invalid API secret')
  const payload: unknown = await c.req.raw.clone().json().catch(() => null)
  const id = payload && typeof payload === 'object' ? (payload as { id?: unknown }).id : undefined
  if (typeof id !== 'string' || !id)
    throw quickError(400, 'invalid_body', 'Expected a relayed queue message')
  // c.executionCtx throws when the runtime passed no context.
  const ctx = (() => {
    try {
      return c.executionCtx
    }
    catch {
      return undefined
    }
  })()
  // A throw answers 5xx, so the relaying queue handler retries the message.
  await handleSnippetEdgeStatsMessage(c.env, id, (payload as { body?: unknown }).body, request => app.fetch(request, c.env, ctx))
  return c.json(BRES)
})

createAllCatch(app, functionName)

/**
 * Placement only moves fetch handlers, so a queue invocation runs away from
 * the replica the replays read. With the PLACED_SELF binding each message runs
 * in the placed fetch handler instead; without it (local), in process. Batches
 * stay small: one invocation may call at most 32 workers through bindings.
 */
async function queue(batch: MessageBatch<unknown>, env: SnippetEdgeStatsEnv, ctx: ExecutionContext) {
  for (const message of batch.messages) {
    try {
      if (env.PLACED_SELF)
        await relaySnippetEdgeStatsMessage(env, message.id, message.body)
      else
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
