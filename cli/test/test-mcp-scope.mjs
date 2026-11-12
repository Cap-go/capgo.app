import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const packageRoot = process.env.CAPGO_MCP_TEST_PACKAGE_DIR ?? process.cwd()
const sandbox = await mkdtemp(join(tmpdir(), 'capgo-local-mcp-'))
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
}

async function startSession() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(join(sandbox, 'offline.mjs')).href, join(sandbox, 'package/dist/index.js'), 'mcp'],
    cwd: join(sandbox, 'workspace'),
    // Deliberately omit API credentials; no repo or installed skills are available.
    env: { PATH: process.env.PATH ?? '', HOME: sandbox, USERPROFILE: sandbox, CAPGO_DISABLE_TELEMETRY: '1' },
    stderr: 'pipe',
  })
  let nextId = 0
  let stderr = ''
  const pending = new Map()
  transport.onmessage = (message) => {
    if (message.method === 'roots/list') {
      void transport.send({ jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: pathToFileURL(join(sandbox, 'workspace')).href }] } })
    }
    else if (pending.has(message.id)) {
      pending.get(message.id)(message)
    }
  }
  await transport.start()
  transport.stderr?.on('data', chunk => { stderr += chunk.toString() })
  const request = (method, params = {}, modern = false) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out. ${stderr}`))
    }, 10000)
    pending.set(id, (response) => {
      clearTimeout(timer)
      pending.delete(id)
      resolve(response)
    })
    transport.send({ jsonrpc: '2.0', id, method, params: { ...(modern ? { _meta: modernMeta } : {}), ...params } }).catch(reject)
  })
  return { transport, request }
}

async function checkScope(session, modern, app) {
  const rpc = async (method, params = {}) => {
    const response = await session.request(method, params, modern)
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    if (modern)
      assert.equal(response.result.resultType, 'complete')
    return response.result
  }
  // Removed cloud tools must guide clients without a local fallback or proxy.
  for (const name of ['capgo_list_apps', 'capgo_update_channel', 'capgo_observe', 'capgo_get_build_status', 'capgo_search_docs', 'capgo_list_skills', 'capgo_get_skill']) {
    const response = await session.request('tools/call', { name, arguments: {} }, modern)
    assert.ok(response.error || response.result.isError, name)
    const message = response.error?.message ?? response.result.content.map(item => item.text ?? '').join('\n')
    assert.match(message, /https:\/\/api\.capgo\.app\/mcp/, name)
    assert.match(message, /do not blindly replay/, name)
  }
  assert.ok((await session.request('resources/list', {}, modern)).error)
  assert.ok((await session.request('skills/list', {}, modern)).error)
  const selected = await rpc('tools/call', { name: 'capgo_set_project_dir', arguments: { path: app } })
  assert.ok(!selected.isError, JSON.stringify(selected))
  const state = await rpc('tools/call', { name: 'capgo_whoami', arguments: {} })
  assert.ok(!state.isError, JSON.stringify(state))
  const generated = await rpc('tools/call', { name: 'capgo_generate_encryption_keys', arguments: {} })
  assert.ok(!generated.isError, JSON.stringify(generated))
  assert.match(await readFile(join(app, '.capgo_key_v2.pub'), 'utf8'), /PUBLIC KEY/)
}

try {
  await mkdir(join(sandbox, 'package'))
  await mkdir(join(sandbox, 'workspace'))
  await cp(resolve(packageRoot, 'dist'), join(sandbox, 'package/dist'), { recursive: true })
  await copyFile(resolve(packageRoot, 'package.json'), join(sandbox, 'package/package.json'))
  await writeFile(join(sandbox, 'offline.mjs'), "globalThis.fetch = async () => { throw new Error('Offline MCP test') }")
  for (const mode of ['modern', 'legacy', 'discover-then-legacy']) {
    const app = join(sandbox, mode)
    await mkdir(app)
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'example-local-app' }))
    await writeFile(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.local', webDir: 'dist' }))
    const session = await startSession()
    try {
      let connection
      if (mode !== 'legacy') {
        connection = await session.request('server/discover', {}, true)
        assert.equal(connection.error, undefined, JSON.stringify(connection.error))
      }
      if (mode !== 'modern') {
        connection = await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'capgo-scope-test', version: '1.0.0' } })
        assert.equal(connection.error, undefined, JSON.stringify(connection.error))
        assert.equal(connection.result.protocolVersion, '2025-11-25')
        await session.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      }
      assert.match(connection.result.instructions, /https:\/\/api\.capgo\.app\/mcp/)
      assert.match(connection.result.instructions, /authorize it separately/)
      assert.equal(connection.result.capabilities.resources, undefined)
      assert.equal(connection.result.capabilities.extensions?.['io.modelcontextprotocol/skills'], undefined)
      await checkScope(session, mode === 'modern', app)
      console.log(`✅ Packaged local MCP: ${mode}, hosted handoff, no duplicate skills, offline local key generation`)
    }
    finally {
      await session.transport.close()
    }
  }
}
finally {
  await rm(sandbox, { recursive: true, force: true })
}
