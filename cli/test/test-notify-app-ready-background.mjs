import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { resolveNotifyAppReadyProject } from '../src/onboarding/notify-app-ready-project.ts'
import { scanNotifyAppReadySource } from '../src/onboarding/notify-app-ready-source.ts'

const fixtures = []
const workerUrl = new URL('../dist/notify-app-ready-worker.js', import.meta.url)
const call = "import { CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater.notifyAppReady()"

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-ready-')))
  fixtures.push(root)
  return root
}

function app(root, path = '.', appId = 'com.example.ready', extra = {}) {
  const dir = join(root, path)
  const config = { appId, appName: 'Example', webDir: 'output', ...extra }
  write(join(dir, 'package.json'), { name: `example-${appId}`, version: '1.0.0' })
  write(join(dir, 'capacitor.config.json'), config)
  return { dir, workspaceRoot: root, appId, config, webDir: join(dir, config.webDir) }
}

function scan(content, filename = 'main.ts') {
  const project = app(fixture())
  write(join(project.dir, 'src', filename), content)
  return scanNotifyAppReadySource(project)
}

test('detects direct calls, import aliases, namespace imports, CommonJS, and optional/computed calls', () => {
  for (const content of [
    call,
    "import { CapacitorUpdater as Updater } from '@capgo/capacitor-updater'; Updater.notifyAppReady()",
    "import * as updater from '@capgo/capacitor-updater'; updater.CapacitorUpdater.notifyAppReady()",
    "const { CapacitorUpdater: Updater } = require('@capgo/capacitor-updater'); Updater.notifyAppReady()",
    "import { CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater?.notifyAppReady?.()",
    "import { CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater['notifyAppReady']()",
  ]) {
    assert.equal(scan(content), 'found', content)
  }
  assert.equal(scan(call, 'main.jsx'), 'found')
  assert.equal(scan(call, 'main.mjs'), 'found')
})

test('ignores comments, strings, definitions, other packages, type imports, and shadowed bindings', () => {
  for (const content of [
    `// ${call}`,
    `const example = ${JSON.stringify(call)}`,
    'const CapacitorUpdater = { notifyAppReady() {} }; CapacitorUpdater.notifyAppReady()',
    "import { CapacitorUpdater } from 'another-package'; CapacitorUpdater.notifyAppReady()",
    "import type { CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater.notifyAppReady()",
    "import { type CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater.notifyAppReady()",
    "import { CapacitorUpdater } from '@capgo/capacitor-updater'; function example(CapacitorUpdater) { CapacitorUpdater.notifyAppReady() }",
    "import * as updater from '@capgo/capacitor-updater'; function example(updater) { updater.CapacitorUpdater.notifyAppReady() }",
    "function require() { return {} }; const { CapacitorUpdater } = require('@capgo/capacitor-updater'); CapacitorUpdater.notifyAppReady()",
  ]) {
    assert.equal(scan(content), 'not_found', content)
  }
  assert.equal(scan(`${call}; const broken = (`), 'unknown')
})

test('checks Vue script/setup blocks and ignores markup and HTML comments', () => {
  assert.equal(scan(`<template><div /></template><script setup lang="ts">${call}</script>`, 'App.vue'), 'found')
  assert.equal(scan(`<template>${call}</template><!-- <script>${call}</script> -->`, 'App.vue'), 'not_found')
  assert.equal(scan(`<template><script>${call}</script></template>`, 'App.vue'), 'not_found')
  assert.equal(scan(`<template><div /></template><!-- <script>${call}</script> --><!-- ignored -->`, 'App.vue'), 'not_found')
  assert.equal(scan(`<template><div /></template><script lang="ts" data-example=">">${call}</script>`, 'App.vue'), 'found')
  assert.equal(scan(`<template><div /></template><script>${call}</script\t\n bar>`, 'App.vue'), 'found')
  assert.equal(scan(`<template><div /></template><script>${call}`, 'App.vue'), 'unknown')
})

test('excludes build output, tests, dependencies, and unrelated workspace packages', () => {
  const project = app(fixture())
  for (const path of ['output/main.js', 'dist/main.js', 'tests/main.ts', 'src/example.spec.ts', 'src/__fixtures__/main.ts', 'capacitor.config.example.ts', 'node_modules/example/main.js'])
    write(join(project.dir, path), call)
  app(project.dir, 'apps/other', 'com.example.other')
  write(join(project.dir, 'apps/other/src/main.ts'), call)
  assert.equal(scanNotifyAppReadySource(project), 'not_found')
})

test('follows imported local workspace code through tsconfig paths and package symlinks', () => {
  const root = fixture()
  const project = app(root, 'apps/mobile')
  write(join(root, 'package.json'), { private: true, workspaces: ['apps/*', 'packages/*'] })
  write(join(project.dir, 'tsconfig.json'), { compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['../../packages/shared/src/*'] } } })
  write(join(project.dir, 'src/main.ts'), "import '@shared/ready'")
  write(join(root, 'packages/shared/package.json'), { name: '@example/shared', main: 'src/ready.ts' })
  write(join(root, 'packages/shared/src/ready.ts'), call)
  assert.equal(scanNotifyAppReadySource(project), 'found')
  mkdirSync(join(project.dir, 'node_modules/@example'), { recursive: true })
  symlinkSync(join(root, 'packages/shared'), join(project.dir, 'node_modules/@example/shared'), 'junction')
  write(join(project.dir, 'src/main.ts'), "import '@example/shared'")
  assert.equal(scanNotifyAppReadySource(project), 'found')
})

test('resolves the nearest app from a nested directory and skips mismatched app IDs', async () => {
  const project = app(fixture())
  const cwd = join(project.dir, 'src/nested')
  mkdirSync(cwd, { recursive: true })
  const resolved = await resolveNotifyAppReadyProject({ cwd, command: 'app list' })
  assert.equal(resolved.dir, project.dir)
  assert.equal(resolved.workspaceRoot, project.dir)
  assert.equal(await resolveNotifyAppReadyProject({ cwd, appId: 'com.example.other', command: 'bundle upload' }), undefined)
  assert.equal(await resolveNotifyAppReadyProject({ cwd: fixture(), command: 'app list' }), undefined)
})

test('selects an unambiguous workspace app, or the explicitly requested app', async () => {
  const root = fixture()
  write(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
  const first = app(root, 'apps/first', 'com.example.first')
  const options = { cwd: root, command: 'app list' }
  assert.equal((await resolveNotifyAppReadyProject(options)).dir, first.dir)
  const second = app(root, 'apps/second', 'com.example.second')
  assert.equal(await resolveNotifyAppReadyProject(options), undefined)
  assert.equal((await resolveNotifyAppReadyProject({ ...options, appId: second.appId })).dir, second.dir)
  assert.equal((await resolveNotifyAppReadyProject({ ...options, packageJson: 'apps/second/package.json' })).dir, second.dir)
  assert.equal(await resolveNotifyAppReadyProject({ ...options, appId: 'com.example.unknown' }), undefined)
  write(join(first.dir, 'capacitor.config.json'), 'invalid-json')
  assert.equal((await resolveNotifyAppReadyProject({ ...options, appId: second.appId })).dir, second.dir)
})

test('honors dynamic root config source paths and rejects conflicting targets', async () => {
  const root = fixture()
  const project = app(root, 'apps/mobile')
  write(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
  write(join(root, 'capacitor.config.json'), { ...project.config, webDir: 'apps/mobile/output' })
  const target = join(root, 'env-configs/capacitor.config.mobile.json')
  write(target, project.config)
  const options = { cwd: root, command: 'init', capacitorConfig: target, packageJson: 'apps/mobile/package.json' }
  assert.equal((await resolveNotifyAppReadyProject(options)).dir, project.dir)
  assert.equal((await resolveNotifyAppReadyProject({ ...options, packageJson: undefined })).dir, project.dir)
  assert.equal(await resolveNotifyAppReadyProject({ ...options, packageJson: 'apps/mobile/package.json,package.json' }), undefined)
  write(target, { ...project.config, appId: 'com.example.other' })
  assert.equal(await resolveNotifyAppReadyProject(options), undefined)
})

test('workspace discovery does not execute unselected sibling configs', async () => {
  const root = fixture()
  write(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
  const first = app(root, 'apps/first', 'com.example.first')
  const second = app(root, 'apps/second', 'com.example.second')
  for (const project of [first, second]) {
    write(join(project.dir, 'capacitor.config.js'), `
      require('node:fs').writeFileSync(${JSON.stringify(join(project.dir, 'config-loaded'))}, 'loaded')
      module.exports = ${JSON.stringify(project.config)}
    `)
  }
  const options = { cwd: root, command: 'app list' }
  assert.equal(await resolveNotifyAppReadyProject(options), undefined)
  assert.equal(await resolveNotifyAppReadyProject({ ...options, appId: 'com.example.unknown' }), undefined)
  assert.equal(await resolveNotifyAppReadyProject({ ...options, packageJson: 'apps/first/package.json,apps/second/package.json' }), undefined)
  assert.equal(existsSync(join(first.dir, 'config-loaded')), false)
  assert.equal(existsSync(join(second.dir, 'config-loaded')), false)
  assert.equal((await resolveNotifyAppReadyProject({ ...options, appId: second.appId })).dir, second.dir)
  assert.equal(existsSync(join(first.dir, 'config-loaded')), false)
  assert.equal(existsSync(join(second.dir, 'config-loaded')), true)
})

test('incomplete scans and invalid Capacitor configs cannot mark integration complete', async () => {
  const project = app(fixture())
  write(join(project.dir, 'src/main.ts'), ' '.repeat(1024 * 1024 + 1))
  assert.equal(scanNotifyAppReadySource(project), 'unknown')
  write(join(project.dir, 'capacitor.config.json'), { appId: project.appId, webDir: 5 })
  assert.equal(await resolveNotifyAppReadyProject({ cwd: project.dir, command: 'app list' }), undefined)
  write(join(project.dir, 'capacitor.config.json'), { appId: project.appId })
  const resolved = await resolveNotifyAppReadyProject({ cwd: project.dir, command: 'app list' })
  assert.equal(resolved.dir, project.dir)
  assert.equal(resolved.webDir, join(project.dir, 'www'))
})

test('packaged worker sends only the add_code patch with CLI auth and destination context', async () => {
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request)
      body += chunk
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse(body), method: request.method })
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const api = `http://127.0.0.1:${server.address().port}`
    const project = app(fixture(), '.', 'com.example.ready', { plugins: { CapacitorUpdater: { localApi: api } } })
    write(join(project.dir, 'src/main.ts'), call)
    async function run(extra = {}) {
      const workerData = { cwd: project.dir, command: 'app list', apikey: 'fake-api-key', ...extra }
      const child = spawn('node', ['--input-type=module', '-e', `
        import { Worker } from 'node:worker_threads'
        const worker = new Worker(new URL(${JSON.stringify(workerUrl.href)}), {
          workerData: ${JSON.stringify(workerData)}, stdout: true, stderr: true, execArgv: []
        })
        worker.on('error', () => process.exit(1))
        worker.on('exit', code => process.exit(code))
      `], { stdio: 'ignore' })
      const [code] = await once(child, 'exit')
      assert.equal(code, 0)
    }
    await run()
    assert.deepEqual(requests[0].body, { onboarding: { steps: { add_code: { status: 'done' } } } })
    assert.equal(requests[0].path, '/app/com.example.ready')
    assert.equal(requests[0].method, 'PUT')
    assert.equal(requests[0].headers.capgkey, 'fake-api-key')
    assert.equal(requests[0].headers.authorization, 'fake-api-key')
    assert.equal(requests[0].headers['x-cli-command'], 'app list')
    await run({ supaHost: api, supaAnon: 'fake-anon-key' })
    assert.equal(requests[1].path, '/functions/v1/app/com.example.ready')
    assert.equal(requests[1].headers.authorization, 'Bearer fake-anon-key')
    write(join(project.dir, 'src/main.ts'), '// notifyAppReady()')
    await run()
    assert.equal(requests.length, 2)
    await run({ cwd: '/nonexistent-example-project' })
    assert.equal(requests.length, 2)
  }
  finally {
    server.closeAllConnections()
    server.close()
  }
})

test('launcher abandons a busy worker without output or waiting for shutdown', async () => {
  const dir = fixture()
  write(join(dir, 'package.json'), { type: 'module' })
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../src/notify-app-ready-background.ts', import.meta.url))],
    outdir: dir,
    target: 'node',
    format: 'esm',
  })
  assert.equal(build.success, true)
  write(join(dir, 'notify-app-ready-worker.js'), "console.log('worker-output'); console.error('worker-error'); setInterval(() => {}, 10000)")
  write(join(dir, 'run.mjs'), `
    import { startNotifyAppReadyCheck } from './notify-app-ready-background.js'
    startNotifyAppReadyCheck({ optsWithGlobals: () => ({}), registeredArguments: [], args: [] }, 'app list')
    setTimeout(() => console.log('foreground-finished'), 500)
  `)
  const child = spawn('node', [join(dir, 'run.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const timeout = setTimeout(() => child.kill(), 5_000)
  try {
    const [code, signal] = await once(child, 'exit')
    assert.equal(signal, null, 'worker kept the foreground process alive')
    assert.equal(code, 0)
    assert.equal(output.trim(), 'foreground-finished')
    assert.equal(errors, '')
  }
  finally {
    clearTimeout(timeout)
  }
})

afterAll(() => {
  for (const root of fixtures)
    rmSync(root, { recursive: true, force: true })
})
