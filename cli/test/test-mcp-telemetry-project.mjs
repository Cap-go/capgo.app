import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const bundlePath = resolve('dist/index.js')
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-mcp-telemetry-')))
const home = join(fixture, 'home')
const launch = join(fixture, 'launch')
const first = join(fixture, 'first')
const second = join(fixture, 'second')
const projectKey = 'example-project-telemetry-key'
const notifications = new EventEmitter()
const requests = []
let blockedEvents
const withTimeout = promise => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('MCP operation timed out')), 5000).unref()),
])
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request)
    body += chunk.toString()
  const payload = body ? JSON.parse(body) : undefined
  const record = { path: request.url, apikey: request.headers.capgkey, payload }
  requests.push(record)
  response.setHeader('Content-Type', 'application/json')
  if (request.url.endsWith('/private/events')) {
    if (payload.event === 'MCP Tool Invoked')
      notifications.emit(payload.tags.tool_name, record)
    if (blockedEvents)
      await blockedEvents
    response.end('{}')
  }
  else if (request.url.endsWith('/private/cli/identity')) {
    response.end(JSON.stringify({ userId: '00000000-0000-0000-0000-000000000001' }))
  }
  else if (request.url.includes('/app/')) {
    response.end(JSON.stringify({ owner_org: '00000000-0000-0000-0000-000000000002' }))
  }
  else {
    response.end('{}')
  }
})

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  for (const directory of [home, launch, first, second])
    mkdirSync(directory, { recursive: true })
  for (const [directory, name] of [[launch, 'launch'], [first, 'first'], [second, 'second']]) {
    writeFileSync(join(directory, 'capacitor.config.json'), JSON.stringify({
      appId: 'com.example.telemetry.' + name,
      webDir: 'dist',
      plugins: { CapacitorUpdater: { localApi: baseUrl + '/' + name } },
    }))
  }
  for (const directory of [first, second])
    writeFileSync(join(directory, '.capgo'), projectKey)
  writeFileSync(join(first, '.capgo_key_v2.pub'), 'example-existing-public-key')

  for (const launchKey of ['example-launch-telemetry-key', undefined]) {
    if (launchKey)
      writeFileSync(join(launch, '.capgo'), launchKey)
    else
      rmSync(join(launch, '.capgo'), { force: true })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundlePath, 'mcp'],
      cwd: launch,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CAPGO_TOKEN: '',
        CAPGO_API_HOST: '',
        CAPGO_FILES_HOST: '',
        CAPGO_DISABLE_TELEMETRY: '0',
        CAPGO_DISABLE_POSTHOG: '0',
      },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'capgo-mcp-telemetry-test', version: '0.0.0' }, { capabilities: { roots: {} } })
    client.setRequestHandler('roots/list', () => ({ roots: [{ uri: pathToFileURL(first).href }] }))
    try {
      await withTimeout(client.connect(transport))
      for (const [directory, name] of [[first, 'first'], [second, 'second'], [first, 'first']]) {
        const event = once(notifications, 'capgo_whoami', { signal: AbortSignal.timeout(5000) })
        const result = await withTimeout(client.callTool({ name: 'capgo_whoami', arguments: { cwd: directory } }))
        const [record] = await event
        assert.ok(!result.isError, JSON.stringify(result))
        assert.ok(result.content[0].text.includes('using the local key'), JSON.stringify(result))
        assert.equal(record.apikey, projectKey, 'telemetry must use the selected app key, not a launch-directory key')
        assert.equal(record.path, '/' + name + '/private/events', 'telemetry must keep the selected app API host')
        assert.equal(record.payload.tags.app_id, 'com.example.telemetry.' + name, 'one key must not reuse another app context')
        assert.equal(record.payload.tags.success, true)
        assert.ok(requests.some(request => request.path === '/' + name + '/private/cli/identity' && request.apikey === projectKey))
      }
      for (const name of ['second', 'first']) {
        const event = once(notifications, 'capgo_set_project_dir', { signal: AbortSignal.timeout(5000) })
        const result = await withTimeout(client.callTool({ name: 'capgo_set_project_dir', arguments: { path: '../' + name } }))
        const [record] = await event
        assert.ok(!result.isError, JSON.stringify(result))
        assert.equal(record.apikey, projectKey)
        assert.equal(record.path, '/' + name + '/private/events')
        assert.equal(record.payload.tags.app_id, 'com.example.telemetry.' + name)
      }
      const errorEvent = once(notifications, 'capgo_generate_encryption_keys', { signal: AbortSignal.timeout(5000) })
      const errorResult = await withTimeout(client.callTool({ name: 'capgo_generate_encryption_keys', arguments: {} }))
      const [errorRecord] = await errorEvent
      assert.equal(errorResult.isError, true)
      assert.equal(errorRecord.apikey, projectKey)
      assert.equal(errorRecord.path, '/first/private/events')
      assert.equal(errorRecord.payload.tags.app_id, 'com.example.telemetry.first')
      assert.equal(errorRecord.payload.tags.success, false)

      let releaseEvent
      blockedEvents = new Promise(resolve => { releaseEvent = resolve })
      try {
        const event = once(notifications, 'capgo_whoami', { signal: AbortSignal.timeout(5000) })
        const result = await withTimeout(client.callTool({ name: 'capgo_whoami', arguments: {} }))
        const [record] = await event
        assert.ok(!result.isError, JSON.stringify(result))
        assert.equal(record.apikey, projectKey, 'tool returns without awaiting the telemetry HTTP response')
      }
      finally {
        releaseEvent()
        blockedEvents = undefined
      }
    }
    finally {
      await client.close()
    }
  }
  console.log('✅ MCP telemetry keeps project-local credentials, app context, and API hosts across project switches and errors')
}
finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}
