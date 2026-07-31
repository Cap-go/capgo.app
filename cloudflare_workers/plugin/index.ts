import { app as channel_self } from '../../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts'
import { app as stats } from '../../supabase/functions/_backend/plugin_runtime/plugins/stats.ts'
import { app as updates } from '../../supabase/functions/_backend/plugin_runtime/plugins/updates.ts'
import { app as latency } from '../../supabase/functions/_backend/plugin_runtime/private/latency.ts'
import { app as ok } from '../../supabase/functions/_backend/plugin_runtime/public/ok.ts'
import { createAllCatch, createHono, useCors } from '../../supabase/functions/_backend/plugin_runtime/utils/hono.ts'
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

createAllCatch(app, functionName)

export default {
  fetch: app.fetch,
}
