#!/usr/bin/env node

import assert from 'node:assert/strict'

console.log('🧪 Testing native build cancellation...\n')

const cancellation = await import('../src/build/cancellation.ts').catch(() => null)

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

await test('ignores an immediate duplicate SIGINT while cancellation is in flight', async () => {
  assert.ok(cancellation, 'build cancellation helper has not been implemented')

  let resolveCancellation
  const pendingCancellation = new Promise((resolve) => {
    resolveCancellation = resolve
  })
  let now = 1_000
  let started = 0
  let aborted = 0
  let forcedExits = 0

  const onSigint = cancellation.createBuildCancellationSignalHandler({
    requestCancellation: async () => pendingCancellation,
    onCancellationStarted: () => { started += 1 },
    onCancellationResult: () => {},
    abortLogStream: () => { aborted += 1 },
    forceExit: () => { forcedExits += 1 },
    now: () => now,
  })

  const firstSignal = onSigint()
  await Promise.resolve()
  now += 1
  await onSigint()

  assert.equal(started, 1, 'only the first signal starts cancellation')
  assert.equal(forcedExits, 0, 'the duplicate signal must not force-exit the process')
  assert.equal(aborted, 0, 'log streaming stays active until cancellation settles')

  resolveCancellation({ ok: true })
  await firstSignal

  assert.equal(aborted, 1, 'log streaming stops after cancellation settles')
})

await test('reports a rejected cancellation response instead of treating it as success', async () => {
  assert.equal(typeof cancellation?.requestBuildCancellation, 'function', 'cancellation request helper has not been implemented')

  const result = await cancellation.requestBuildCancellation({
    url: 'https://api.capgo.app/build/cancel/job_test',
    headers: { authorization: 'test-key' },
    appId: 'com.demo.app',
    fetchImpl: async () => new Response(null, { status: 401, statusText: 'Unauthorized' }),
  })

  assert.deepEqual(result, {
    ok: false,
    message: 'Build cancellation request failed: HTTP 401 Unauthorized',
  })
})

await test('allows a later SIGINT to force-quit a stuck cancellation', async () => {
  let now = 1_000
  let forcedExitCode = null

  const onSigint = cancellation.createBuildCancellationSignalHandler({
    requestCancellation: async () => new Promise(() => {}),
    onCancellationStarted: () => {},
    onCancellationResult: () => {},
    abortLogStream: () => {},
    forceExit: (code) => { forcedExitCode = code },
    now: () => now,
    duplicateSignalWindowMs: 500,
  })

  void onSigint()
  now += 501
  await onSigint()

  assert.equal(forcedExitCode, 1)
})

await test('sends the cancellation request with the app id and reports success', async () => {
  let capturedUrl = null
  let capturedInit = null

  const result = await cancellation.requestBuildCancellation({
    url: 'https://api.capgo.app/build/cancel/job_test',
    headers: { authorization: 'test-key' },
    appId: 'com.demo.app',
    fetchImpl: async (url, init) => {
      capturedUrl = url
      capturedInit = init
      return new Response(null, { status: 200 })
    },
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(capturedUrl, 'https://api.capgo.app/build/cancel/job_test')
  assert.equal(capturedInit.method, 'POST')
  assert.equal(capturedInit.body, JSON.stringify({ app_id: 'com.demo.app' }))
})

if (failures > 0) {
  console.error(`\n❌ ${failures} build cancellation test(s) failed`)
  process.exit(1)
}

console.log('\n✅ Native build cancellation behaves correctly')
