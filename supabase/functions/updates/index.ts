import { app } from '../_backend/plugin_runtime/plugins/updates.ts'
import { createAllCatch, createHono, useCors } from '../_backend/plugin_runtime/utils/hono.ts'
import { version } from '../_backend/plugin_runtime/utils/version.ts'
import { registerPluginStatsSbFallbacksForDeno } from '../shared/plugin_deno_stats_fallbacks.ts'

registerPluginStatsSbFallbacksForDeno()

const functionName = 'updates'
const appGlobal = createHono(functionName, version)

appGlobal.use('*', useCors)
appGlobal.route('/', app)
createAllCatch(appGlobal, functionName)
Deno.serve(appGlobal.fetch)
