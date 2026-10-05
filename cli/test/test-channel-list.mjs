#!/usr/bin/env node
process.env.CAPGO_DISABLE_POSTHOG = '1'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAppExists, checkAppExistsAndHasPermissionOrgErr } from '../src/api/app.ts'
import { displayChannels, formatChannels, getActiveChannels } from '../src/api/channels.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { visibleWidth } from '../src/terminal-table.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'

const appId = 'com.example.channel.list'
const options = { apikey: 'test-channel-list-key', supaHost: 'http://localhost:54321', supaAnon: 'test-anon-key', silent: true }
const originalFetch = globalThis.fetch
const calls = []
let responseStatus = 200
let responseBody = { app_id: appId }
const httpChannel = {
  id: 1, name: 'production', public: true, ios: true, android: false,
  disableAutoUpdate: 'major', disableAutoUpdateUnderNative: true,
  allow_device_self_set: true, allow_emulator: false, allow_device: true,
  allow_dev: false, allow_prod: true, version: null,
}
const supabase = {
  supabaseUrl: options.supaHost,
  supabaseKey: options.supaAnon,
  rpc(name) {
    assert.equal(name, 'cli_check_permission')
    return Promise.resolve({ data: false, error: null })
  },
}

globalThis.fetch = async (input) => {
  calls.push(String(input))
  return new Response(JSON.stringify(responseBody), {
    status: responseStatus,
    headers: { 'Content-Type': 'application/json' },
  })
}

function permissionError(permission) {
  return (error) => {
    assert.ok(error instanceof CliUserError)
    assert.match(error.message, new RegExp(permission.replaceAll('.', '\\.')))
    assert.doesNotMatch(error.message, /non-2xx|not found|upload/)
    assert.equal(error.context.appId, appId)
    assert.equal(shouldCapturePosthogException(error), false)
    return true
  }
}

try {
  for (const status of [401, 403]) {
    responseStatus = status
    responseBody = { error: 'cannot_access_app', message: "You can't access this app" }
    await assert.rejects(() => checkAppExists(options.apikey, appId, options), permissionError('app.read'))
    await assert.rejects(
      () => checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.read_channels', true, true),
      permissionError('app.read'),
    )
  }

  responseStatus = 200
  responseBody = { app_id: appId }
  await assert.rejects(
    () => checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.read_channels', true, true),
    permissionError('app.read_channels'),
  )

  responseStatus = 404
  assert.equal(await checkAppExists(options.apikey, appId, options), false)

  for (const status of [400, 401, 403]) {
    responseStatus = status
    responseBody = { error: 'cannot_access_app', message: "You can't access this app" }
    await assert.rejects(() => getActiveChannels(options, appId), permissionError('app.read_channels'))
  }

  responseStatus = 500
  responseBody = { error: 'database_unavailable', message: 'Please retry later' }
  await assert.rejects(() => getActiveChannels(options, appId), (error) => {
    assert.ok(!(error instanceof CliUserError))
    assert.match(error.message, /Cannot list channels: database_unavailable \| Please retry later/)
    assert.doesNotMatch(error.message, /not found|non-2xx/)
    return true
  })
  await assert.rejects(() => checkAppExists(options.apikey, appId, options), /database_unavailable \| Please retry later/)

  responseStatus = 200
  responseBody = [httpChannel]
  const channels = await getActiveChannels(options, appId)
  assert.equal(channels[0].ios, true)
  assert.equal(channels[0].android, false)
  assert.equal(channels[0].version, undefined)
  assert.equal(channels[0].disable_auto_update, 'major')
  assert.equal(channels[0].disable_auto_update_under_native, true)
  assert.ok(calls.some(url => url.includes('/channel?app_id=com.example.channel.list&page=0')))

  responseBody = httpChannel
  const singleChannel = await getActiveChannels(options, appId)
  assert.equal(singleChannel.length, 1, 'preserves a single-channel object response')
  assert.equal(singleChannel[0].name, 'production')
  assert.equal(singleChannel[0].ios, true)
  assert.equal(singleChannel[0].android, false)

  const input = [...channels, { ...channels[0], id: 2, name: '测试', version: { name: '1.2.3' } }]
  const wide = formatChannels(input, 240)
  const lines = wide.split('\n')
  assert.equal(new Set(lines.map(visibleWidth)).size, 1, 'all table lines have equal visible width')
  const borders = lines.filter(line => line.startsWith('│')).map(line => {
    const positions = []
    for (let index = 0; index < line.length; index++) {
      if (line[index] === '│')
        positions.push(visibleWidth(line.slice(0, index)))
    }
    return positions
  })
  for (const positions of borders)
    assert.deepEqual(positions, borders[0], 'header and data column borders align')
  assert.match(wide, /Unlinked/)
  assert.doesNotMatch(wide, /✅|❌|undefined|null/)
  assert.ok(wide.indexOf('测试') < wide.indexOf('production'), 'preserves display order')
  assert.equal(input[0].name, 'production', 'does not mutate channel order')

  const narrow = formatChannels(channels, 80)
  assert.ok(narrow.split('\n').every(line => visibleWidth(line) <= 80))
  assert.match(narrow, /Setting.*Value/)
  assert.match(narrow, /iOS\s+│ Yes/)
  assert.match(narrow, /Android\s+│ No/)
  assert.match(narrow, /Updates Under Native\s+│ No/)
  const longName = 'a'.repeat(150)
  const wrapped = formatChannels([{ ...channels[0], name: longName }], 80)
  assert.ok(wrapped.split('\n').every(line => visibleWidth(line) <= 80), 'long values wrap in narrow terminals')
  assert.equal(formatChannels([]), 'No channels found.')
  displayChannels(channels, true)

  responseBody = Array.from({ length: 50 }, (_, id) => ({ ...httpChannel, id }))
  let pages = 0
  globalThis.fetch = async (input) => {
    assert.equal(new URL(String(input)).searchParams.get('page'), String(pages))
    return Response.json(pages++ === 0 ? responseBody : [{ ...httpChannel, id: 50 }])
  }
  assert.equal((await getActiveChannels(options, appId)).length, 51)
  assert.equal(pages, 2)

  console.log('Channel list permission, output, platform settings, and pagination tests passed')
}
finally {
  globalThis.fetch = originalFetch
}

const fixture = mkdtempSync(join(tmpdir(), 'capgo-channel-list-'))
try {
  const preload = join(fixture, 'fetch.mjs')
  writeFileSync(preload, `
    const nativeFetch = globalThis.fetch
    const scenario = process.env.CAPGO_CHANNEL_LIST_SCENARIO
    globalThis.fetch = async (input) => {
      const url = input?.url ?? String(input)
      if (!url.startsWith('http') || url.includes('.wasm'))
        return nativeFetch(input)
      if (url.includes('/private/config'))
        return Response.json({})
      if (url.includes('/rpc/reject_access_due_to_2fa_for_app'))
        return Response.json(false)
      if (url.includes('/rpc/cli_check_permission'))
        return Response.json(scenario !== 'denied-channel')
      if (url.includes('/app/' + ${JSON.stringify(appId)})) {
        if (scenario === 'denied-app')
          return Response.json({ error: 'cannot_access_app' }, { status: 401 })
        return Response.json({ app_id: ${JSON.stringify(appId)}, owner_org: 'test-org' })
      }
      if (url.includes('/channel?')) {
        if (scenario === 'denied-http')
          return Response.json({ error: 'cannot_access_app' }, { status: 400 })
        const channel = ${JSON.stringify(httpChannel)}
        return Response.json(scenario === 'single-object' ? channel : [channel])
      }
      return Response.json({ status: 'ok' })
    }
  `)
  for (const scenario of ['denied-app', 'denied-channel', 'denied-http', 'allowed', 'single-object']) {
    const child = spawnSync('node', [
      '--import', preload, new URL('../dist/index.js', import.meta.url).pathname,
      'channel', 'list', appId, '-a', options.apikey,
      '--supa-host', options.supaHost, '--supa-anon', options.supaAnon,
    ], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, CAPGO_CHANNEL_LIST_SCENARIO: scenario },
    })
    const output = child.stdout + child.stderr
    assert.equal(child.status, scenario.startsWith('denied') ? 1 : 0, output)
    assert.doesNotMatch(output, /Edge Function returned|non-2xx/)
    if (scenario === 'denied-app')
      assert.match(output, /app.read permission/)
    else if (scenario.startsWith('denied'))
      assert.match(output, /app.read_channels/)
    else {
      assert.match(output, /Unlinked/)
      assert.match(output, /iOS\s+│ Yes/)
      assert.match(output, /Android\s+│ No/)
    }
  }
  console.log('Built CLI prints permission failures and readable channel settings')
}
finally {
  rmSync(fixture, { recursive: true, force: true })
}
