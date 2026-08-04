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

function createSupabaseStub(results) {
  const calls = []
  let resultIndex = 0

  return {
    calls,
    from(table) {
      const call = { table, select: undefined, filters: [] }
      calls.push(call)

      const chain = {
        select(columns) {
          call.select = columns
          return chain
        },
        eq(column, value) {
          call.filters.push([column, value])
          return chain
        },
        maybeSingle() {
          return results[resultIndex++]
        },
      }

      return chain
    },
  }
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
  const supabase = createSupabaseStub([
    {
      data: {
        app_id: 'com.example.app',
        name: 'Example',
        owner_org: 'org_123',
        need_onboarding: false,
      },
      error: null,
    },
  ])

  const app = await findAppInOrganization(supabase, 'org_123', 'com.example.app')

  assert.equal(app.app_id, 'com.example.app')
  assert.equal(app.owner_org, 'org_123')
  assert.deepEqual(supabase.calls[0], {
    table: 'apps',
    select: 'app_id, name, owner_org, need_onboarding',
    filters: [
      ['owner_org', 'org_123'],
      ['app_id', 'com.example.app'],
    ],
  })
})

await t('findAppInOrganization falls back for older onboarding schemas', async () => {
  const supabase = createSupabaseStub([
    {
      data: null,
      error: { message: 'Could not find the need_onboarding column in the schema cache' },
    },
    {
      data: {
        app_id: 'com.example.app',
        name: 'Example',
        owner_org: 'org_123',
      },
      error: null,
    },
  ])

  const app = await findAppInOrganization(supabase, 'org_123', 'com.example.app')

  assert.equal(app.need_onboarding, false)
  assert.equal(supabase.calls[1].select, 'app_id, name, owner_org')
})

if (failures > 0) {
  console.error(`\n❌ ${failures} init app conflict test(s) failed`)
  process.exit(1)
}

console.log('\n✅ init app conflict tests passed')
