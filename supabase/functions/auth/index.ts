import { app as register } from '../_backend/auth/register.ts'
import { createAllCatch, createHono } from '../_backend/utils/hono.ts'
import { version } from '../_backend/utils/version.ts'

const functionName = 'auth'
const appGlobal = createHono(functionName, version)

appGlobal.route('/register', register)
createAllCatch(appGlobal, functionName)
Deno.serve(appGlobal.fetch)
