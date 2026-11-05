import assert from 'node:assert/strict'
import { test } from 'bun:test'
import FakeTimers from '@sinonjs/fake-timers'
import { readSetupProgress, SETUP_PROGRESS_TIMEOUT_MS } from '../src/onboarding/setup-notice-evaluation.ts'

const prepared = { project: { appId: 'com.example.request' }, apikey: 'fake-key', apiHost: 'https://api.example.com' }
test('the sole progress request explicitly asks for billing and sends the API key as both auth headers', async () => {
  const nativeFetch = globalThis.fetch
  const data = { onboarding: { setup: { todo_list_version: 4 } }, billing: { status: 'unavailable' } }
  try {
    let calls = 0
    globalThis.fetch = async (url, init) => {
      calls++
      assert.equal(url, prepared.apiHost + '/private/onboarding_progress')
      assert.equal(init.redirect, 'manual')
      assert.equal(init.headers.capgkey, prepared.apikey)
      assert.equal(init.headers.Authorization, prepared.apikey)
      assert.deepEqual(JSON.parse(init.body), { appId: prepared.project.appId, N: 0, initial: true, includeBilling: true })
      return Response.json(data)
    }
    assert.deepEqual(await readSetupProgress(prepared), data)
    assert.equal(calls, 1, 'no config, owner, Stripe or billing RPC fan-out')
  }
  finally { globalThis.fetch = nativeFetch }
})
test('denied, malformed and unavailable progress cannot fail the foreground command', async () => {
  const nativeFetch = globalThis.fetch
  try {
    for (const response of [Response.json({}, { status: 403 }), Response.json({}), new Response('invalid JSON')]) {
      globalThis.fetch = async () => response
      assert.equal(await readSetupProgress(prepared), undefined)
    }
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal(await readSetupProgress(prepared), undefined)
  }
  finally { globalThis.fetch = nativeFetch }
})
test('a request that ignores abort still ends at its timeout and aborts its signal', async () => {
  const nativeFetch = globalThis.fetch
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  let signal
  try {
    globalThis.fetch = async (_url, init) => {
      signal = init.signal
      return new Promise(() => {})
    }
    let finished = false
    const task = readSetupProgress(prepared).then(value => { finished = true; return value })
    await clock.tickAsync(SETUP_PROGRESS_TIMEOUT_MS - 1)
    assert.equal(finished, false)
    await clock.tickAsync(1)
    assert.equal(await task, undefined)
    assert.equal(signal.aborted, true)
  }
  finally { clock.uninstall(); globalThis.fetch = nativeFetch }
})

test('a superseded snapshot cancels promptly even if fetch ignores abort', async () => {
  const nativeFetch = globalThis.fetch
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const controller = new AbortController()
  let signal
  try {
    globalThis.fetch = async (_url, init) => { signal = init.signal; return new Promise(() => {}) }
    let finished = false
    const task = readSetupProgress(prepared, controller.signal).then(value => { finished = true; return value })
    controller.abort()
    await clock.tickAsync(0)
    assert.equal(finished, true)
    assert.equal(await task, undefined)
    assert.equal(signal.aborted, true)
  }
  finally { clock.uninstall(); globalThis.fetch = nativeFetch }
})
