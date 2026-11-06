#!/usr/bin/env node
import assert from 'node:assert/strict'
import { flushAnalytics, setInvocationSource, withMcpToolTracking } from '../src/analytics/track.ts'

console.log('🧪 Testing MCP tool tracking...\n')

const originalFetch = globalThis.fetch
const originalDisable = process.env.CAPGO_DISABLE_TELEMETRY
const originalDisablePosthog = process.env.CAPGO_DISABLE_POSTHOG
const originalToken = process.env.CAPGO_TOKEN

function stubFetch() {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ init, url: String(url) })
    if (String(url).endsWith('/private/config'))
      return new Response('', { status: 500 })
    return new Response('{}', { headers: { 'Content-Type': 'application/json' }, status: 200 })
  }
  return requests
}
const findEvent = requests => requests.find(r => r.url.endsWith('/private/events'))

try {
  delete process.env.CAPGO_DISABLE_TELEMETRY
  delete process.env.CAPGO_DISABLE_POSTHOG
  process.env.CAPGO_TOKEN = 'mcp-key'
  setInvocationSource('mcp')

  // success path
  let requests = stubFetch()
  const okHandler = withMcpToolTracking('capgo_list_apps', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  const okResult = await okHandler({})
  await flushAnalytics()
  assert.equal(okResult.content[0].text, 'ok', 'wrapper returns the original result')
  let body = JSON.parse(findEvent(requests).init.body)
  assert.equal(body.event, 'MCP Tool Invoked')
  assert.equal(body.channel, 'mcp')
  assert.equal(body.tags.tool_name, 'capgo_list_apps')
  assert.equal(body.tags.success, true)
  assert.equal(body.nonPersonTags.invocation_source, 'mcp')
  assert.equal(typeof body.tags.duration_ms, 'number')
  assert.equal('error_category' in body.tags, false, 'no category on success')

  // isError result path
  requests = stubFetch()
  const errHandler = withMcpToolTracking('capgo_add_app', async () => ({ content: [{ type: 'text', text: 'bad' }], isError: true }))
  await errHandler({})
  await flushAnalytics()
  body = JSON.parse(findEvent(requests).init.body)
  assert.equal(body.tags.success, false, 'isError result => success:false')
  assert.equal(body.tags.error_category, 'unknown', 'isError result carries a category, never the text')
  assert.equal(JSON.stringify(body).includes('bad'), false, 'error text is not sent')

  // categorized isError result path
  requests = stubFetch()
  const noKeyHandler = withMcpToolTracking('capgo_list_apps', async () => ({ content: [{ type: 'text', text: 'No Capgo API key found. Run `npx @capgo/cli@latest login` first.' }], isError: true }))
  await noKeyHandler({})
  await flushAnalytics()
  body = JSON.parse(findEvent(requests).init.body)
  assert.equal(body.tags.error_category, 'missing_apikey')

  // thrown-error path
  requests = stubFetch()
  const throwHandler = withMcpToolTracking('capgo_upload_bundle', async () => { throw new Error('boom') })
  await assert.rejects(() => throwHandler({}), /boom/, 'wrapper rethrows')
  await flushAnalytics()
  body = JSON.parse(findEvent(requests).init.body)
  assert.equal(body.tags.success, false)
  assert.equal(body.tags.error_category, 'unknown')

  console.log('✅ MCP tool tracking tests passed')
}
finally {
  globalThis.fetch = originalFetch
  setInvocationSource('cli')
  if (originalDisable === undefined)
    delete process.env.CAPGO_DISABLE_TELEMETRY
  else process.env.CAPGO_DISABLE_TELEMETRY = originalDisable
  if (originalDisablePosthog === undefined)
    delete process.env.CAPGO_DISABLE_POSTHOG
  else process.env.CAPGO_DISABLE_POSTHOG = originalDisablePosthog
  if (originalToken === undefined)
    delete process.env.CAPGO_TOKEN
  else process.env.CAPGO_TOKEN = originalToken
}
