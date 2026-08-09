import assert from 'node:assert/strict'
import { ensureBundleId, parseAppsResponse, parseBundleIdsResponse } from '../src/build/onboarding/apple-api.ts'

function t(name, fn) {
  try {
    fn()
    process.stdout.write(`✓ ${name}\n`)
  }
  catch (e) {
    process.stderr.write(`✗ ${name}\n`)
    throw e
  }
}

async function at(name, fn) {
  try {
    await fn()
    process.stdout.write(`✓ ${name}\n`)
  }
  catch (e) {
    process.stderr.write(`✗ ${name}\n`)
    throw e
  }
}

// ─── parseAppsResponse ────────────────────────────────────────────────

t('parseAppsResponse returns [] for null/undefined json', () => {
  assert.deepEqual(parseAppsResponse(null), [])
  assert.deepEqual(parseAppsResponse(undefined), [])
})

t('parseAppsResponse returns [] for empty data', () => {
  assert.deepEqual(parseAppsResponse({ data: [] }), [])
})

t('parseAppsResponse maps well-formed apps', () => {
  const json = {
    data: [
      { id: 'app1', attributes: { bundleId: 'ee.forgr.one', name: 'App One' } },
      { id: 'app2', attributes: { bundleId: 'ee.forgr.two', name: 'App Two' } },
    ],
  }
  assert.deepEqual(parseAppsResponse(json), [
    { id: 'app1', bundleId: 'ee.forgr.one', name: 'App One' },
    { id: 'app2', bundleId: 'ee.forgr.two', name: 'App Two' },
  ])
})

t('parseAppsResponse tolerates missing attributes', () => {
  const json = {
    data: [
      { id: 'app1' }, // no attributes at all
      { id: 'app2', attributes: {} }, // attributes present but empty
      { attributes: { bundleId: 'ee.forgr.three' } }, // no id, partial attrs
    ],
  }
  assert.deepEqual(parseAppsResponse(json), [
    { id: 'app1', bundleId: '', name: '' },
    { id: 'app2', bundleId: '', name: '' },
    { id: '', bundleId: 'ee.forgr.three', name: '' },
  ])
})

// ─── parseBundleIdsResponse ───────────────────────────────────────────

t('parseBundleIdsResponse returns [] for null/undefined json', () => {
  assert.deepEqual(parseBundleIdsResponse(null), [])
  assert.deepEqual(parseBundleIdsResponse(undefined), [])
})

t('parseBundleIdsResponse returns [] for empty data', () => {
  assert.deepEqual(parseBundleIdsResponse({ data: [] }), [])
})

t('parseBundleIdsResponse extracts identifier strings', () => {
  const json = {
    data: [
      { id: 'b1', attributes: { identifier: 'ee.forgr.one' } },
      { id: 'b2', attributes: { identifier: 'ee.forgr.two' } },
    ],
  }
  assert.deepEqual(parseBundleIdsResponse(json), ['ee.forgr.one', 'ee.forgr.two'])
})

t('parseBundleIdsResponse drops entries with missing attributes/identifier', () => {
  const json = {
    data: [
      { id: 'b1', attributes: { identifier: 'ee.forgr.real' } },
      { id: 'b2' }, // no attributes
      { id: 'b3', attributes: {} }, // no identifier
      { id: 'b4', attributes: { identifier: '' } }, // falsy identifier
    ],
  }
  assert.deepEqual(parseBundleIdsResponse(json), ['ee.forgr.real'])
})

// ─── ensureBundleId ────────────────────────────────────────────────

const realFetch = globalThis.fetch

try {
  await at('ensureBundleId selects the exact identifier when Apple returns a similar identifier first', async () => {
    globalThis.fetch = async () => Response.json({
      data: [
        { id: 'wrong-resource', attributes: { identifier: 'io.onyxpro.app.app' } },
        { id: 'correct-resource', attributes: { identifier: 'io.onyxpro.app' } },
      ],
    })

    const result = await ensureBundleId('token', 'io.onyxpro.app')

    assert.equal(result.bundleIdResourceId, 'correct-resource')
  })

  await at('ensureBundleId requests Apple\'s maximum page size', async () => {
    let requestUrl = ''
    globalThis.fetch = async (url) => {
      requestUrl = String(url)
      return Response.json({
        data: [{ id: 'correct-resource', attributes: { identifier: 'io.onyxpro.app' } }],
      })
    }

    await ensureBundleId('token', 'io.onyxpro.app')

    assert.match(requestUrl, /[?&]limit=200(?:&|$)/)
  })
}
finally {
  globalThis.fetch = realFetch
}

console.log('OK')
