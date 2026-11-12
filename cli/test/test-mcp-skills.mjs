import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const catalog = JSON.parse(await readFile(new URL('../src/mcp/skills.generated.json', import.meta.url), 'utf8'))
const packageRoot = process.env.CAPGO_MCP_TEST_PACKAGE_DIR ?? process.cwd()
const sandbox = await mkdtemp(join(tmpdir(), 'capgo-cli-mcp-skills-'))
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
  let rootsRead = false
  transport.onmessage = (message) => {
    if (message.method === 'roots/list') {
      rootsRead = true
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
  return { transport, request, rootsRead: () => rootsRead }
}

async function checkCatalog(session, modern) {
  const rpc = async (method, params = {}) => {
    const response = await session.request(method, params, modern)
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    if (modern)
      assert.equal(response.result.resultType, 'complete')
    return response.result
  }
  const tools = (await rpc('tools/list')).tools
  for (const name of ['capgo_list_skills', 'capgo_get_skill']) {
    const tool = tools.find(tool => tool.name === name)
    assert.ok(tool?.outputSchema)
    assert.equal(tool.annotations.readOnlyHint, true)
    assert.equal(tool.annotations.openWorldHint, false)
    assert.equal(tool.inputSchema.properties.projectDir, undefined)
  }
  const listed = await rpc('tools/call', { name: 'capgo_list_skills', arguments: {} })
  assert.equal(listed.isError, undefined)
  assert.deepEqual(listed.structuredContent.skills, catalog.skills)
  assert.deepEqual(JSON.parse(listed.content[0].text), listed.structuredContent)
  const resources = (await rpc('resources/list')).resources
  assert.deepEqual(resources.map(resource => resource.uri), catalog.skills.map(skill => skill.uri))
  if (modern)
    assert.deepEqual((await rpc('skills/list')).skills, catalog.skills)

  for (const skill of catalog.skills) {
    if (modern)
      assert.deepEqual((await rpc('skills/get', { uri: skill.uri })).skill, skill)
    const guide = await rpc('tools/call', { name: 'capgo_get_skill', arguments: { uri: skill.uri } })
    assert.equal(guide.isError, undefined)
    assert.deepEqual(guide.structuredContent.skill, skill)
    assert.equal(guide.structuredContent.contents[0].uri, skill.uri)
    for (const file of skill.resources) {
      const contents = (await rpc('resources/read', { uri: file.uri })).contents
      assert.deepEqual(contents, [catalog.contents.find(content => content.uri === file.uri)])
      const bytes = contents[0].text !== undefined ? Buffer.from(contents[0].text) : Buffer.from(contents[0].blob, 'base64')
      assert.equal(bytes.length, file.size)
      assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.digest)
      const tool = await rpc('tools/call', { name: 'capgo_get_skill', arguments: { uri: skill.uri, resourceUri: file.uri } })
      assert.deepEqual(tool.structuredContent.contents, contents)
    }
  }

  for (const uri of ['file:///etc/passwd', 'https://example.com/SKILL.md', 'skill://capgo/ship-live-update/../usage/SKILL.md', 'skill://capgo/%2e%2e/SKILL.md', '__proto__']) {
    assert.ok((await session.request('resources/read', { uri }, modern)).error)
    if (modern)
      assert.equal((await session.request('skills/get', { uri }, true)).error.code, -32602)
    assert.equal((await rpc('tools/call', { name: 'capgo_get_skill', arguments: { uri } })).isError, true)
  }
  const crossSkill = await rpc('tools/call', { name: 'capgo_get_skill', arguments: { uri: catalog.skills[0].uri, resourceUri: catalog.skills[1].uri } })
  assert.equal(crossSkill.isError, true)
  if (modern)
    assert.equal((await session.request('skills/list', { cursor: 'invalid' }, true)).error.code, -32602)
}

try {
  await mkdir(join(sandbox, 'package'))
  await cp(resolve(packageRoot, 'dist'), join(sandbox, 'package/dist'), { recursive: true })
  await copyFile(resolve(packageRoot, 'package.json'), join(sandbox, 'package/package.json'))
  await writeFile(join(sandbox, 'offline.mjs'), "globalThis.fetch = async () => { throw new Error('Offline MCP test') }")
  // An ambiguous workspace must not block public skill reads or evaluate its configs.
  await mkdir(join(sandbox, 'workspace'))
  await writeFile(join(sandbox, 'workspace/package.json'), JSON.stringify({ private: true, workspaces: ['app-one', 'app-two'] }))
  for (const name of ['app-one', 'app-two']) {
    const app = join(sandbox, 'workspace', name)
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'package.json'), JSON.stringify({ dependencies: { '@capacitor/core': '^8.0.0' } }))
    await writeFile(join(app, 'capacitor.config.ts'), "throw new Error('Public skills must not load project configuration')")
  }
  for (const mode of ['modern', 'legacy', 'discover-then-legacy']) {
    const session = await startSession()
    try {
      if (mode !== 'legacy') {
        const discovery = await session.request('server/discover', {}, true)
        assert.equal(discovery.error, undefined, JSON.stringify(discovery.error))
        assert.ok(discovery.result.capabilities.extensions['io.modelcontextprotocol/skills'])
        assert.ok(discovery.result.capabilities.resources)
      }
      if (mode !== 'modern') {
        const init = await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'capgo-skills-test', version: '1.0.0' } })
        assert.equal(init.error, undefined, JSON.stringify(init.error))
        assert.equal(init.result.protocolVersion, '2025-11-25')
        assert.ok(init.result.capabilities.resources)
        await session.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      }
      await checkCatalog(session, mode === 'modern')
      if (mode === 'modern') {
        const ambiguous = await session.request('tools/call', { name: 'capgo_list_apps', arguments: {} }, true)
        assert.equal(ambiguous.result.isError, true)
        assert.match(ambiguous.result.content[0].text, /Multiple Capacitor apps/)
        const selected = await session.request('tools/call', { name: 'capgo_set_project_dir', arguments: { path: join(sandbox, 'workspace/app-one') } }, true)
        assert.equal(selected.result.isError, undefined)
        assert.match(selected.result.content[0].text, /app-one/)
      }
      if (mode !== 'modern') {
        assert.ok(session.rootsRead(), 'Legacy project roots must still be requested')
        assert.equal((await session.request('skills/list')).error.code, -32601)
      }
      console.log(`✅ Packaged MCP skills: ${mode}, exact bytes and digests, no login, safe URI reads`)
    }
    finally {
      await session.transport.close()
    }
  }
}
finally {
  await rm(sandbox, { recursive: true, force: true })
}
