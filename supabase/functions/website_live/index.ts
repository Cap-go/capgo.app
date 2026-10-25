import { app } from '../_backend/plugin_runtime/plugins/website_live.ts'
import { createAllCatch, createHono } from '../_backend/plugin_runtime/utils/hono.ts'
import { version } from '../_backend/plugin_runtime/utils/version.ts'

const functionName = 'website_live'
const appGlobal = createHono(functionName, version)

appGlobal.route('/', app)
createAllCatch(appGlobal, functionName)
Deno.serve(appGlobal.fetch)
