#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import React from 'react'
import { resolveBuilderCandidateKey } from '../src/build/onboarding/login.ts'
import BuilderLoginGate from '../src/build/onboarding/ui/login-gate.tsx'

const previousToken = process.env.CAPGO_TOKEN
try {
  process.env.CAPGO_TOKEN = 'env-test-key'
  assert.equal(resolveBuilderCandidateKey(' explicit-test-key '), 'explicit-test-key')
  assert.equal(resolveBuilderCandidateKey('   '), 'env-test-key')
  assert.equal(resolveBuilderCandidateKey(), 'env-test-key')
}
finally {
  if (previousToken === undefined)
    delete process.env.CAPGO_TOKEN
  else
    process.env.CAPGO_TOKEN = previousToken
}

console.log('Builder candidate key precedence passed')

function makeStream(cols = 100, rows = 50) {
  const stream = new EventEmitter()
  stream.columns = cols
  stream.rows = rows
  stream.isTTY = true
  stream.lastFrame = ''
  stream.frames = []
  stream.write = (frame) => {
    stream.lastFrame = String(frame)
    stream.frames.push(stream.lastFrame)
    return true
  }
  return stream
}

function makeStdin() {
  const stream = new EventEmitter()
  const chunks = []
  stream.isTTY = true
  stream.setEncoding = () => {}
  stream.setRawMode = () => {}
  stream.resume = () => {}
  stream.pause = () => {}
  stream.ref = () => {}
  stream.unref = () => {}
  stream.read = () => chunks.shift() ?? null
  stream.send = (chunk) => {
    chunks.push(chunk)
    stream.emit('readable')
  }
  return stream
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), 'Timed out waiting for the login UI')
}

function renderGate({ cols = 100, rows = 50, candidateKey, browserAvailable = true, savePasted = async () => {}, validateExisting = async () => {}, beginBrowser = async () => ({ session: 'test-session', url: 'https://console.capgo.app/login-cli?session=test-session', browserOpened: true }), completeBrowser = async () => {} } = {}) {
  const stdout = makeStream(cols, rows)
  const stdin = makeStdin()
  const authenticated = []
  let cancelled = false
  const services = { browserAvailable, savePasted, validateExisting, beginBrowser, completeBrowser }
  const instance = render(React.createElement(BuilderLoginGate, {
    candidateKey,
    services,
    cols,
    rows,
    onAuthenticated: (key, metadata) => authenticated.push({ key, metadata }),
    onCancel: () => { cancelled = true },
  }), { stdout, stderr: makeStream(cols, rows), stdin, debug: true, exitOnCtrlC: false, patchConsole: false })
  return { stdout, stdin, authenticated, wasCancelled: () => cancelled, instance }
}

{
  const ui = renderGate()
  await waitFor(() => ui.stdout.lastFrame.includes('How would you like to log in?'))
  assert.match(ui.stdout.lastFrame, /Create key in Dashboard/)
  assert.match(ui.stdout.lastFrame, /Use an existing key/)
  ui.instance.unmount()
}

{
  const submitted = []
  const ui = renderGate({
    cols: 44,
    rows: 11,
    browserAvailable: false,
    savePasted: async key => submitted.push(key),
  })
  await waitFor(() => ui.stdout.lastFrame.includes('Paste the API key'))
  assert.doesNotMatch(ui.stdout.lastFrame, /[╭╮╰╯]/u, 'small input must be unboxed')
  const key = '12345678-1234-1234-1234-123456789abc'
  ui.stdin.send(key)
  await waitFor(() => ui.stdout.lastFrame.includes('••••'))
  ui.stdin.send('\r')
  await waitFor(() => ui.authenticated.length === 1)
  assert.deepEqual(submitted, [key])
  assert.equal(ui.authenticated[0].metadata.method, 'paste')
  assert.ok(ui.stdout.lastFrame.length < 2000)
  ui.instance.unmount()
}

console.log('Builder Ink login screen passed')

{
  const ui = renderGate({ candidateKey: 'existing-key' })
  await waitFor(() => ui.authenticated.length === 1)
  assert.equal(ui.authenticated[0].key, 'existing-key')
  assert.equal(ui.authenticated[0].metadata.method, undefined)
  assert.ok(ui.stdout.frames.every(frame => !frame.includes('How would you like to log in?')))
  ui.instance.unmount()
}

{
  let openings = 0
  const completed = []
  const ui = renderGate({
    beginBrowser: async (onUrl) => {
      openings++
      const session = { session: 'test-session', url: 'https://console.capgo.app/login-cli?session=test-session', browserOpened: false }
      onUrl(session.url)
      return session
    },
    completeBrowser: async (_session, key) => {
      completed.push(key)
      if (completed.length === 1)
        throw new Error('invalid test key')
    },
  })
  await waitFor(() => ui.stdout.lastFrame.includes('How would you like to log in?'))
  ui.stdin.send('\r')
  await waitFor(() => ui.stdout.lastFrame.includes('Open this URL in your browser:'))
  assert.match(ui.stdout.lastFrame, /╭|╮/u, 'large input should be boxed')
  ui.stdin.send('invalid-key')
  await waitFor(() => ui.stdout.lastFrame.includes('••••'))
  ui.stdin.send('\r')
  await waitFor(() => ui.stdout.lastFrame.includes('Paste another key'))
  ui.stdin.send('valid-test-key')
  await waitFor(() => ui.stdout.lastFrame.includes('••••'))
  ui.stdin.send('\r')
  await waitFor(() => ui.authenticated.length === 1)
  assert.deepEqual(completed, ['invalid-key', 'valid-test-key'])
  assert.equal(openings, 1)
  assert.equal(ui.authenticated[0].metadata.method, 'browser')
  assert.equal(ui.authenticated[0].metadata.retryCount, 1)
  assert.ok(ui.stdout.frames.every(frame => !frame.includes('invalid-key') && !frame.includes('valid-test-key')))
  ui.instance.unmount()
}

{
  const ui = renderGate()
  await waitFor(() => ui.stdout.lastFrame.includes('How would you like to log in?'))
  ui.stdin.send('\x1b')
  await waitFor(ui.wasCancelled)
  ui.instance.unmount()
}

console.log('Builder browser retry and cancellation passed')
