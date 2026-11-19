import { app as files } from '../_backend/files/files.ts'
import { handlePreviewSubdomain, isPreviewSubdomain } from '../_backend/files/preview.ts'

import { createAllCatch, createHono } from '../_backend/utils/hono.ts'
import { version } from '../_backend/utils/version.ts'

const functionName = 'files'
const appGlobal = createHono(functionName, version)

// Middleware to route preview subdomain requests
appGlobal.use('/*', async (c, next) => {
  const hostname = c.req.header('host') || ''
  if (isPreviewSubdomain(hostname)) {
    // Handle preview requests directly within this context
    return handlePreviewSubdomain(c)
  }
  return next()
})
appGlobal.route('/', files)
createAllCatch(appGlobal, functionName)
Deno.serve(appGlobal.fetch)
