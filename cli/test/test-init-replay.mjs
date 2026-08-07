#!/usr/bin/env node
import assert from 'node:assert/strict'
import { stdin, stdout } from 'node:process'
import { applyCommandAnalyticsOptOut, applyRawCommandAnalyticsOptOut } from '../src/analytics/opt-out.ts'
import { buildInitReplayBody, createTerminalInteractionEvents, createTerminalSnapshot, createTerminalSnapshotNode, getReplayViewportSize, renderRedactedTerminalFrame, renderRedactedTerminalText, resolveCapgoReplayUrl, resolveReplayUrlForFlush, resolveSupabaseReplayUrl, shouldStartInitReplay, startInitReplay } from '../src/init/replay.ts'

console.log('🧪 Testing init replay telemetry...\n')

const baseGate = {
  analyticsEnabled: true,
  apikey: 'capgo-key',
  isCi: false,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  telemetryDisabled: false,
}

assert.equal(shouldStartInitReplay(baseGate), true, 'interactive init with keys starts replay')
assert.equal(shouldStartInitReplay({ ...baseGate, analyticsEnabled: false }), false, '--no-analytics disables replay')
assert.equal(shouldStartInitReplay({ ...baseGate, apikey: '' }), false, 'missing Capgo API key disables replay')
assert.equal(shouldStartInitReplay({ ...baseGate, isCi: true }), false, 'CI disables replay')
assert.equal(shouldStartInitReplay({ ...baseGate, stdinIsTTY: false }), false, 'non-interactive stdin disables replay')
assert.equal(shouldStartInitReplay({ ...baseGate, stdoutIsTTY: false }), false, 'non-interactive stdout disables replay')
assert.equal(shouldStartInitReplay({ ...baseGate, telemetryDisabled: true }), false, 'env opt-out disables replay')

assert.equal(resolveCapgoReplayUrl('https://api.capgo.app'), 'https://api.capgo.app/private/replay')
assert.equal(resolveCapgoReplayUrl('https://api.capgo.app/private/replay'), 'https://api.capgo.app/private/replay')
assert.equal(resolveCapgoReplayUrl('not a url'), undefined)
assert.equal(resolveSupabaseReplayUrl('https://self.supabase.co'), 'https://self.supabase.co/functions/v1/private/replay')
assert.equal(resolveSupabaseReplayUrl('https://self.supabase.co/functions/v1/private/replay'), 'https://self.supabase.co/functions/v1/private/replay')
assert.equal(resolveSupabaseReplayUrl('not a url'), undefined)
assert.deepEqual(getReplayViewportSize(20, 5), { height: 480, width: 800 }, 'replay viewport has readable minimum dimensions')
const resolvedReplayUrl = 'https://api.capgo.app/private/replay'
let abortedReplayLookup = false
assert.equal(await resolveReplayUrlForFlush(Promise.resolve(resolvedReplayUrl), 20, () => { abortedReplayLookup = true }), resolvedReplayUrl, 'replay URL resolves before the flush deadline')
assert.equal(abortedReplayLookup, false, 'resolved replay URL lookup is not aborted')
const replayTimeoutStartedAt = Date.now()
assert.equal(await resolveReplayUrlForFlush(new Promise(() => {}), 20, () => { abortedReplayLookup = true }), undefined, 'stalled replay URL lookup times out')
assert.equal(abortedReplayLookup, true, 'stalled replay URL lookup is aborted on timeout')
assert.ok(Date.now() - replayTimeoutStartedAt < 1000, 'stalled replay URL lookup does not block final flush')
assert.deepEqual(getReplayViewportSize(20, 5, { height: 412, width: 640 }), { height: 412, width: 640 }, 'reported terminal pixels override computed fallback size')
const pixelSizedFrame = await renderRedactedTerminalFrame('small real terminal', 20, 5, { height: 412, width: 640 })
assert.equal(pixelSizedFrame.width, 640, 'terminal frame uses reported pixel width')
assert.equal(pixelSizedFrame.height, 412, 'terminal frame uses reported pixel height')

function replaceProcessProperty(target, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, {
    configurable: true,
    value,
    writable: true,
  })
  return () => {
    if (descriptor)
      Object.defineProperty(target, key, descriptor)
    else delete target[key]
  }
}

const redacted = await renderRedactedTerminalText([
  'capg_1234567890abcdef',
  'Authorization: Bearer abcdefghijklmno.1234567890',
  '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
].join('\n'), 120, 10)
assert.match(redacted, /\[REDACTED\]/, 'redacted marker is present')
assert.doesNotMatch(redacted, /capg_1234567890abcdef/, 'Capgo API key is redacted')
assert.doesNotMatch(redacted, /abcdefghijklmno\.1234567890/, 'bearer token is redacted')
assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/, 'private key block is redacted')

const styledFrame = await renderRedactedTerminalFrame('\u001B[32mhello replay\u001B[0m\nsecond line', 120, 10)
assert.match(styledFrame.html, /color:/, 'terminal HTML keeps xterm color styles')
assert.match(styledFrame.html, /hello replay/, 'terminal HTML includes visible text')
const node = await createTerminalSnapshotNode(styledFrame)
const serializedNode = JSON.stringify(node)
const fullTerminalFrame = await renderRedactedTerminalFrame(Array.from({ length: 30 }, (_, index) => index === 29 ? 'LAST ROW MUST BE FULLY VISIBLE' : `row ${index + 1}`).join('\n'), 100, 30)
assert.equal(fullTerminalFrame.height, 632, '30-row fixture keeps the expected SVG viewport height')
const fullTerminalSnapshot = JSON.stringify(await createTerminalSnapshotNode(fullTerminalFrame))
const terminalSvgBase64 = fullTerminalSnapshot.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/)?.[1]
assert.ok(terminalSvgBase64, '30-row terminal snapshot includes an SVG image')
const terminalSvg = Buffer.from(terminalSvgBase64, 'base64').toString('utf8')
assert.match(terminalSvg, /font:14px\/20px ui-monospace/, 'terminal SVG line height matches viewport row height')
assert.match(terminalSvg, /<style>pre\{margin:0;font:inherit\}<\/style>/, 'terminal SVG removes default pre margins')
const terminalLineHeight = Number(terminalSvg.match(/font:14px\/(\d+)px/)?.[1])
const terminalPadding = Number(terminalSvg.match(/padding:(\d+)px/)?.[1])
assert.ok(Number.isFinite(terminalLineHeight), 'terminal SVG exposes a numeric line height')
assert.ok(Number.isFinite(terminalPadding), 'terminal SVG exposes numeric padding')
assert.equal(30 * terminalLineHeight + 2 * terminalPadding, fullTerminalFrame.height, 'declared row and padding budget matches the SVG viewport height')
assert.match(terminalSvg, /LAST ROW MUST BE FULLY VISIBLE/, 'terminal SVG contains the final row')
const ansiSplitSecret = await renderRedactedTerminalText('capg_1234\u001B[31m567890abcdef\u001B[0m', 120, 10)
assert.match(ansiSplitSecret, /\[REDACTED\]/, 'ANSI-normalized secret is redacted')
assert.doesNotMatch(ansiSplitSecret, /capg_1234567890abcdef/, 'ANSI-split Capgo API key is redacted after terminal normalization')
const softWrappedSecret = await renderRedactedTerminalText(`edge ${'x'.repeat(8)} capg_1234567890abcdef`, 12, 10)
assert.match(softWrappedSecret, /\[REDACTED\]/, 'soft-wrapped Capgo API key is redacted')
assert.doesNotMatch(softWrappedSecret, /capg_1234567890abcdef/, 'soft-wrapped API key is not serialized')
assert.match(serializedNode, /data-capgo-terminal/, 'snapshot includes the terminal wrapper')
assert.match(serializedNode, /hello replay/, 'snapshot includes visible terminal text')
const terminalSnapshot = await createTerminalSnapshot('hello input replay')
assert.equal(typeof terminalSnapshot.terminalNodeId, 'number', 'snapshot exposes terminal node id for input events')
assert.ok(terminalSnapshot.terminalNodeId > 0, 'terminal node id is positive')

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  enumerable: true,
  get: () => ({ userAgent: 'readonly-navigator-test' }),
})
try {
  const readonlyNavigatorSnapshot = await createTerminalSnapshot(styledFrame)
  assert.ok(readonlyNavigatorSnapshot.terminalNodeId > 0, 'snapshot works when global navigator is getter-only')
}
finally {
  if (originalNavigatorDescriptor)
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
  else delete globalThis.navigator
}

const interactionEvents = createTerminalInteractionEvents({ terminalNodeId: terminalSnapshot.terminalNodeId, text: 'hello input replay', timestamp: 456 })
assert.equal(interactionEvents.length, 2, 'terminal frame creates click and input events')
assert.equal(interactionEvents[0].type, 3, 'first interaction event is incremental')
assert.equal(interactionEvents[0].data.source, 2, 'first interaction event is mouse interaction')
assert.equal(interactionEvents[1].data.source, 5, 'second interaction event is input')
assert.equal(interactionEvents[1].data.text, 'hello input replay', 'input event carries the redacted terminal text')
const event = {
  data: {
    height: 24,
    href: 'capgo-cli://init',
    width: 80,
  },
  timestamp: 123,
  type: 4,
}
const body = buildInitReplayBody({
  events: [event],
  identifyPerson: true,
  sessionId: 'init-session-123',
  timestamp: '2026-06-16T00:00:00.000Z',
  windowId: 'window-123',
})
assert.equal(body.event, '$snapshot')
assert.equal(body.properties.$session_id, 'init-session-123')
assert.equal(body.properties.$window_id, 'window-123')
assert.equal(body.properties.$current_url, 'capgo-cli://init')
assert.equal(body.properties.$identify_person, true)
assert.deepEqual(body.properties.$snapshot_data, [event])
assert.equal(typeof body.properties.$snapshot_bytes, 'number')
assert.ok(body.properties.$snapshot_bytes > 0, 'snapshot byte size is included')
assert.doesNotMatch(JSON.stringify(body), /capgo-key/, 'Capgo API keys are not replay properties')
assert.doesNotMatch(JSON.stringify(body), /phc-token/, 'PostHog project tokens are not sent by the CLI')
assert.equal('api_key' in body, false, 'backend owns the PostHog API key')
assert.equal('distinct_id' in body, false, 'backend owns replay identity')
assert.equal('token' in body.properties, false, 'backend owns PostHog token properties')
assert.equal('$set' in body.properties, false, 'backend owns PostHog person properties')

const buildOnboardingBody = buildInitReplayBody({
  currentUrl: 'capgo-cli://build-onboarding',
  events: [event],
  sessionId: 'build-onboarding-session-123',
  timestamp: '2026-06-16T00:00:00.000Z',
  windowId: 'window-123',
})
assert.equal(buildOnboardingBody.properties.$session_id, 'build-onboarding-session-123')
assert.equal(buildOnboardingBody.properties.$current_url, 'capgo-cli://build-onboarding')

const envTarget = {}
assert.equal(applyCommandAnalyticsOptOut('init', { analytics: false }, envTarget), true)
assert.equal(envTarget.CAPGO_DISABLE_TELEMETRY, 'true')
const buildEnvTarget = {}
assert.equal(applyCommandAnalyticsOptOut('build init', { analytics: false }, buildEnvTarget), true)
assert.equal(buildEnvTarget.CAPGO_DISABLE_TELEMETRY, 'true')
assert.equal(applyCommandAnalyticsOptOut('build onboarding', { analytics: false }, {}), true)
assert.equal(applyCommandAnalyticsOptOut('bundle upload', { analytics: false }, {}), false)
assert.equal(applyCommandAnalyticsOptOut('init', { analytics: true }, {}), false)
const rawInitEnvTarget = {}
assert.equal(applyRawCommandAnalyticsOptOut(['node', 'capgo', 'init', '--no-analytics', '--bad-option'], rawInitEnvTarget), true)
assert.equal(rawInitEnvTarget.CAPGO_DISABLE_TELEMETRY, 'true')
const rawBuildEnvTarget = {}
assert.equal(applyRawCommandAnalyticsOptOut(['node', 'capgo', 'build', 'onboarding', '--no-analytics', '--bad-option'], rawBuildEnvTarget), true)
assert.equal(rawBuildEnvTarget.CAPGO_DISABLE_TELEMETRY, 'true')
assert.equal(applyRawCommandAnalyticsOptOut(['node', 'capgo', 'bundle', 'upload', '--no-analytics'], {}), false)


{
  const captured = []
  const restoreFns = []
  let cols = 80
  let rows = 24
  const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, 'columns')
  const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, 'rows')

  try {
    restoreFns.push(replaceProcessProperty(stdout, 'isTTY', true))
    restoreFns.push(replaceProcessProperty(stdin, 'isTTY', true))
    Object.defineProperty(stdout, 'columns', { configurable: true, enumerable: true, get: () => cols })
    Object.defineProperty(stdout, 'rows', { configurable: true, enumerable: true, get: () => rows })

    const rawModeCalls = []
    const terminalWrites = []
    restoreFns.push(replaceProcessProperty(stdin, 'setRawMode', (value) => {
      rawModeCalls.push(value)
      return stdin
    }))
    restoreFns.push(replaceProcessProperty(stdout, 'write', (chunk) => {
      terminalWrites.push(String(chunk))
      return true
    }))

    const replay = startInitReplay({
      apikey: 'capgo-key',
      isCi: false,
      replayUrl: 'https://api.capgo.app/private/replay',
      cols: 80,
      rows: 24,
      throttleMs: 20,
      transport: async (_url, body) => {
        captured.push(body)
        return true
      },
    })
    assert.ok(replay, 'replay starts with mocked terminal dimensions')
    assert.equal(rawModeCalls.length, 0, 'replay startup does not change stdin raw mode')
    assert.equal(terminalWrites.some(write => write.includes('\u001B[14t')), false, 'replay startup does not query terminal pixel size')

    stdout.write('before resize line\r\n')
    await new Promise(resolve => setTimeout(resolve, 80))

    cols = 100
    rows = 30
    stdout.emit('resize')
    stdout.write('after resize line\r\n')
    await new Promise(resolve => setTimeout(resolve, 80))

    await replay.finish()

    assert.ok(captured.length >= 2, 'terminal resize produces another replay snapshot')
    const metaEvents = captured.flatMap(body => body.properties.$snapshot_data.filter(event => event.type === 4))
    const resizedMeta = metaEvents.at(-1)
    assert.ok(resizedMeta, 'resize sends a fresh viewport meta event')
    assert.deepEqual(
      { height: resizedMeta.data.height, width: resizedMeta.data.width },
      getReplayViewportSize(100, 30),
      'post-resize meta uses the new terminal dimensions',
    )

    const lastInput = captured.at(-1)?.properties.$snapshot_data.find(event => event.type === 3 && event.data.source === 5)
    assert.ok(lastInput, 'post-resize snapshot includes terminal input')
    assert.match(lastInput.data.text, /after resize line/, 'post-resize snapshot reflects the redrawn frame')
    assert.doesNotMatch(lastInput.data.text, /before resize line/, 'pre-resize rows are cleared from replay after resize')
    assert.equal(rawModeCalls.length, 0, 'resize does not query stdin for pixel size while prompts may be active')
  }
  finally {
    if (columnsDescriptor)
      Object.defineProperty(stdout, 'columns', columnsDescriptor)
    else delete stdout.columns
    if (rowsDescriptor)
      Object.defineProperty(stdout, 'rows', rowsDescriptor)
    else delete stdout.rows
    while (restoreFns.length > 0)
      restoreFns.pop()()
  }
}

{
  const captured = []
  const restoreFns = []
  let cols = 80
  let rows = 24
  const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, 'columns')
  const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, 'rows')

  try {
    restoreFns.push(replaceProcessProperty(stdout, 'isTTY', true))
    restoreFns.push(replaceProcessProperty(stdin, 'isTTY', true))
    Object.defineProperty(stdout, 'columns', { configurable: true, enumerable: true, get: () => cols })
    Object.defineProperty(stdout, 'rows', { configurable: true, enumerable: true, get: () => rows })

    const replay = startInitReplay({
      apikey: 'capgo-key',
      isCi: false,
      replayUrl: 'https://api.capgo.app/private/replay',
      cols: 80,
      rows: 24,
      throttleMs: 20,
      terminalPixelSize: { height: 480, width: 800 },
      transport: async (_url, body) => {
        captured.push(body)
        return true
      },
    })
    assert.ok(replay, 'replay starts for finish/resize race test')

    stdout.write('before finish resize\r\n')
    await new Promise(resolve => setTimeout(resolve, 40))
    cols = 100
    rows = 30
    stdout.emit('resize')
    stdout.write('after finish resize\r\n')
    await replay.finish()

    const lastInput = captured.at(-1)?.properties.$snapshot_data.find(event => event.type === 3 && event.data.source === 5)
    assert.ok(lastInput, 'finish after resize produces a terminal input snapshot')
    assert.match(lastInput.data.text, /after finish resize/, 'finish applies queued resize before the forced snapshot')
    assert.doesNotMatch(lastInput.data.text, /before finish resize/, 'forced snapshot does not keep pre-resize rows')
  }
  finally {
    if (columnsDescriptor)
      Object.defineProperty(stdout, 'columns', columnsDescriptor)
    else delete stdout.columns
    if (rowsDescriptor)
      Object.defineProperty(stdout, 'rows', rowsDescriptor)
    else delete stdout.rows
    while (restoreFns.length > 0)
      restoreFns.pop()()
  }
}

{
  const captured = []
  const restoreFns = []
  let cols = 80
  let rows = 24
  let releaseStaleSend
  let staleSendStarted = false
  const staleSendGate = new Promise((resolve) => {
    releaseStaleSend = resolve
  })
  const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, 'columns')
  const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, 'rows')

  try {
    restoreFns.push(replaceProcessProperty(stdout, 'isTTY', true))
    restoreFns.push(replaceProcessProperty(stdin, 'isTTY', true))
    Object.defineProperty(stdout, 'columns', { configurable: true, enumerable: true, get: () => cols })
    Object.defineProperty(stdout, 'rows', { configurable: true, enumerable: true, get: () => rows })

    const replay = startInitReplay({
      apikey: 'capgo-key',
      isCi: false,
      replayUrl: 'https://api.capgo.app/private/replay',
      cols: 80,
      rows: 24,
      throttleMs: 10,
      terminalPixelSize: { height: 480, width: 800 },
      transport: async (_url, body) => {
        if (!staleSendStarted) {
          staleSendStarted = true
          await staleSendGate
        }
        captured.push(body)
        return true
      },
    })
    assert.ok(replay, 'replay starts for stale meta send test')

    stdout.write('before stale send\r\n')
    for (let attempt = 0; attempt < 20 && !staleSendStarted; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(staleSendStarted, true, 'first snapshot send starts before resize')

    cols = 100
    rows = 30
    stdout.emit('resize')
    stdout.write('after stale send\r\n')
    releaseStaleSend()
    await new Promise(resolve => setTimeout(resolve, 80))
    await replay.finish()

    assert.equal(captured.filter(body => body.properties.$identify_person === true).length, 1, 'only one replay snapshot requests person identification')
    assert.equal(captured[0]?.properties.$identify_person, true, 'the first queued replay snapshot requests person identification')
    assert.equal(captured.slice(1).some(body => '$identify_person' in body.properties), false, 'later replay snapshots omit person identification')

    const resizedMeta = captured.flatMap(body => body.properties.$snapshot_data.filter(event => event.type === 4))
      .find(event => event.data.width === getReplayViewportSize(100, 30).width
        && event.data.height === getReplayViewportSize(100, 30).height)
    assert.ok(resizedMeta, 'post-resize snapshot still includes fresh viewport meta after a stale send completes')
  }
  finally {
    if (columnsDescriptor)
      Object.defineProperty(stdout, 'columns', columnsDescriptor)
    else delete stdout.columns
    if (rowsDescriptor)
      Object.defineProperty(stdout, 'rows', rowsDescriptor)
    else delete stdout.rows
    while (restoreFns.length > 0)
      restoreFns.pop()()
  }
}


console.log('✅ init replay telemetry tests passed')
