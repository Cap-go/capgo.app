#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProgress, saveProgress } from '../src/build/onboarding/progress.ts'
import { getIosResumeStep } from '../src/build/onboarding/ios/progress.ts'
import { getAndroidResumeStep, loadAndroidProgress, saveAndroidProgress } from '../src/build/onboarding/android/progress.ts'
import { readBuilderOnlyAssignment, readBuilderOnlyInitAssignment, tryBuilderOnlyInit, resolveBuilderChecklistPlatform } from '../src/init/builder-setup.ts'

const appId = 'com.example.builder'
const setup = { todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'], selected_path: 'builder', selected_builder_platform: 'android', steps: { builder: { ios: {}, android: {} } } }
const options = { apikey: 'test-key', apiHost: 'http://localhost:54321/functions/v1', analytics: true }
const requests = []
const request = async (route, opts) => {
  requests.push({ route, opts })
  return { data: { app_id: appId, onboarding: { setup } }, error: null }
}
const calls = []
assert.equal(await tryBuilderOnlyInit(appId, options, {
  request, beforeLaunch: async () => calls.push('cleanup'),
  launch: async opts => calls.push(opts),
}), true)
assert.deepEqual(calls, ['cleanup', { ...options, appId }])
assert.equal(requests[0].route, `app/${appId}`)
assert.equal(requests[0].opts.method, 'GET', 'assignment reads do not refresh or mutate progress')
assert.equal(requests[0].opts.apikey, options.apikey)
assert.equal(requests[0].opts.apiHost, options.apiHost)
assert.ok(requests[0].opts.signal, 'assignment lookup is bounded')
const knownCalls = []
assert.equal(await tryBuilderOnlyInit(appId, options, {
  knownBuilderOnly: true,
  request: async () => assert.fail('a confirmed pending-app assignment must not be looked up again'),
  beforeLaunch: async () => knownCalls.push('cleanup'),
  launch: async opts => knownCalls.push(opts),
}), true, 'a confirmed Builder assignment must hand off without falling through to OTA')
assert.deepEqual(knownCalls, ['cleanup', { ...options, appId }])
assert.equal((await resolveBuilderChecklistPlatform(appId, options, 'ios', 'android', request)).platform, 'ios', 'explicit platform wins')
assert.equal((await resolveBuilderChecklistPlatform(appId, options, undefined, 'ios', request)).platform, 'android', 'saved platform beats native-directory inference')
assert.equal((await resolveBuilderChecklistPlatform(appId, options, undefined, undefined, request)).platform, 'android')
for (const patch of [
  { todo_list_version: 3 }, { builder_todo_list_version: '2' }, { paths: ['ota', 'builder'], ota_todo_list_version: '1' },
  { paths: ['ota'], ota_todo_list_version: '1' }, { paths: undefined }, { selected_path: undefined }, { steps: [] },
]) {
  const request = async () => ({ data: { app_id: appId, onboarding: { setup: { ...setup, ...patch } }, intent: 'builder' }, error: null })
  assert.equal(await tryBuilderOnlyInit(appId, options, { request, launch: async () => assert.fail('must keep existing setup'), beforeLaunch: async () => assert.fail('must keep existing checkpoint') }), false)
  assert.equal((await resolveBuilderChecklistPlatform(appId, options, undefined, 'ios', request)).platform, 'ios')
}
assert.equal(await readBuilderOnlyAssignment(appId, options, async () => ({ data: { app_id: 'com.example.other', onboarding: { setup } }, error: null })), null, 'response must match the requested app')
assert.equal(await readBuilderOnlyAssignment(appId, options, async () => ({ data: null, error: { context: { status: 404 } } })), null, 'new apps keep existing creation')
await assert.rejects(readBuilderOnlyAssignment(appId, options, async () => { throw new Error('offline') }), /offline/)
assert.equal((await resolveBuilderChecklistPlatform(appId, options, undefined, 'ios', async () => { throw new Error('offline') })).platform, 'ios', 'standalone build setup remains available without a checklist lookup')
assert.equal(await tryBuilderOnlyInit(undefined, options, { request: async () => assert.fail('no app to look up') }), false)
for (const request of [
  async () => { throw new Error('offline') },
  async () => { throw new DOMException('timed out', 'TimeoutError') },
  ...[401, 403, 500].map(status => async () => ({ data: null, error: { message: 'lookup failed', context: { status } } })),
]) {
  const warnings = []
  assert.equal(await tryBuilderOnlyInit(appId, options, {
    request, warn: message => warnings.push(message),
    beforeLaunch: async () => assert.fail('lookup failure must keep existing setup'),
    launch: async () => assert.fail('lookup failure must not launch Builder'),
  }), false)
  assert.equal(warnings.length, 1, 'failed optional assignment lookup explains its fallback')
  assert.match(warnings[0], /Could not check.*continuing with the existing setup/)
  const pendingWarnings = []
  assert.equal(await readBuilderOnlyInitAssignment(appId, options, request, message => pendingWarnings.push(message)), null)
  assert.equal(pendingWarnings.length, 1, 'pending-app lookup uses the same safe fallback')
}
await assert.rejects(tryBuilderOnlyInit(appId, options, {
  request, launch: async () => { throw new Error('Builder launch failed') },
}), /Builder launch failed/, 'a real Builder failure must not restart OTA setup')
console.log('Builder-only setup dispatch, exact app, platform precedence and unchanged OTA/dual setup passed')

const directory = mkdtempSync(join(tmpdir(), 'capgo-builder-only-resume-'))
try {
  const ios = { platform: 'ios', appId, startedAt: '2026-01-01T00:00:00Z', completedSteps: { credentialsSaved: true } }
  const android = { platform: 'android', appId, startedAt: '2026-01-02T00:00:00Z', completedSteps: { credentialsSaved: true } }
  await saveProgress(appId, ios, directory)
  await saveAndroidProgress(appId, android, directory)
  const iosPath = join(directory, 'onboarding', `${appId}.json`)
  const androidPath = join(directory, 'onboarding', `android-${appId}.json`)
  const files = [readFileSync(iosPath, 'utf8'), readFileSync(androidPath, 'utf8')]
  await tryBuilderOnlyInit(appId, options, { request, launch: async () => {
    const assignment = await resolveBuilderChecklistPlatform(appId, options, undefined, 'ios', request)
    assert.equal(assignment.platform, 'android')
    assert.deepEqual(await loadProgress(appId, directory), ios)
    assert.deepEqual(await loadAndroidProgress(appId, directory), android)
    assert.equal(getIosResumeStep(await loadProgress(appId, directory)), 'ask-build')
    assert.equal(getAndroidResumeStep(await loadAndroidProgress(appId, directory)), 'ask-build')
    assert.equal(assignment.checklist.steps.find(step => step.id === 'builder.android.successful_cloud_build').status, 'pending', 'local credential completion never fabricates cloud success')
  } })
  assert.deepEqual([readFileSync(iosPath, 'utf8'), readFileSync(androidPath, 'utf8')], files, 'handoff preserves both real platform checkpoints')
}
finally { rmSync(directory, { recursive: true, force: true }) }
console.log('Builder-only handoff preserves independent local checkpoints and resumes at the build confirmation gate')

// Exercise the actual bundled init command up to the existing non-TTY Builder
// guard. Startup uses simulated terminal streams; the assignment response
// restores non-TTY streams before the Builder command can launch. Every HTTP
// request is intercepted, so no native build or production write can occur.
const { spawnSync } = await import('node:child_process')
const { writeFileSync, mkdirSync } = await import('node:fs')
const fixture = mkdtempSync(join(tmpdir(), 'capgo-builder-only-init-'))
try {
  writeFileSync(join(fixture, 'capacitor.config.json'), JSON.stringify({ appId, appName: 'Builder test', webDir: 'dist' }))
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'builder-test', version: '1.0.0' }))
  writeFileSync(join(fixture, '.capgo'), 'test-key')
  mkdirSync(join(fixture, 'dist'))
  const trace = join(fixture, 'requests.jsonl')
  const preload = join(fixture, 'fetch.mjs')
  writeFileSync(preload, `
    import { appendFileSync } from 'node:fs'
    const nativeFetch = globalThis.fetch
    if (process.argv.includes('init')) {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      process.stdout.columns = 100
      process.stdout.rows = 50
      process.stdin.setRawMode = () => {}
    }
    globalThis.fetch = async (input, init) => {
      const url = input?.url ?? String(input)
      if (!url.startsWith('http') || url.includes('.wasm')) return nativeFetch(input, init)
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ url, method: init?.method ?? 'GET' }) + '\\n')
      if (url.includes('/private/config')) return Response.json({})
      if (url.includes('/private/cli/identity')) return Response.json({ userId: '00000000-0000-4000-8000-000000000001', email: 'builder@example.com' })
      if (url.includes('/private/cli/preflight')) return Response.json({ user_id: '00000000-0000-4000-8000-000000000001', org_id: 'org-1', app_id: '${appId}', trial_days_left: null, warnings: [] })
      if (url.endsWith('/app/${appId}')) {
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
        return Response.json({ app_id: '${appId}', onboarding: { setup: ${JSON.stringify(setup)} } })
      }
      if (url.includes('/private/onboarding_progress')) {
        const setup = ${JSON.stringify(setup)}
        const status = process.env.BUILDER_TEST_STATUS
        setup.steps.builder.android.successful_cloud_build = { status, ...(status === 'warning' ? { annotation: 'cloud_build_failed', annotation_type: 'warning' } : {}) }
        return Response.json({ onboarding: { setup }, hasChannel: true })
      }
      throw new Error('Unexpected HTTP request: ' + url)
    }
  `)
  const builtCli = new URL('../dist/index.js', import.meta.url).pathname
  const child = spawnSync('node', ['--import', preload, builtCli, 'init', '--no-analytics', '--api-host', options.apiHost], {
    cwd: fixture, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CAPGO_TOKEN: 'test-key', CAPGO_DISABLE_TELEMETRY: '1', CAPGO_DISABLE_POSTHOG: '1', CI: '1' },
  })
  const output = child.stdout + child.stderr
  assert.equal(child.status, 1, output)
  assert.match(output, /build init.*requires an interactive terminal/, 'bundled init hands Builder-only apps to the real Builder command')
  const requests = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(requests.some(item => item.url.endsWith(`/app/${appId}`) && item.method === 'GET'))
  assert.ok(requests.every(item => item.method === 'GET' || item.url.includes('/private/cli/identity')), JSON.stringify(requests))
  assert.equal(readFileSync(join(fixture, '.capgo'), 'utf8'), 'test-key')
  assert.deepEqual(JSON.parse(readFileSync(join(fixture, 'capacitor.config.json'), 'utf8')), { appId, appName: 'Builder test', webDir: 'dist' }, 'no OTA config edits before the handoff')
  for (const status of ['pending', 'warning', 'done']) {
    const todo = spawnSync('node', ['--import', preload, builtCli, 'app', 'todo', appId, '-a', options.apikey, '--api-host', options.apiHost], {
      cwd: fixture, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, BUILDER_TEST_STATUS: status, CAPGO_DISABLE_TELEMETRY: '1', CAPGO_DISABLE_POSTHOG: '1', CI: '1' },
    })
    const output = todo.stdout + todo.stderr
    assert.equal(todo.status, 0, output)
    assert.match(output, /Builder checklist/)
    assert.match(output, /Android \(selected\)/)
    assert.match(output, new RegExp(`${status === 'done' ? '\\[x\\] Done' : status === 'warning' ? '\\[!\\] Warning' : '\\[ \\] Pending'}: Run a successful cloud build`))
    if (status === 'warning') assert.match(output, /Cloud build failed/)
    assert.doesNotMatch(output, /Create a channel|Install Capgo Updater/)
  }

}
finally { rmSync(fixture, { recursive: true, force: true }) }
console.log('Actual bundled init hands off Builder-only apps before OTA edits or progress writes')
