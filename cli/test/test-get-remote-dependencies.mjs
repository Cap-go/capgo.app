#!/usr/bin/env node

import assert from 'node:assert/strict'

const { getRemoteDependencies } = await import('../src/utils.ts')

function fakeSupabase(maybeSingleResult) {
  return {
    from: (_table) => ({
      select: (_cols) => ({
        eq: (_k1, _v1) => ({
          eq: (_k2, _v2) => ({
            maybeSingle: async () => maybeSingleResult,
          }),
        }),
      }),
    }),
  }
}

let failures = 0

async function test(name, fn) {
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

await test('returns empty map when channel row is missing', async () => {
  const supabase = fakeSupabase({ data: null, error: null })
  const result = await getRemoteDependencies(supabase, 'com.example.app', 'production')
  assert.equal(result.size, 0)
})

await test('returns empty map when channel version has no native packages', async () => {
  const supabase = fakeSupabase({ data: { version: { native_packages: null } }, error: null })
  const result = await getRemoteDependencies(supabase, 'com.example.app', 'production')
  assert.equal(result.size, 0)
})

await test('returns empty map when channel has no linked version', async () => {
  const supabase = fakeSupabase({ data: { version: null }, error: null })
  const result = await getRemoteDependencies(supabase, 'com.example.app', 'production')
  assert.equal(result.size, 0)
})

await test('maps remote native packages by name', async () => {
  const supabase = fakeSupabase({
    data: {
      version: {
        native_packages: [
          {
            name: '@capacitor/camera',
            version: '6.0.0',
            requested_version: '^6.0.0',
            ios_checksum: 'ios-hash',
            android_checksum: 'android-hash',
          },
        ],
      },
    },
    error: null,
  })
  const result = await getRemoteDependencies(supabase, 'com.example.app', 'production')
  assert.equal(result.size, 1)
  assert.equal(result.get('@capacitor/camera')?.version, '6.0.0')
})

await test('throws a clear error for multiple channel rows instead of coerce message', async () => {
  const supabase = fakeSupabase({
    data: null,
    error: { message: 'Cannot coerce the result to a single JSON object' },
  })

  await assert.rejects(
    () => getRemoteDependencies(supabase, 'com.example.app', 'production'),
    /Multiple channels matched/,
  )
})

if (failures > 0) {
  process.exit(1)
}

console.log('getRemoteDependencies empty native packages tests passed')
