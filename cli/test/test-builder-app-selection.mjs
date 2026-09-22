#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import React from 'react'
import stringWidth from 'string-width'
import { AppSelectionError, createBuilderAppSelectionServices, getAppSelectionSuggestion, listVisibleBuilderApps, rankVisibleApps, verifyBuilderApp } from '../src/build/onboarding/app-selection.ts'
import BuilderAppSelectionGate from '../src/build/onboarding/ui/app-selection-gate.tsx'

assert.deepEqual(getAppSelectionSuggestion({
  appId: 'com.example.native',
  plugins: { CapgoBuilder: { capgoBuilderAppId: 'com.example.cloud' } },
}), { appId: 'com.example.cloud', source: 'builder' })

assert.deepEqual(getAppSelectionSuggestion({
  appId: 'com.example.native',
  plugins: { CapacitorUpdater: { appId: 'com.example.ota' } },
}), { appId: 'com.example.native', source: 'capacitor' })

const apps = [
  { app_id: 'com.example.forecast', name: 'Forecast' },
  { app_id: 'com.other.weather', name: 'Other' },
  { app_id: 'com.example.weather.beta', name: 'Weather Beta' },
  { app_id: 'com.example.weather.dev', name: 'Weather Preview' },
]
assert.deepEqual(rankVisibleApps(apps, 'com.example.weather').slice(0, 3).map(app => app.app_id), [
  'com.example.weather.dev',
  'com.example.weather.beta',
  'com.example.forecast',
])
assert.equal(createBuilderAppSelectionServices({ supaHost: 'https://example.invalid' }).dashboardUrl, '', 'custom API hosts cannot use the hosted Dashboard')

console.log('Builder app suggestion and similarity passed')

{
  const paths = []
  const page = Array.from({ length: 50 }, (_, index) => ({ app_id: `com.example.app${index}`, name: `App ${index}` }))
  const result = await listVisibleBuilderApps('test-key', { supaHost: 'https://example.invalid', supaAnon: 'anon-test' }, async (path, options) => {
    paths.push({ path, options })
    return { data: path.endsWith('page=0') ? page : [{ app_id: 'com.example.last', name: 'Last' }], error: null }
  })
  assert.equal(result.length, 51)
  assert.deepEqual(paths.map(item => item.path), ['app?page=0', 'app?page=1'])
  assert.ok(paths.every(item => item.options.apikey === 'test-key' && item.options.supaHost === 'https://example.invalid' && item.options.supaAnon === 'anon-test'))
  await assert.rejects(listVisibleBuilderApps('test-key', {}, async path => path.endsWith('page=0')
    ? { data: page, error: null }
    : { data: null, error: new Error('page failed') }), error => error instanceof AppSelectionError && error.code === 'list')
}

{
  const calls = []
  const request = async (path) => {
    calls.push(path)
    return { data: { app_id: 'com.example.weather', name: 'Weather' }, error: null }
  }
  const createClient = async () => ({ rpc: async (name, args) => {
    calls.push({ name, args })
    return { data: true, error: null }
  } })
  await verifyBuilderApp('test-key', 'com.example.weather', {}, { request, createClient })
  assert.equal(calls[0], 'app/com.example.weather')
  assert.equal(calls[1].name, 'cli_check_permission')
  assert.equal(calls[1].args.permission_key, 'app.build_native')
  assert.equal(calls[1].args.app_id, 'com.example.weather')
  await assert.rejects(verifyBuilderApp('test-key', 'com.example.weather', {}, {
    request,
    createClient: async () => ({ rpc: async () => ({ data: false, error: null }) }),
  }), error => error instanceof AppSelectionError && error.code === 'build')
  await assert.rejects(verifyBuilderApp('test-key', 'com.example.weather', {}, {
    request: async () => ({ data: null, error: Object.assign(new Error('denied'), { context: { status: 401 } }) }),
    createClient,
  }), error => error instanceof AppSelectionError && error.code === 'read')
}

console.log('Builder app pagination and permissions passed')

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

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), `Timed out waiting for ${label}`)
}

function renderGate({ visible = [], cols = 100, rows = 50, verify = async () => {}, persist = async () => false, openDashboard = async () => true } = {}) {
  const stdout = makeStream(cols, rows)
  const stdin = makeStdin()
  const selected = []
  const events = []
  const verified = []
  const saved = []
  let switched = 0
  const services = {
    list: async () => visible,
    verify: async (_key, id) => { verified.push(id); await verify(id) },
    persist: async (id) => { saved.push(id); return persist(id) },
    openDashboard,
    dashboardUrl: 'https://console.capgo.app/app/new',
  }
  const instance = render(React.createElement(BuilderAppSelectionGate, {
    apikey: 'test-key',
    suggestedId: 'com.example.weather',
    suggestedSource: 'capacitor',
    services,
    cols,
    rows,
    onSelected: id => selected.push(id),
    onSwitchKey: () => { switched++ },
    onCancel: () => {},
    onEvent: event => events.push(event),
  }), { stdout, stderr: makeStream(cols, rows), stdin, debug: true, exitOnCtrlC: false, patchConsole: false })
  return { stdout, stdin, instance, selected, events, verified, saved, switched: () => switched }
}

async function stop(ui) {
  ui.instance.unmount()
  await ui.instance.waitUntilExit()
}

{
  const ui = renderGate({ visible: [{ app_id: 'com.example.weather', name: 'Weather' }] })
  await waitFor(() => ui.selected.length === 1, 'exact match resolution')
  assert.deepEqual(ui.verified, ['com.example.weather'])
  assert.deepEqual(ui.saved, ['com.example.weather'])
  assert.ok(ui.stdout.frames.every(frame => !frame.includes('Which Capgo app should Builder use?')))
  assert.equal(ui.events.find(event => event.phase === 'resolved')?.result, 'exact_match')
  assert.equal(ui.events.some(event => event.phase === 'shown'), false, 'exact match does not show a choice screen')
  await stop(ui)
}

{
  const ui = renderGate({ visible: [{ app_id: 'com.example.weather.dev', name: 'Weather Preview' }] })
  await waitFor(() => ui.stdout.lastFrame.includes('Which Capgo app should Builder use?'), 'single app screen')
  assert.match(ui.stdout.lastFrame, /Your Capacitor app ID: com\.example\.weather/)
  assert.match(ui.stdout.lastFrame.replace(/\s+/g, ' '), /No app with this ID is available to your API key\. It may exist in Capgo, but you or your API key might lack access to it\./)
  assert.match(ui.stdout.lastFrame, /App visible to your API key:/)
  assert.match(ui.stdout.lastFrame, /Weather Preview.*com\.example\.weather\.dev/)
  assert.doesNotMatch(ui.stdout.lastFrame, /Select a different app/)
  assert.deepEqual(ui.selected, [])
  await new Promise(resolve => setTimeout(resolve, 100))
  ui.stdin.send('\r')
  await waitFor(() => ui.selected.length === 1, 'explicit single app selection')
  assert.deepEqual(ui.selected, ['com.example.weather.dev'])
  await stop(ui)
}

{
  const ui = renderGate({ visible: apps })
  await waitFor(() => ui.stdout.lastFrame.includes('Select a different app'), 'multiple app screen')
  assert.match(ui.stdout.lastFrame, /Weather Preview.*com\.example\.weather\.dev/)
  assert.match(ui.stdout.lastFrame, /Weather Beta.*com\.example\.weather\.beta/)
  assert.doesNotMatch(ui.stdout.lastFrame, /com\.other\.weather/)
  await new Promise(resolve => setTimeout(resolve, 100))
  for (let index = 0; index < 3; index++) {
    ui.stdin.send('j')
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  ui.stdin.send('\r')
  await waitFor(() => ui.stdout.lastFrame.includes('Search visible apps:'), 'full visible-app list')
  ui.stdin.send('other')
  await waitFor(() => ui.stdout.lastFrame.includes('com.other.weather'), 'full-list search')
  ui.stdin.send('\r')
  await waitFor(() => ui.selected.length === 1, 'full-list app selection')
  assert.deepEqual(ui.selected, ['com.other.weather'])
  await stop(ui)
}

{
  const ui = renderGate()
  await waitFor(() => ui.stdout.lastFrame.includes('No apps are visible to this API key'), 'zero apps screen')
  assert.doesNotMatch(ui.stdout.lastFrame, /Select a different app/)
  assert.match(ui.stdout.lastFrame, /Log in with another API key/)
  await stop(ui)
}

{
  const visible = []
  let opened = 0
  const ui = renderGate({ visible, openDashboard: async () => { opened++; return false } })
  await waitFor(() => ui.stdout.lastFrame.includes('No apps are visible to this API key'), 'empty list before Dashboard')
  await new Promise(resolve => setTimeout(resolve, 100))
  ui.stdin.send('j')
  await new Promise(resolve => setTimeout(resolve, 30))
  ui.stdin.send('\r')
  await waitFor(() => ui.stdout.lastFrame.includes('Open this URL in your browser'), 'Dashboard URL fallback')
  assert.equal(opened, 1)
  visible.push({ app_id: 'com.example.weather', name: 'Weather' })
  ui.stdin.send('\r')
  await waitFor(() => ui.selected.length === 1, 'Dashboard-created app recheck')
  assert.deepEqual(ui.selected, ['com.example.weather'])
  await stop(ui)
}

{
  const ui = renderGate({
    visible: [{ app_id: 'com.example.weather.dev', name: 'Weather Preview' }],
    verify: async () => { throw new AppSelectionError('build', 'This API key needs app.build_native permission.') },
  })
  await waitFor(() => ui.stdout.lastFrame.includes('Which Capgo app should Builder use?'), 'permission test picker')
  await new Promise(resolve => setTimeout(resolve, 100))
  ui.stdin.send('\r')
  await waitFor(() => ui.stdout.lastFrame.includes('This API key needs app.build_native'), 'permission recovery')
  assert.deepEqual(ui.selected, [])
  assert.equal(ui.events.find(event => event.phase === 'error')?.result, 'build')
  await stop(ui)
}

{
  const ui = renderGate({ visible: [{ app_id: 'com.example.weather.dev', name: 'Weather Preview' }], cols: 44, rows: 11 })
  await waitFor(() => ui.stdout.lastFrame.includes('App visible to your API key'), 'compact app screen')
  assert.ok(ui.stdout.lastFrame.split('\n').length <= 11, 'compact app screen fits the terminal height')
  assert.ok(ui.stdout.lastFrame.split('\n').every(line => stringWidth(line) <= 44), 'compact app screen fits terminal width')
  await stop(ui)
}

console.log('Builder app selection gate passed')
