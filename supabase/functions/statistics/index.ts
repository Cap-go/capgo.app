import { consoleSessionMiddleware } from '../_backend/utils/console_auth.ts'
import { app } from '../_backend/public/statistics/index.ts'
import { createAllCatch, createHono } from '../_backend/utils/hono.ts'
import { version } from '../_backend/utils/version.ts'

const functionName = 'statistics'
const appGlobal = createHono(functionName, version)

appGlobal.use('*', consoleSessionMiddleware)
appGlobal.route('/', app)
createAllCatch(appGlobal, functionName)
Deno.serve(appGlobal.fetch)
