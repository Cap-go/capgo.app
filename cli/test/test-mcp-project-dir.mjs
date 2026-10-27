#!/usr/bin/env node
// A user-scoped MCP install is spawned from the client's dir (often ~ or /), not the
// agent's workspace. The server must follow the client's MCP roots, and
// capgo_set_project_dir must let the agent point it at the project explicitly.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

console.log('🧪 Testing MCP project directory resolution...\n')

const { pickProjectDirFromRoots, resolveProjectDirInput } = await import('../src/mcp/project-dir.ts')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`) }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-mcp-project-dir-')))
const spawnDir = join(tmp, 'home')
const workspace = join(tmp, 'workspace')
const app = join(workspace, 'apps', 'mobile')
const other = join(tmp, 'other-app')
for (const dir of [spawnDir, app, other])
  mkdirSync(dir, { recursive: true })
writeFileSync(join(workspace, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.workspace', appName: 'ws', webDir: 'dist' }))
writeFileSync(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.mobile', appName: 'mobile', webDir: 'dist' }))
writeFileSync(join(other, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.other', appName: 'other', webDir: 'dist' }))
const fileRoot = dir => ({ uri: pathToFileURL(dir).href })

await test('pickProjectDirFromRoots prefers a root with a Capacitor config', async () => {
  const empty = join(tmp, 'empty-root')
  mkdirSync(empty, { recursive: true })
  eq(pickProjectDirFromRoots([fileRoot(empty), fileRoot(workspace)], spawnDir), workspace)
})

await test('pickProjectDirFromRoots keeps a Capacitor cwd inside a root', async () => {
  eq(pickProjectDirFromRoots([fileRoot(workspace)], app), app)
})

await test('pickProjectDirFromRoots falls back to the first root and ignores non-file roots', async () => {
  eq(pickProjectDirFromRoots([{ uri: 'https://example.com' }, fileRoot(spawnDir)], tmp), spawnDir)
  eq(pickProjectDirFromRoots([{ uri: 'https://example.com' }], tmp), undefined)
  eq(pickProjectDirFromRoots([fileRoot(join(tmp, 'missing'))], tmp), undefined)
})

await test('resolveProjectDirInput resolves relative paths and rejects missing dirs', async () => {
  eq(resolveProjectDirInput('apps/mobile', workspace), app)
  eq(resolveProjectDirInput(pathToFileURL(app).href, tmp), app)
  let threw = false
  try { resolveProjectDirInput(join(tmp, 'nope'), tmp) }
  catch { threw = true }
  ok(threw, 'missing dir should throw')
})

const bundlePath = join(process.cwd(), 'dist', 'index.js')
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref()),
])

function toolText(result) {
  return (result?.content ?? []).map(c => c.text ?? '').join('\n')
}

async function withServer(roots, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundlePath, 'mcp'],
    cwd: spawnDir,
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: '1' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'capgo-mcp-project-dir-test', version: '0.0.0' }, roots ? { capabilities: { roots: { listChanged: true } } } : undefined)
  let currentRoots = roots
  if (roots)
    client.setRequestHandler('roots/list', () => ({ roots: currentRoots }))
  try {
    await withTimeout(client.connect(transport), 10000, 'MCP connect')
    await fn(client, (next) => { currentRoots = next })
  }
  finally {
    await client.close().catch(() => {})
  }
}

const currentDir = async client => toolText(await withTimeout(client.callTool({ name: 'capgo_set_project_dir', arguments: { path: '.' } }), 10000, 'capgo_set_project_dir'))

if (!existsSync(bundlePath)) {
  console.error('\n❌ dist/index.js not found. Run "bun run build" first.')
  fail++
}
else {
  await test('server follows the client roots instead of its spawn dir', async () => {
    await withServer([fileRoot(workspace)], async (client) => {
      const text = await currentDir(client)
      ok(text.includes(`project directory: ${workspace} `), text)
    })
  })

  await test('server follows roots/list_changed', async () => {
    await withServer([fileRoot(workspace)], async (client, setRoots) => {
      setRoots([fileRoot(other)])
      await client.sendRootsListChanged()
      // stdio is ordered: the server handles the notification before this call, and every
      // tool awaits the resulting roots sync.
      const text = await currentDir(client)
      ok(text.includes(`project directory: ${other} `), text)
    })
  })

  await test('without roots, capgo_set_project_dir moves the server to the agent project', async () => {
    await withServer(undefined, async (client) => {
      const before = await currentDir(client)
      ok(before.includes(`project directory: ${spawnDir} `), before)
      ok(before.includes('no capacitor.config'), before)
      const set = toolText(await client.callTool({ name: 'capgo_set_project_dir', arguments: { path: app } }))
      ok(set.includes(`project directory: ${app} (Capacitor config found)`), set)
      const missing = await client.callTool({ name: 'capgo_set_project_dir', arguments: { path: join(tmp, 'nope') } })
      ok(missing.isError, 'missing dir should be an error')
      ok((await currentDir(client)).includes(`project directory: ${app} `), 'dir should stay on the last valid project')
    })
  })
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
