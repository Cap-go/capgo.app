import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { findAppInOrganization } from '../src/api/app.ts'
import { buildAppIdConflictSuggestions, isAppAlreadyExistsError } from '../src/init/app-conflict.ts'
import { isChannelAlreadyExistsError } from '../src/init/channel-conflict.ts'
import { selectOnboardingChannel } from '../src/init/channel-selection.ts'

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

async function withChannelSelection(channels, answers, run, lookupError) {
  const calls = { reuse: [], chooseName: [], create: [] }
  const supabase = createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  mockAppFetch(async (url) => {
    const request = new URL(url)
    assert.equal(request.pathname, '/rest/v1/channels')
    assert.equal(request.searchParams.get('app_id'), 'eq.com.example.app')
    assert.equal(request.searchParams.get('select'), 'name,public')
    return jsonResponse(lookupError ?? channels, lookupError ? 403 : 200)
  })
  const prompts = {
    reuseChannel: async (name) => {
      calls.reuse.push(name)
      const answer = answers.reuse.shift()
      if (answer instanceof Error)
        throw answer
      assert.equal(typeof answer, 'boolean', 'unexpected reuse prompt')
      return answer
    },
    chooseName: async (names) => {
      calls.chooseName.push([...names])
      const name = answers.names.shift()
      assert.equal(typeof name, 'string', 'unexpected new-channel prompt')
      return name
    },
    createChannel: async (name) => {
      calls.create.push(name)
      const error = answers.createErrors?.shift()
      if (error)
        throw error
    },
  }
  try {
    await run(() => selectOnboardingChannel(supabase, 'com.example.app', answers.preferredName ?? 'production', prompts), calls)
  }
  finally {
    globalThis.fetch = originalFetch
  }
}

for (const name of ['production', 'staging']) {
  await t(`onboarding offers to reuse an existing ${name} channel before creating anything`, async () => {
    await withChannelSelection([{ name, public: true }], { reuse: [true], names: [] }, async (select, calls) => {
      assert.equal(await select(), name)
      assert.deepEqual(calls, { reuse: [name], chooseName: [], create: [] })
    })
  })
}

await t('onboarding keeps the channel-name picker for apps without channels', async () => {
  await withChannelSelection([], { reuse: [], names: ['production'] }, async (select, calls) => {
    assert.equal(await select(), 'production')
    assert.deepEqual(calls, { reuse: [], chooseName: [[]], create: ['production'] })
  })
})

await t('declining reuse creates a new channel with the chosen name', async () => {
  await withChannelSelection([{ name: 'production', public: true }], { reuse: [false], names: ['beta'] }, async (select, calls) => {
    assert.equal(await select(), 'beta')
    assert.deepEqual(calls, { reuse: ['production'], chooseName: [['production']], create: ['beta'] })
  })
})

await t('choosing another existing channel asks for reuse instead of recreating it', async () => {
  await withChannelSelection([
    { name: 'beta', public: false },
    { name: 'production', public: true },
  ], { reuse: [false, true], names: ['beta'] }, async (select, calls) => {
    assert.equal(await select(), 'beta')
    assert.deepEqual(calls.reuse, ['production', 'beta'])
    assert.deepEqual(calls.create, [])
  })
})

await t('declining an already-used custom name returns to name selection', async () => {
  await withChannelSelection([{ name: 'beta', public: false }], { reuse: [false, false], names: ['beta', 'dev'] }, async (select, calls) => {
    assert.equal(await select(), 'dev')
    assert.deepEqual(calls.reuse, ['beta', 'beta'])
    assert.deepEqual(calls.create, ['dev'])
  })
})

for (const [preferredName, expected] of [['production', 'production'], ['beta', 'beta'], ['missing', 'staging']]) {
  await t(`onboarding prefers ${expected} when the saved channel is ${preferredName}`, async () => {
    await withChannelSelection([
      { name: 'beta', public: false },
      { name: 'production', public: false },
      { name: 'staging', public: true },
    ], { preferredName, reuse: [true], names: [] }, async (select, calls) => {
      assert.equal(await select(), expected)
      assert.deepEqual(calls.reuse, [expected])
      assert.deepEqual(calls.create, [])
    })
  })
}

await t('channel lookup failures stop onboarding before prompting or creating', async () => {
  await withChannelSelection([], { reuse: [], names: [] }, async (select, calls) => {
    await assert.rejects(select, /Cannot check existing channels:.*permission denied/)
    assert.deepEqual(calls, { reuse: [], chooseName: [], create: [] })
  }, { message: 'permission denied', code: '42501' })
})

await t('cancelling reuse stops without creating a channel', async () => {
  const cancelled = new Error('Operation cancelled')
  await withChannelSelection([{ name: 'production', public: true }], { reuse: [cancelled], names: [] }, async (select, calls) => {
    await assert.rejects(select, error => error === cancelled)
    assert.deepEqual(calls.create, [])
  })
})

await t('a duplicate creation error offers reuse and permits a different new name', async () => {
  await withChannelSelection([], {
    reuse: [false],
    names: ['production', 'beta'],
    createErrors: [new Error('duplicate key value violates unique constraint "unique_name_app_id"')],
  }, async (select, calls) => {
    assert.equal(await select(), 'beta')
    assert.deepEqual(calls.reuse, ['production'])
    assert.deepEqual(calls.chooseName, [[], ['production']])
    assert.deepEqual(calls.create, ['production', 'beta'])
  })
})

await t('other creation failures propagate without offering reuse', async () => {
  const failed = new Error('network unavailable')
  await withChannelSelection([], { reuse: [], names: ['production'], createErrors: [failed] }, async (select, calls) => {
    await assert.rejects(select, error => error === failed)
    assert.deepEqual(calls.reuse, [])
  })
})

if (failures > 0) {
  console.error(`\n❌ ${failures} init app conflict test(s) failed`)
  process.exit(1)
}

console.log('\n✅ init app conflict tests passed')
