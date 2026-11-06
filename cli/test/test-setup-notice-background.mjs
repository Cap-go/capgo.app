import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'bun:test'

const appId = 'com.example.parallel'
const workerUrl = new URL('../dist/onboarding-worker.js', import.meta.url)
const ids = ['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'run_device', 'upload_bundle', 'test_update']
const progress = () => ({
  onboarding: { setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], steps: { ota: Object.fromEntries(ids.map(id => [id, { status: ['add_code', 'add_updater'].includes(id) ? 'pending' : 'done' }])) } } },
  billing: { status: 'available', orgId: '00000000-0000-4000-8000-000000000001', trialEndsAt: '2030-01-01T00:00:00Z', isPaying: false, hasCredits: false },
})

async function run({ putStatus = 200, command = 'bundle list', mutation = false, debug = false } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'capgo-parallel-notice-'))
  let child
  let releaseProgress
  let releasePuts
  let putsReady
  const progressArrived = new Promise(resolve => { releaseProgress = resolve })
  const putsArrived = new Promise(resolve => { releasePuts = resolve })
  const bothPuts = new Promise(resolve => { putsReady = resolve })
  const requests = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ path: request.url, body, method: request.method })
    if (request.url.endsWith('/private/events')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      return
    }
    assert.equal(request.headers.capgkey, 'fake-key')
    assert.equal(request.headers.authorization, 'fake-key')
    if (request.url.endsWith('/private/onboarding_progress')) {
      const readNumber = requests.filter(entry => entry.path.endsWith('/private/onboarding_progress')).length
      assert.deepEqual(body, { appId, N: 0, initial: true, includeBilling: true })
      releaseProgress()
      // A serial implementation cannot satisfy these two cross-dependent gates.
      await putsArrived
      if (mutation && readNumber === 1)
        return // A slow initial snapshot must not delay the post-command refresh.
      const data = progress()
      if (mutation && readNumber > 1)
        data.onboarding.setup.steps.ota.run_device = { status: 'pending' }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
      return
    }
    assert.equal(request.url, `/app/${appId}`)
    assert.equal(request.method, 'PUT')
    const puts = requests.filter(entry => entry.method === 'PUT')
    if (puts.length === 2) {
      putsReady()
      releasePuts()
    }
    await progressArrived
    response.writeHead(putStatus, { 'Content-Type': 'application/json' }).end('{}')
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const api = `http://127.0.0.1:${server.address().port}`
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'parallel-notice', dependencies: { '@capgo/capacitor-updater': '8.0.0' } }))
    writeFileSync(join(fixture, 'capacitor.config.json'), JSON.stringify({ appId, appName: 'Parallel', webDir: 'dist' }))
    mkdirSync(join(fixture, 'src'))
    writeFileSync(join(fixture, 'src/main.ts'), "import { CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater.notifyAppReady()")
    mkdirSync(join(fixture, 'node_modules/@capgo/capacitor-updater'), { recursive: true })
    writeFileSync(join(fixture, 'node_modules/@capgo/capacitor-updater/package.json'), JSON.stringify({ name: '@capgo/capacitor-updater', version: '8.0.0' }))
    const data = { cwd: fixture, command, appId, apikey: 'fake-key', apiHost: api, setupNotice: true }
    const runner = `
      import { Worker } from 'node:worker_threads'
      const worker = new Worker(new URL(${JSON.stringify(workerUrl.href)}), { workerData: ${JSON.stringify(data)}, execArgv: [] })
      worker.on('message', message => console.log(JSON.stringify(message)))
      worker.on('error', error => { console.error(error); process.exitCode = 1 })
      ${mutation ? `process.stdin.once('data', () => worker.postMessage({ type: 'command-succeeded' }))` : ''}
      worker.on('exit', code => process.exit(code))
    `
    child = spawn('node', ['--input-type=module', '-e', runner], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CAPGO_DISABLE_TELEMETRY: '', CAPGO_DISABLE_POSTHOG: '', CAPGO_SETUP_DEBUG: debug ? '1' : '' } })
    let output = ''
    let errors = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { errors += value })
    const exited = once(child, 'exit')
    await Promise.race([bothPuts, delay(5000)])
    assert.equal(await Promise.race([progressArrived.then(() => true), delay(3000).then(() => false)]), true, 'onboarding progress must start while both local PUT reports are blocked')
    if (mutation) {
      child.stdin.write('succeeded')
    }
    const result = await Promise.race([exited, delay(5000).then(() => ['timeout'])])
    assert.equal(result[0], 0, errors)
    const notices = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(message => message.type === 'setup-notice').map(message => message.notice)
    const diagnostics = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(message => message.type === 'setup-debug').map(message => message.line).join('\n')
    return { notices, requests, diagnostics }
  }
  finally {
    releaseProgress()
    releasePuts()
    child?.kill()
    server.closeAllConnections()
    server.close()
    rmSync(fixture, { recursive: true, force: true })
  }
}

test('progress/billing and both scanners run independently and reconcile successful reports without another read', async () => {
  const { notices, requests } = await run()
  assert.equal(requests.filter(entry => entry.path.endsWith('/private/onboarding_progress')).length, 1)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, 'plan', 'both reported milestones must be included in the early snapshot')
}, 15000)

test('rejected scanner reports never count as completed work', async () => {
  const { notices } = await run({ putStatus: 403 })
  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, 'setup')
  assert.equal(notices[0].title, 'Install Capgo Updater')
}, 15000)

test('a mutating command refreshes after success without waiting for the initial request', async () => {
  const { notices, requests } = await run({ command: 'bundle upload', mutation: true })
  assert.equal(requests.filter(entry => entry.path.endsWith('/private/onboarding_progress')).length, 2)
  assert.equal(notices[0].kind, 'setup')
  assert.equal(notices[0].title, 'Run your app on a device')
}, 15000)


test('diagnostics relay both scanner threads and the request result without credentials', async () => {
  const { diagnostics, notices } = await run({ debug: true })
  assert.match(diagnostics, /progress request started/)
  assert.match(diagnostics, /progress response received.*status=200/)
  assert.match(diagnostics, /local scan finished.*scan=add_code.*result=found/)
  assert.match(diagnostics, /local scan finished.*scan=add_updater.*result=found/)
  assert.match(diagnostics, /notice ready.*kind=plan/)
  assert.doesNotMatch(diagnostics, /fake-key|fixture-org|com\.example/)
  assert.equal(notices.length, 1)
}, 15000)
