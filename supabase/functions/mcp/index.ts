import { app } from '../_backend/public/mcp/index.ts'
import { rewriteSupabaseMcpUrl } from '../_backend/public/mcp/protocol.ts'
import { createAllCatch, createHono } from '../_backend/utils/hono.ts'
import { version } from '../_backend/utils/version.ts'

const functionName = 'mcp'
const appGlobal = createHono(functionName, version)

appGlobal.all('*', (c) => {
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-capgo-mcp-public-url', c.req.url)
  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return app.fetch(new Request(rewriteSupabaseMcpUrl(c.req.url), {
    method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
  }), c.env)
})

createAllCatch(appGlobal, functionName)
Deno.serve(appGlobal.fetch)
