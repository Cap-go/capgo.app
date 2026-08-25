import assert from 'node:assert/strict'
import { findAppInOrganization } from '../src/api/app.ts'
import { buildAppIdConflictSuggestions, isAppAlreadyExistsError } from '../src/init/app-conflict.ts'
import { isChannelAlreadyExistsError } from '../src/init/channel-conflict.ts'

let failures = 0

async function t(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

const originalFetch = globalThis.fetch

function mockAppFetch(handler) {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    return handler(url, init)
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

await t('app conflict detector matches duplicate app errors', () => {
  assert.equal(isAppAlreadyExistsError(new Error('App com.example.app already exists')), true)
  assert.equal(isAppAlreadyExistsError(new Error('duplicate key value violates unique constraint')), true)
  assert.equal(isAppAlreadyExistsError({ code: '23505', message: 'duplicate key value violates unique constraint' }), true)
  assert.equal(isAppAlreadyExistsError(new Error('23505')), true)
  assert.equal(isAppAlreadyExistsError(new Error('network unavailable')), false)
})

await t('channel conflict detector matches the channel name uniqueness error', () => {
  assert.equal(isChannelAlreadyExistsError(new Error('Cannot create channel: duplicate key value violates unique constraint "unique_name_app_id" | Code: 23505')), true)
  assert.equal(isChannelAlreadyExistsError('duplicate key value violates unique constraint "unique_name_app_id" | Code: 23505'), true)
  assert.equal(isChannelAlreadyExistsError({ code: '23505', message: 'duplicate key value violates unique constraint "unique_name_app_id"' }), true)
  assert.equal(isChannelAlreadyExistsError({ code: '23505' }), false)
  assert.equal(isChannelAlreadyExistsError(new Error('duplicate key value violates unique constraint "channels_public_platform_key"')), false)
  assert.equal(isChannelAlreadyExistsError(new Error('network unavailable')), false)
})

await t('app conflict suggestions are based on the current app ID', () => {
  const suggestions = buildAppIdConflictSuggestions('com.example.current', () => 0.5, () => 123456789)

  assert.deepEqual(suggestions.slice(1), [
    'com.example.current.dev',
    'com.example.current.app',
    'com.example.current-6789',
    'com.example.current2',
    'com.example.current3',
  ])
  assert.match(suggestions[0], /^com\.example\.current-[a-z0-9]+$/)
})

await t('findAppInOrganization checks the selected organization and app ID', async () => {
  const calls = []
  mockAppFetch(async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/app/com.example.app')) {
      return jsonResponse({
        app_id: 'com.example.app',
        name: 'Example',
        owner_org: 'org_123',
        need_onboarding: false,
      })
    }
    return jsonResponse({ error: 'not_found' }, 404)
  })

  try {
    const app = await findAppInOrganization('test-key', 'org_123', 'com.example.app')

    assert.equal(app.app_id, 'com.example.app')
    assert.equal(app.owner_org, 'org_123')
    const appCall = calls.find(call => /\/app\/com\.example\.app$/.test(call.url))
    assert.ok(appCall, 'expected GET app/<id> request')
    assert.equal(appCall.method, 'GET')
  }
  finally {
    globalThis.fetch = originalFetch
  }
})

await t('findAppInOrganization defaults need_onboarding when omitted', async () => {
  mockAppFetch(async (url) => {
    if (url.includes('/app/com.example.app')) {
      return jsonResponse({
        app_id: 'com.example.app',
        name: 'Example',
        owner_org: 'org_123',
      })
    }
    return jsonResponse({ error: 'not_found' }, 404)
  })

  try {
    const app = await findAppInOrganization('test-key', 'org_123', 'com.example.app')

    assert.equal(app.need_onboarding, false)
    assert.equal(app.owner_org, 'org_123')
  }
  finally {
    globalThis.fetch = originalFetch
  }
})

await t('findAppInOrganization returns null for another org or missing app', async () => {
  mockAppFetch(async (url) => {
    if (url.includes('/app/com.example.app')) {
      return jsonResponse({
        app_id: 'com.example.app',
        name: 'Example',
        owner_org: 'org_other',
        need_onboarding: false,
      })
    }
    return jsonResponse({ error: 'not_found' }, 404)
  })

  try {
    const wrongOrg = await findAppInOrganization('test-key', 'org_123', 'com.example.app')
    assert.equal(wrongOrg, null)

    const missing = await findAppInOrganization('test-key', 'org_123', 'com.missing.app')
    assert.equal(missing, null)
  }
  finally {
    globalThis.fetch = originalFetch
  }
})

if (failures > 0) {
  console.error(`\n❌ ${failures} init app conflict test(s) failed`)
  process.exit(1)
}

console.log('\n✅ init app conflict tests passed')
