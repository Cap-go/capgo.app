import assert from 'node:assert/strict'
import { listPlayApps, parseAppsSearchResponse, ReportingApiHttpError } from '../src/build/onboarding/android/reporting-api.ts'

// Async-aware runner: every test is awaited in order so a rejected async test
// fails the run before `console.log('OK')` and never leaks an unhandled
// rejection. Synchronous tests await harmlessly.
async function t(name, fn) {
  try {
    await fn()
    process.stdout.write(`✓ ${name}\n`)
  }
  catch (e) {
    process.stderr.write(`✗ ${name}\n`)
    throw e
  }
}

/** Build a Response-like object the way `fetchImpl` callers expect. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

// ─── parseAppsSearchResponse ──────────────────────────────────────────────

await t('parseAppsSearchResponse returns [] for null/undefined json', () => {
  assert.deepEqual(parseAppsSearchResponse(null), [])
  assert.deepEqual(parseAppsSearchResponse(undefined), [])
})

await t('parseAppsSearchResponse returns [] for an empty apps array', () => {
  assert.deepEqual(parseAppsSearchResponse({ apps: [] }), [])
})

await t('parseAppsSearchResponse returns [] when apps key is missing', () => {
  assert.deepEqual(parseAppsSearchResponse({ nextPageToken: 'x' }), [])
})

await t('parseAppsSearchResponse maps well-formed apps', () => {
  const json = {
    apps: [
      { name: 'apps/ee.forgr.one', packageName: 'ee.forgr.one', displayName: 'App One' },
      { name: 'apps/ee.forgr.two', packageName: 'ee.forgr.two', displayName: 'App Two' },
    ],
  }
  assert.deepEqual(parseAppsSearchResponse(json), [
    { packageName: 'ee.forgr.one', displayName: 'App One' },
    { packageName: 'ee.forgr.two', displayName: 'App Two' },
  ])
})

await t('parseAppsSearchResponse drops entries missing packageName, keeps missing displayName', () => {
  // packageName is the reconciliation join key — an empty one could spuriously
  // "exact-match" a project whose Gradle parse found no applicationId, so
  // packageName-less rows are dropped instead of mapped to ''.
  const json = {
    apps: [
      { name: 'apps/x' }, // no packageName, no displayName → dropped
      { packageName: 'ee.forgr.three' }, // no displayName → kept
      { displayName: 'Nameless' }, // no packageName → dropped
      { packageName: 42, displayName: 'NonString' }, // non-string packageName → dropped
    ],
  }
  assert.deepEqual(parseAppsSearchResponse(json), [
    { packageName: 'ee.forgr.three', displayName: '' },
  ])
})

await t('parseAppsSearchResponse returns [] for garbage shapes', () => {
  assert.deepEqual(parseAppsSearchResponse('not an object'), [])
  assert.deepEqual(parseAppsSearchResponse(42), [])
  assert.deepEqual(parseAppsSearchResponse({ apps: null }), [])
  // Truthy non-array `apps` must not throw (object/string/number) — guards the
  // Array.isArray check, since `.flatMap` only exists on arrays.
  assert.deepEqual(parseAppsSearchResponse({ apps: {} }), [])
  assert.deepEqual(parseAppsSearchResponse({ apps: 'x' }), [])
  assert.deepEqual(parseAppsSearchResponse({ apps: 7 }), [])
  assert.deepEqual(parseAppsSearchResponse({ apps: true }), [])
})

// ─── listPlayApps (injected fetch) ─────────────────────────────────────────

await t('listPlayApps returns parsed apps for a single page', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      apps: [{ packageName: 'ee.forgr.one', displayName: 'One' }],
    })
  }
  const apps = await listPlayApps('tok', { fetchImpl })
  assert.deepEqual(apps, [{ packageName: 'ee.forgr.one', displayName: 'One' }])
  assert.equal(calls.length, 1)
  // Bearer auth + the pageSize query are wired correctly.
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok')
  assert.equal(new URL(calls[0].url).hostname, 'playdeveloperreporting.googleapis.com')
  assert.ok(calls[0].url.includes('apps:search') || calls[0].url.includes('apps%3Asearch'))
  assert.ok(calls[0].url.includes('pageSize=1000'))
})

await t('listPlayApps accumulates across nextPageToken pages', async () => {
  const pages = [
    { apps: [{ packageName: 'a', displayName: 'A' }], nextPageToken: 'p2' },
    { apps: [{ packageName: 'b', displayName: 'B' }], nextPageToken: 'p3' },
    { apps: [{ packageName: 'c', displayName: 'C' }] }, // no token → stop
  ]
  const seenTokens = []
  let i = 0
  const fetchImpl = async (url) => {
    const u = new URL(url)
    seenTokens.push(u.searchParams.get('pageToken'))
    return jsonResponse(pages[i++])
  }
  const apps = await listPlayApps('tok', { fetchImpl })
  assert.deepEqual(apps, [
    { packageName: 'a', displayName: 'A' },
    { packageName: 'b', displayName: 'B' },
    { packageName: 'c', displayName: 'C' },
  ])
  // First call has no token; subsequent calls forward the prior nextPageToken.
  assert.deepEqual(seenTokens, [null, 'p2', 'p3'])
})

await t('listPlayApps stops at the page cap even if the token never clears', async () => {
  let count = 0
  const fetchImpl = async () => {
    count++
    return jsonResponse({ apps: [{ packageName: `p${count}`, displayName: '' }], nextPageToken: 'always' })
  }
  const apps = await listPlayApps('tok', { fetchImpl })
  // MAX_LIST_PAGES = 10 — a looping token can never spin forever.
  assert.equal(count, 10)
  assert.equal(apps.length, 10)
})

await t('listPlayApps throws ReportingApiHttpError carrying the status on a non-OK response', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'PERMISSION_DENIED' } }, { ok: false, status: 403 })
  await assert.rejects(
    () => listPlayApps('tok', { fetchImpl }),
    (err) => {
      assert.ok(err instanceof ReportingApiHttpError)
      assert.equal(err.status, 403)
      assert.match(err.message, /403/)
      assert.match(err.message, /PERMISSION_DENIED/)
      return true
    },
  )
})

console.log('OK')
