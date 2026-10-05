import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { resolveNotifyAppReadyProject } from '../src/onboarding/notify-app-ready-project.ts'
import { scanNotifyAppReadySource } from '../src/onboarding/notify-app-ready-source.ts'
import { scanUpdaterInstalled } from '../src/onboarding/updater-installed.ts'
import { isTrustedOnboardingApiHost } from '../src/onboarding/background-api.ts'

const fixtures = []
const workerUrl = new URL('../dist/notify-app-ready-worker.js', import.meta.url)
const updaterWorkerUrl = new URL('../dist/updater-installed-worker.js', import.meta.url)
const combinedWorkerUrl = new URL('../dist/onboarding-worker.js', import.meta.url)
const call = "import { CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater.notifyAppReady()"

async function workerHarness(worker = workerUrl) {
  const requests = []
  const behavior = { events: 'ok', putStatus: 200, putError: false, putDelayMs: 0 }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request)
      body += chunk
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse(body), method: request.method })
    if (request.method === 'POST')
      behavior.onEvent?.(requests.at(-1).body)
    if (request.method === 'PUT' && behavior.putError) {
      request.socket.destroy()
      return
    }
    if (behavior.redirectLocation && (request.method === 'POST' ? behavior.events === 'redirect' : behavior.putRedirect)) {
      response.writeHead(307, { Location: behavior.redirectLocation }).end()
      return
    }
    if (request.method === 'POST' && behavior.events === 'hang')
      return
    if (request.method === 'PUT' && behavior.putDelayMs)
      await new Promise(resolve => setTimeout(resolve, behavior.putDelayMs))
    const status = request.method === 'PUT' ? behavior.putStatus : behavior.events === 'rejected' ? 503 : 200
    response.writeHead(status, { 'Content-Type': 'application/json' }).end('{"status":"ok"}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const api = `http://127.0.0.1:${server.address().port}`
  const project = app(fixture(), '.', 'com.example.ready', { plugins: { CapacitorUpdater: { localApi: api } } })
  write(join(project.dir, 'src/main.ts'), call)
  return {
    api, project, requests, behavior,
    async run(extra = {}, environment = {}) {
      requests.length = 0
      const workerData = worker.href === combinedWorkerUrl.href
        ? { cwd: project.dir, command: 'app list', apikey: 'fake-api-key', ...extra }
        : { project: { dir: project.dir, workspaceRoot: project.workspaceRoot, appId: project.appId, webDir: project.webDir }, apiHost: api, command: 'app list', apikey: 'fake-api-key', attemptId: randomUUID(), ...extra }
      const child = spawn('node', ['--input-type=module', '-e', `
        import { Worker } from 'node:worker_threads'
        const worker = new Worker(new URL(${JSON.stringify(worker.href)}), {
          workerData: ${JSON.stringify(workerData)}, stdout: true, stderr: true, execArgv: []
        })
        worker.on('error', () => process.exit(1))
        worker.on('exit', code => process.exit(code))
      `], {
        stdio: 'ignore',
        env: { ...process.env, CAPGO_DISABLE_TELEMETRY: '', CAPGO_DISABLE_POSTHOG: '', CAPGO_TRUSTED_API_ORIGINS: api, ...environment },
      })
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, signal] = await once(child, 'exit')
        assert.equal(signal, null, 'worker did not finish its bounded reporting')
        assert.equal(code, 0)
      }
      finally {
        clearTimeout(timeout)
      }
    },
    close() {
      server.closeAllConnections()
      server.close()
    },
  }
}

function scanEvents(requests, result, reportStatus, channel = 'notify-app-ready') {
  const events = requests.filter(request => request.method === 'POST')
  assert.deepEqual(events.map(request => request.body.event), ['scan_started', 'scan_ended'])
  const [started, ended] = events.map(request => request.body)
  assert.match(started.nonPersonTags.attempt_id, /^[0-9a-f-]{36}$/)
  assert.equal(ended.nonPersonTags.attempt_id, started.nonPersonTags.attempt_id)
  for (const request of events) {
    assert.equal(request.path.endsWith('/private/events'), true)
    assert.equal(request.headers.capgkey, 'fake-api-key')
    assert.equal(request.headers['x-cli-command'], 'app list')
    assert.equal(request.body.channel, channel)
    assert.equal(request.body.tracking_version, 2)
    assert.deepEqual(request.body.tags, { app_id: 'com.example.ready' })
    assert.equal(request.body.nonPersonTags.command_path, 'app list')
    assert.equal(typeof request.body.nonPersonTags.cli_version, 'string')
    assert.equal(Number.isFinite(Date.parse(request.body.timestamp)), true)
  }
  assert.equal(Date.parse(ended.timestamp) >= Date.parse(started.timestamp), true)
  assert.equal(ended.nonPersonTags.result, result)
  assert.equal(ended.nonPersonTags.todo_report_status, reportStatus)
  assert.equal(typeof ended.nonPersonTags.duration_ms, 'number')
  assert.equal(ended.nonPersonTags.duration_ms >= 0, true)
  return started.nonPersonTags.attempt_id
}

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

test.concurrent('packaged worker pairs scan events and sends only the add_code patch with CLI auth and destination context', async () => {
  const harness = await workerHarness()
  const { api, requests } = harness
  try {
    const parentAttempt = '11111111-1111-4111-8111-111111111111'
    await harness.run({ attemptId: parentAttempt })
    const firstAttempt = scanEvents(requests, 'found', 'success')
    assert.equal(firstAttempt, parentAttempt)
    assert.deepEqual(requests.map(request => request.body.event ?? request.method), ['scan_started', 'PUT', 'scan_ended'])
    const patch = requests.find(request => request.method === 'PUT')
    assert.deepEqual(patch.body, { onboarding: { steps: { add_code: { status: 'done' } } } })
    assert.equal(patch.path, '/app/com.example.ready')
    assert.equal(patch.headers.capgkey, 'fake-api-key')
    assert.equal(patch.headers.authorization, 'fake-api-key')
    assert.equal(patch.headers['x-cli-command'], 'app list')
    assert.equal(requests.at(-1).body.nonPersonTags.todo_report_http_status, 200)
    await harness.run({ apiHost: `${api}/functions/v1`, anonKey: 'fake-anon-key' })
    assert.notEqual(scanEvents(requests, 'found', 'success'), firstAttempt)
    assert.equal(requests.every(request => request.path.startsWith('/functions/v1/')), true)
    assert.equal(requests.find(request => request.method === 'PUT').headers.authorization, 'Bearer fake-anon-key')
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('scan-ended records negative, unknown, rejected, and failed todo outcomes without changing unrelated todos', async () => {
  const harness = await workerHarness()
  const { project, requests, behavior } = harness
  try {
    const attempts = new Set()
    for (const [source, result] of [['// notifyAppReady()', 'not_found'], ['const broken = (', 'unknown']]) {
      write(join(project.dir, 'src/main.ts'), source)
      await harness.run()
      attempts.add(scanEvents(requests, result, 'not_attempted'))
      assert.equal(requests.length, 2)
      assert.equal('todo_report_http_status' in requests.at(-1).body.nonPersonTags, false)
    }
    write(join(project.dir, 'src/main.ts'), call)
    behavior.putStatus = 403
    await harness.run()
    attempts.add(scanEvents(requests, 'found', 'rejected'))
    assert.equal(requests.at(-1).body.nonPersonTags.todo_report_http_status, 403)
    behavior.putError = true
    await harness.run()
    attempts.add(scanEvents(requests, 'found', 'failed'))
    assert.equal('todo_report_http_status' in requests.at(-1).body.nonPersonTags, false)
    assert.equal(attempts.size, 4)
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('analytics opt-out and unavailable telemetry never prevent the todo update', async () => {
  const harness = await workerHarness()
  const { requests, behavior } = harness
  try {
    for (const setting of ['CAPGO_DISABLE_TELEMETRY', 'CAPGO_DISABLE_POSTHOG']) {
      await harness.run({}, { [setting]: 'true' })
      assert.equal(requests.length, 1)
      assert.equal(requests[0].method, 'PUT')
    }
    for (const mode of ['rejected', 'hang']) {
      behavior.events = mode
      await harness.run()
      scanEvents(requests, 'found', 'success')
      assert.equal(requests.filter(request => request.method === 'PUT').length, 1)
    }
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('both workers allow successful todo reports to take longer than two seconds', async () => {
  for (const [worker, channel] of [[workerUrl, 'notify-app-ready'], [updaterWorkerUrl, 'updater-installed']]) {
    const harness = await workerHarness(worker)
    if (channel === 'updater-installed')
      installUpdater(harness.project)
    harness.behavior.putDelayMs = 2_200
    try {
      await harness.run()
      scanEvents(harness.requests, 'found', 'success', channel)
    }
    finally {
      harness.close()
    }
  }
}, 20_000)

test.concurrent('foreground exits while the real worker is waiting on scan-started telemetry', async () => {
  const harness = await workerHarness()
  harness.behavior.events = 'hang'
  let started
  const received = new Promise(resolve => { started = resolve })
  harness.behavior.onEvent = event => {
    if (event.event === 'scan_started')
      started()
  }
  const dir = fixture()
  write(join(dir, 'package.json'), { type: 'module' })
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../src/onboarding/background.ts', import.meta.url))],
    outdir: dir,
    target: 'node',
    format: 'esm',
  })
  assert.equal(build.success, true)
  write(join(dir, 'onboarding-worker.js'), `import ${JSON.stringify(combinedWorkerUrl.href)}`)
  write(join(dir, 'run.mjs'), `
    import { startOnboardingChecks } from './background.js'
    startOnboardingChecks({ optsWithGlobals: () => ({ apikey: 'fake-api-key' }), registeredArguments: [], args: [] }, 'app list')
    process.stdin.resume()
    process.stdin.once('end', () => console.log('foreground-finished'))
  `)
  const child = spawn('node', [join(dir, 'run.mjs')], {
    cwd: harness.project.dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: '', CAPGO_DISABLE_POSTHOG: '', CAPGO_TRUSTED_API_ORIGINS: harness.api },
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = once(child, 'exit')
  const timeout = setTimeout(() => child.kill(), 5_000)
  try {
    await Promise.race([received, exited.then(() => { throw new Error('foreground exited before the started event') })])
    child.stdin.end()
    const [code, signal] = await exited
    assert.equal(signal, null, 'pending telemetry kept the foreground alive')
    assert.equal(code, 0)
    assert.equal(output.trim(), 'foreground-finished')
    assert.equal(errors, '')
    assert.deepEqual(harness.requests.map(request => request.body.event), ['scan_started'])
  }
  finally {
    clearTimeout(timeout)
    if (child.exitCode === null)
      child.kill()
    harness.close()
  }
}, 10_000)

test('launcher abandons a busy worker without output or waiting for shutdown', async () => {
  const dir = fixture()
  write(join(dir, 'package.json'), { type: 'module' })
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../src/onboarding/background.ts', import.meta.url))],
    outdir: dir,
    target: 'node',
    format: 'esm',
  })
  assert.equal(build.success, true)
  write(join(dir, 'onboarding-worker.js'), "console.log('worker-output'); console.error('worker-error'); setInterval(() => {}, 10000)")
  write(join(dir, 'run.mjs'), `
    import { startOnboardingChecks } from './background.js'
    startOnboardingChecks({ optsWithGlobals: () => ({}), registeredArguments: [], args: [] }, 'app list')
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

function installUpdater(project, directory = project.dir, section = 'dependencies') {
  write(join(project.dir, 'package.json'), {
    name: 'example-mobile',
    [section]: { '@capgo/capacitor-updater': 'catalog:' },
  })
  write(join(directory, 'node_modules/@capgo/capacitor-updater/package.json'), {
    name: '@capgo/capacitor-updater', version: '8.0.0',
  })
}

test('updater detection requires both a selected-app declaration and an installed package', () => {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const project = app(fixture())
    assert.equal(scanUpdaterInstalled(project), 'not_found')
    write(join(project.dir, 'package.json'), { [section]: { '@capgo/capacitor-updater': '^8.0.0' } })
    assert.equal(scanUpdaterInstalled(project), 'not_found', 'declaration alone is not installation')
    installUpdater(project, project.dir, section)
    assert.equal(scanUpdaterInstalled(project), 'found')
    write(join(project.dir, 'package.json'), { name: 'example-without-updater' })
    assert.equal(scanUpdaterInstalled(project), 'not_found', 'an undeclared package must not complete the step')
  }
  const project = app(fixture())
  installUpdater(project)
  write(join(project.dir, 'node_modules/@capgo/capacitor-updater/package.json'), 'broken-json')
  assert.equal(scanUpdaterInstalled(project), 'not_found')
})

test('updater detection supports hoisted and pnpm-style symlinked installations without attributing sibling dependencies', async () => {
  const root = fixture()
  write(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
  const first = app(root, 'apps/first', 'com.example.first')
  const second = app(root, 'apps/second', 'com.example.second')
  installUpdater(first, root)
  assert.equal(scanUpdaterInstalled(first), 'found')
  assert.equal(scanUpdaterInstalled(second), 'not_found')
  const selected = await resolveNotifyAppReadyProject({ cwd: root, command: 'app list', appId: first.appId })
  assert.equal(scanUpdaterInstalled(selected), 'found')
  const pnpmRoot = fixture()
  const linked = app(pnpmRoot, 'apps/mobile')
  installUpdater(linked, join(pnpmRoot, '.pnpm-store/updater'))
  mkdirSync(join(linked.dir, 'node_modules/@capgo'), { recursive: true })
  symlinkSync(join(pnpmRoot, '.pnpm-store/updater/node_modules/@capgo/capacitor-updater'), join(linked.dir, 'node_modules/@capgo/capacitor-updater'), 'junction')
  assert.equal(scanUpdaterInstalled(linked), 'found')
})

test.concurrent('installed-updater worker pairs scan events and only completes add_updater, including self-hosted destinations', async () => {
  const harness = await workerHarness(updaterWorkerUrl)
  const { api, project, requests } = harness
  installUpdater(project)
  try {
    await harness.run()
    const firstAttempt = scanEvents(requests, 'found', 'success', 'updater-installed')
    const patch = requests.find(request => request.method === 'PUT')
    assert.deepEqual(patch.body, { onboarding: { steps: { add_updater: { status: 'done' } } } })
    assert.equal(patch.path, '/app/com.example.ready')
    assert.equal(patch.headers.authorization, 'fake-api-key')
    assert.equal(patch.headers['x-cli-command'], 'app list')
    await harness.run({ apiHost: `${api}/functions/v1`, anonKey: 'fake-anon-key' })
    assert.notEqual(scanEvents(requests, 'found', 'success', 'updater-installed'), firstAttempt)
    assert.equal(requests.every(request => request.path.startsWith('/functions/v1/')), true)
    assert.equal(requests.find(request => request.method === 'PUT').headers.authorization, 'Bearer fake-anon-key')
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('installed-updater worker skips missing packages and handles rejected reports and telemetry opt-out', async () => {
  const harness = await workerHarness(updaterWorkerUrl)
  const { project, requests, behavior } = harness
  try {
    await harness.run()
    scanEvents(requests, 'not_found', 'not_attempted', 'updater-installed')
    assert.equal(requests.length, 2, 'missing installation must never clear progress')
    installUpdater(project)
    behavior.putStatus = 403
    await harness.run()
    scanEvents(requests, 'found', 'rejected', 'updater-installed')
    assert.equal(requests.at(-1).body.nonPersonTags.todo_report_http_status, 403)
    behavior.putStatus = 200
    for (const setting of ['CAPGO_DISABLE_TELEMETRY', 'CAPGO_DISABLE_POSTHOG']) {
      await harness.run({}, { [setting]: 'true' })
      assert.deepEqual(requests.map(request => request.method), ['PUT'])
    }
    behavior.events = 'hang'
    await harness.run()
    scanEvents(requests, 'found', 'success', 'updater-installed')
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('coordinator loads the project once and reports both checks independently', async () => {
  const harness = await workerHarness(combinedWorkerUrl)
  const { project, requests } = harness
  installUpdater(project)
  const configLoaded = join(project.dir, 'config-loaded')
  write(join(project.dir, 'capacitor.config.js'), `
    require('node:fs').appendFileSync(${JSON.stringify(configLoaded)}, '1')
    module.exports = ${JSON.stringify(project.config)}
  `)
  try {
    await harness.run()
    assert.equal(readFileSync(configLoaded, 'utf8'), '1', 'project config should load only once')
    const sourceRequests = requests.filter(request => request.body.channel === 'notify-app-ready')
    const updaterRequests = requests.filter(request => request.body.channel === 'updater-installed')
    const sourceAttempt = scanEvents(sourceRequests, 'found', 'success')
    const updaterAttempt = scanEvents(updaterRequests, 'found', 'success', 'updater-installed')
    assert.notEqual(sourceAttempt, updaterAttempt)
    assert.deepEqual(requests.filter(request => request.method === 'PUT').map(request => request.body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
      { onboarding: { steps: { add_code: { status: 'done' } } } },
      { onboarding: { steps: { add_updater: { status: 'done' } } } },
    ])
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('coordinator skips both checks when the project or credentials cannot be resolved', async () => {
  const harness = await workerHarness(combinedWorkerUrl)
  installUpdater(harness.project)
  try {
    for (const options of [{ appId: 'com.example.other' }, { apikey: '' }, { cwd: '/nonexistent-example-project' }]) {
      await harness.run(options)
      assert.deepEqual(harness.requests, [])
    }
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('coordinator skips custom updater endpoints without reporting or telemetry', async () => {
  const harness = await workerHarness(combinedWorkerUrl)
  installUpdater(harness.project)
  const configPath = join(harness.project.dir, 'capacitor.config.json')
  try {
    for (const endpoints of [
      { updateUrl: 'https://updates.example.net/check' },
      { updateUrl: 'https://plugin.capgo.app/updates', statsUrl: 'https://stats.example.net/report' },
      { updateUrl: 'https://plugin.capgo.app.evil.test/updates' },
      { statsUrl: 'invalid-url' },
    ]) {
      write(configPath, { ...harness.project.config, plugins: { CapacitorUpdater: { localApi: harness.api, ...endpoints } } })
      await harness.run()
      assert.deepEqual(harness.requests, [], JSON.stringify(endpoints))
    }

    for (const endpoints of [
      { updateUrl: 'https://plugin.eu.capgo.app/updates', statsUrl: '' },
      { updateUrl: 'https://usecapgo.com/updates', statsUrl: 'https://stats.usecapgo.com/report' },
    ]) {
      write(configPath, { ...harness.project.config, plugins: { CapacitorUpdater: { localApi: harness.api, ...endpoints } } })
      await harness.run()
      assert.equal(harness.requests.filter(request => request.method === 'PUT').length, 2)
      assert.equal(harness.requests.filter(request => request.method === 'POST').length, 4)
    }
  }
  finally {
    harness.close()
  }
}, 30_000)

test.concurrent('coordinator and its scan workers can be abandoned without holding the foreground open', async () => {
  const harness = await workerHarness(combinedWorkerUrl)
  installUpdater(harness.project)
  harness.behavior.events = 'hang'
  const channels = new Set()
  let ready
  const received = new Promise(resolve => { ready = resolve })
  harness.behavior.onEvent = event => {
    if (event.event === 'scan_started') {
      channels.add(event.channel)
      if (channels.size === 2)
        ready()
    }
  }
  const dir = fixture()
  write(join(dir, 'package.json'), { type: 'module' })
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../src/onboarding/background.ts', import.meta.url))],
    outdir: dir, target: 'node', format: 'esm',
  })
  assert.equal(build.success, true)
  write(join(dir, 'onboarding-worker.js'), `import ${JSON.stringify(combinedWorkerUrl.href)}`)
  write(join(dir, 'run.mjs'), `
    import { startOnboardingChecks } from './background.js'
    const command = { optsWithGlobals: () => ({ apikey: 'fake-api-key' }), registeredArguments: [], args: [] }
    startOnboardingChecks(command, 'app list')
    process.stdin.resume()
    process.stdin.once('end', () => console.log('foreground-finished'))
  `)
  const child = spawn('node', [join(dir, 'run.mjs')], {
    cwd: harness.project.dir, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: '', CAPGO_DISABLE_POSTHOG: '', CAPGO_TRUSTED_API_ORIGINS: harness.api },
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = once(child, 'exit')
  const timeout = setTimeout(() => child.kill(), 5_000)
  try {
    await Promise.race([received, exited.then(() => { throw new Error('foreground exited before both workers started') })])
    const attempts = harness.requests.filter(request => request.body.event === 'scan_started')
      .map(request => request.body.nonPersonTags.attempt_id)
    assert.equal(new Set(attempts).size, 2, 'each worker must have its own attempt ID')
    child.stdin.end()
    const [code, signal] = await exited
    assert.equal(signal, null, 'background workers kept the foreground alive')
    assert.equal(code, 0)
    assert.equal(output.trim(), 'foreground-finished')
    assert.equal(errors, '')
    assert.deepEqual([...channels].sort(), ['notify-app-ready', 'updater-installed'])
  }
  finally {
    clearTimeout(timeout)
    if (child.exitCode === null)
      child.kill()
    harness.close()
  }
}, 10_000)

test('background API requests require both explicit destination trust and safe transport', () => {
  assert.equal(isTrustedOnboardingApiHost('https://api.capgo.app', {}, []), true)
  assert.equal(isTrustedOnboardingApiHost('https://api.capgo.app.example.com', {}, []), false)
  assert.equal(isTrustedOnboardingApiHost('https://api.capgo.app:8443', {}, []), false)
  assert.equal(isTrustedOnboardingApiHost('https://self-host.example.com/api', {}, []), false)
  assert.equal(isTrustedOnboardingApiHost('https://self-host.example.com/api', {}, ['https://self-host.example.com']), true)
  assert.equal(isTrustedOnboardingApiHost('http://self-host.example.com', {}, ['http://self-host.example.com']), false)
  assert.equal(isTrustedOnboardingApiHost('http://self-host.example.com/functions/v1', { supaHost: 'http://self-host.example.com', supaAnon: 'fake-anon' }, []), false)
  assert.equal(isTrustedOnboardingApiHost('https://self-host.example.com/functions/v1', { supaHost: 'https://self-host.example.com', supaAnon: 'fake-anon' }, []), true)
  assert.equal(isTrustedOnboardingApiHost('https://other.example.com', { supaHost: 'https://self-host.example.com', supaAnon: 'fake-anon' }, []), false)
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const origin = `http://${host}:12345`
    assert.equal(isTrustedOnboardingApiHost(origin, {}, []), false)
    assert.equal(isTrustedOnboardingApiHost(origin, {}, [origin]), true)
    assert.equal(isTrustedOnboardingApiHost(origin, {}, [`${origin}/path`]), false)
  }
  for (const host of ['not-a-url', 'ftp://localhost', 'http://user:password@localhost', 'https://api.capgo.app?query=1', 'https://api.capgo.app#fragment'])
    assert.equal(isTrustedOnboardingApiHost(host, {}, [host]), false)
})

test.concurrent('coordinator sends no credentials to project-selected untrusted hosts', async () => {
  const harness = await workerHarness(combinedWorkerUrl)
  installUpdater(harness.project)
  try {
    await harness.run({}, { CAPGO_TRUSTED_API_ORIGINS: '' })
    assert.deepEqual(harness.requests, [], 'untrusted project config must not receive the API key')
    await harness.run({ supaHost: harness.api, supaAnon: 'fake-anon-key' }, { CAPGO_TRUSTED_API_ORIGINS: '' })
    assert.equal(harness.requests.filter(request => request.method === 'PUT').length, 2, 'explicit CLI self-host selection should still work')
  }
  finally {
    harness.close()
  }
}, 20_000)

test.concurrent('neither telemetry nor onboarding redirects can forward worker credentials to another origin', async () => {
  const forwarded = []
  const destination = createServer((request, response) => {
    forwarded.push(request.headers)
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}')
  })
  destination.listen(0, '127.0.0.1')
  await once(destination, 'listening')
  try {
    for (const worker of [workerUrl, updaterWorkerUrl]) {
      const harness = await workerHarness(worker)
      installUpdater(harness.project)
      harness.behavior.redirectLocation = `http://127.0.0.1:${destination.address().port}`
      try {
        harness.behavior.events = 'redirect'
        await harness.run()
        assert.equal(harness.requests.filter(request => request.method === 'PUT').length, 1, 'failed telemetry must not prevent reporting')
        harness.behavior.events = 'ok'
        harness.behavior.putRedirect = true
        await harness.run()
        assert.equal(harness.requests.at(-1).body.nonPersonTags.todo_report_status, 'failed')
        assert.deepEqual(forwarded, [], 'custom capgkey headers must never follow a redirect')
      }
      finally {
        harness.close()
      }
    }
  }
  finally {
    destination.closeAllConnections()
    destination.close()
  }
}, 20_000)

afterAll(() => {
  for (const root of fixtures)
    rmSync(root, { recursive: true, force: true })
})
