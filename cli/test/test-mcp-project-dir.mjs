#!/usr/bin/env node
// A user-scoped MCP install is spawned from the client's dir (often ~ or /), not the
// agent's workspace. The server must follow the client's MCP roots, and
// capgo_set_project_dir must let the agent point it at the project explicitly.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const monorepo = join(tmp, 'monorepo')
const mobile = join(monorepo, 'apps', 'mobile')
for (const dir of [spawnDir, app, other, mobile])
  mkdirSync(dir, { recursive: true })
writeFileSync(join(workspace, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.workspace', appName: 'ws', webDir: 'dist' }))
writeFileSync(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.mobile', appName: 'mobile', webDir: 'dist' }))
writeFileSync(join(other, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.other', appName: 'other', webDir: 'dist' }))
writeFileSync(join(monorepo, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }))
writeFileSync(join(mobile, 'package.json'), JSON.stringify({ name: 'example-mobile', dependencies: { '@capacitor/core': '^8.0.0' } }))
writeFileSync(join(mobile, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.mobile', appName: 'mobile', webDir: 'dist' }))
const fileRoot = dir => ({ uri: pathToFileURL(dir).href })
const multiple = join(tmp, 'multiple-apps')
const multipleApps = ['first', 'second'].map(name => join(multiple, 'apps', name))
const pnpmWorkspace = join(tmp, 'pnpm-workspace')
const pnpmApp = join(pnpmWorkspace, 'clients', 'native')
mkdirSync(pnpmApp, { recursive: true })
writeFileSync(join(pnpmWorkspace, 'package.json'), JSON.stringify({ private: true }))
writeFileSync(join(pnpmWorkspace, 'pnpm-workspace.yaml'), 'packages:\n  - clients/*\n')
writeFileSync(join(pnpmApp, 'package.json'), JSON.stringify({ name: 'example-native' }))
writeFileSync(join(pnpmApp, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.native', webDir: 'dist' }))
for (const dir of multipleApps) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: dir.endsWith('first') ? 'example-first' : 'example-second' }))
  writeFileSync(join(dir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.app', webDir: 'dist' }))
}
writeFileSync(join(multiple, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }))

await test('workspace roots resolve the nested app whose package declares Capacitor', async () => {
  eq(await pickProjectDirFromRoots([fileRoot(monorepo)], spawnDir), mobile)
})

await test('setting a workspace directory resolves its only Capacitor app', async () => {
  eq(await resolveProjectDirInput(monorepo, spawnDir), mobile)
})

await test('pnpm workspace YAML discovers apps without package.json workspaces', async () => {
  eq(await pickProjectDirFromRoots([fileRoot(pnpmWorkspace)], spawnDir), pnpmApp)
  eq(await resolveProjectDirInput(pnpmWorkspace, spawnDir), pnpmApp)
})

await test('multiple apps are not silently selected and explicit resolution lists their paths', async () => {
  let rootsError
  try { await pickProjectDirFromRoots([fileRoot(multiple)], spawnDir) }
  catch (caught) { rootsError = caught }
  for (const dir of multipleApps)
    ok(rootsError?.message.includes(dir), rootsError?.message)
  eq(await pickProjectDirFromRoots([fileRoot(multiple)], multipleApps[1]), multipleApps[1])
  let error
  try { await resolveProjectDirInput(multiple, spawnDir) }
  catch (caught) { error = caught }
  ok(error?.message.includes('Multiple Capacitor apps'), error?.message)
  for (const dir of multipleApps)
    ok(error.message.includes(dir), error.message)
})

await test('pickProjectDirFromRoots prefers a root with a Capacitor config', async () => {
  const empty = join(tmp, 'empty-root')
  mkdirSync(empty, { recursive: true })
  eq(await pickProjectDirFromRoots([fileRoot(empty), fileRoot(workspace)], spawnDir), workspace)
})

await test('pickProjectDirFromRoots keeps a Capacitor cwd inside a root', async () => {
  eq(await pickProjectDirFromRoots([fileRoot(workspace)], app), app)
})

await test('pickProjectDirFromRoots falls back to the first root and ignores non-file roots', async () => {
  eq(await pickProjectDirFromRoots([{ uri: 'https://example.com' }, fileRoot(spawnDir)], tmp), spawnDir)
  eq(await pickProjectDirFromRoots([{ uri: 'https://example.com' }], tmp), undefined)
  eq(await pickProjectDirFromRoots([fileRoot(join(tmp, 'missing'))], tmp), undefined)
})

await test('resolveProjectDirInput resolves relative paths and rejects missing dirs', async () => {
  eq(await resolveProjectDirInput('apps/mobile', workspace), app)
  eq(await resolveProjectDirInput(pathToFileURL(app).href, tmp), app)
  let threw = false
  try { await resolveProjectDirInput(join(tmp, 'nope'), tmp) }
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

async function withServer(roots, fn, cwd = spawnDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundlePath, 'mcp'],
    cwd,
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
  await test('ambiguous client roots stop tools before writing files and recover through projectDir', async () => {
    await withServer([fileRoot(multiple)], async (client) => {
      const blocked = await client.callTool({ name: 'capgo_generate_encryption_keys', arguments: {} })
      eq(blocked.isError, true)
      for (const dir of multipleApps)
        ok(toolText(blocked).includes(dir), toolText(blocked))
      eq(existsSync(join(spawnDir, '.capgo_key_v2')), false)
      eq(existsSync(join(multiple, '.capgo_key_v2')), false)
      const recovered = await client.callTool({ name: 'capgo_logout', arguments: { projectDir: multipleApps[0], scope: 'local' } })
      ok(!recovered.isError, toolText(recovered))
      ok((await currentDir(client)).includes(`project directory: ${multipleApps[0]} `))
    })
  })

  await test('every registered tool accepts projectDir, including tools without inputs and both onboarding flows', async () => {
    await withServer(undefined, async (client) => {
      const { tools } = await client.listTools()
      ok(tools.some(tool => tool.name === 'capgo_list_apps'), 'account tools must be registered')
      ok(tools.some(tool => tool.name === 'start_capgo_builder_onboarding'), 'builder tools must be registered')
      ok(tools.some(tool => tool.name === 'start_capgo_live_update_onboarding'), 'live-update tools must be registered')
      for (const tool of tools)
        eq(tool.inputSchema.properties.projectDir.type, 'string', `${tool.name} must accept projectDir`)
    })
  })

  await test('non-onboarding tools select and retain an app directly without a setter call', async () => {
    await withServer(undefined, async (client) => {
      const generated = await client.callTool({ name: 'capgo_generate_encryption_keys', arguments: { projectDir: monorepo } })
      ok(!generated.isError, toolText(generated))
      const privateKey = readFileSync(join(mobile, '.capgo_key_v2'), 'utf8')
      ok(privateKey.startsWith('-----BEGIN RSA PRIVATE KEY-----'), 'key must be created inside the app')
      const publicKey = readFileSync(join(mobile, '.capgo_key_v2.pub'), 'utf8')
      eq(JSON.parse(readFileSync(join(mobile, 'capacitor.config.json'), 'utf8')).plugins.CapacitorUpdater.publicKey, publicKey)
      eq(existsSync(join(monorepo, '.capgo_key_v2')), false, 'workspace root must not receive app keys')
      eq(existsSync(join(spawnDir, '.capgo_key_v2')), false, 'spawn directory must not receive app keys')

      writeFileSync(join(mobile, '.capgo'), 'example-local-key')
      writeFileSync(join(other, '.capgo'), 'example-other-key')
      const logout = await client.callTool({ name: 'capgo_logout', arguments: { scope: 'local' } })
      ok(!logout.isError, toolText(logout))
      eq(existsSync(join(mobile, '.capgo')), false, 'subsequent calls must use the selected app')
      eq(readFileSync(join(other, '.capgo'), 'utf8'), 'example-other-key')
      const otherLogout = await client.callTool({ name: 'capgo_logout', arguments: { scope: 'local', projectDir: other } })
      ok(!otherLogout.isError, toolText(otherLogout))
      eq(existsSync(join(other, '.capgo')), false, 'a later call can select another app')

      const invalid = await client.callTool({ name: 'capgo_generate_encryption_keys', arguments: { projectDir: multiple } })
      eq(invalid.isError, true)
      ok(toolText(invalid).includes(multipleApps[0]), toolText(invalid))
      ok((await currentDir(client)).includes(`project directory: ${other} `), 'failed selection preserves the current app')
    })
  })

  await test('server follows a workspace root into its nested Capacitor app', async () => {
    await withServer([fileRoot(monorepo)], async (client) => {
      const text = await currentDir(client)
      ok(text.includes(`project directory: ${mobile} (Capacitor config found)`), text)
    })
  })

  await test('without roots, setting a workspace finds its nested Capacitor app', async () => {
    await withServer(undefined, async (client) => {
      const result = await client.callTool({ name: 'capgo_set_project_dir', arguments: { path: monorepo } })
      const text = toolText(result)
      ok(!result.isError, text)
      ok(text.includes(`project directory: ${mobile} (Capacitor config found)`), text)
    })
  })

  await test('without roots, a server launched in a workspace discovers its app', async () => {
    await withServer(undefined, async (client) => {
      const text = await currentDir(client)
      ok(text.includes(`project directory: ${mobile} (Capacitor config found)`), text)
    }, monorepo)
  })

  await test('ambiguous workspace selection keeps the previous app and lists choices', async () => {
    await withServer([fileRoot(other)], async (client) => {
      const result = await client.callTool({ name: 'capgo_set_project_dir', arguments: { path: multiple } })
      const text = toolText(result)
      ok(result.isError, text)
      for (const dir of multipleApps)
        ok(text.includes(dir), text)
      ok((await currentDir(client)).includes(`project directory: ${other} `), 'ambiguous selection must not change the app')
    })
  })

  await test('server discovers a nested app after roots change', async () => {
    await withServer([fileRoot(other)], async (client, setRoots) => {
      setRoots([fileRoot(monorepo)])
      await client.sendRootsListChanged()
      const text = await currentDir(client)
      ok(text.includes(`project directory: ${mobile} (Capacitor config found)`), text)
    })
  })

  await test('an explicitly selected app stays pinned when roots change', async () => {
    await withServer([fileRoot(monorepo)], async (client, setRoots) => {
      await client.callTool({ name: 'capgo_set_project_dir', arguments: { path: multipleApps[1] } })
      setRoots([fileRoot(other)])
      await client.sendRootsListChanged()
      const text = await currentDir(client)
      ok(text.includes(`project directory: ${multipleApps[1]} (Capacitor config found)`), text)
    })
  })

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
