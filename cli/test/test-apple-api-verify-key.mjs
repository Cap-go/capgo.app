import assert from 'node:assert/strict'
import { verifyApiKey } from '../src/build/onboarding/apple-api.ts'
import { mapIosOnboardingError } from '../src/build/onboarding/error-categories.ts'
import { getBuildOnboardingRecoveryAdvice } from '../src/build/onboarding/recovery.ts'

// Regression coverage for the SableCRM build-init report: a team whose Apple
// Developer Program License Agreement is unsigned gets HTTP 403
// FORBIDDEN_ERROR.PLA_NOT_ACCEPTED. The key/Key ID/Issuer ID are all valid, so
// the CLI must NOT show the "check your .p8 / Key ID / Issuer ID" checklist —
// it must route to the agreement guidance across all three layers:
//   1. verifyApiKey (the user-facing message),
//   2. mapIosOnboardingError (the telemetry category), and
//   3. getBuildOnboardingRecoveryAdvice (the error-screen recovery advice).

let failures = 0
async function t(name, fn) {
  try {
    await fn()
    process.stdout.write(`✓ ${name}\n`)
  }
  catch (e) {
    failures += 1
    process.stderr.write(`✗ ${name}\n`)
    process.stderr.write(`  ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

// Swap the global fetch with one that returns a canned App Store Connect
// response, so verifyApiKey runs its real error-mapping logic offline.
function withFetch(status, body, run) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers(),
    json: async () => body,
  })
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original })
}

const PLA_403 = {
  errors: [{
    id: 'f7afa041-bba9-4e48-9b91-2d344dc262f3',
    status: '403',
    code: 'FORBIDDEN_ERROR.PLA_NOT_ACCEPTED',
    title: 'Unable to process request - PLA Update available',
    detail: 'You currently don\'t have access to this membership resource. To resolve this issue, your team\'s Account Holder, Craig Metzger, must agree to the latest Program License Agreement.',
  }],
}

const NOT_AUTHORIZED_401 = {
  errors: [{
    status: '401',
    code: 'NOT_AUTHORIZED',
    title: 'Authentication credentials are missing or invalid.',
    detail: 'Provide a properly configured and signed bearer token, and make sure that it has not expired.',
  }],
}

async function captureThrow(run) {
  try {
    await run()
  }
  catch (e) {
    return e
  }
  return undefined
}

// ─── Layer 1: verifyApiKey user-facing message ──────────────────────────────

await t('verifyApiKey: PLA 403 → agreement guidance, not the credential checklist', () =>
  withFetch(403, PLA_403, async () => {
    const err = await captureThrow(() => verifyApiKey('fake-token'))
    assert.ok(err, 'expected verifyApiKey to throw on PLA 403')
    assert.match(err.message, /required agreement/i)
    assert.match(err.message, /Account Holder/i)
    assert.doesNotMatch(err.message, /The \.p8 file is correct/i)
    assert.doesNotMatch(err.message, /The Key ID matches/i)
  }))

await t('verifyApiKey: PLA 403 carries status 403 and the Apple code (for telemetry)', () =>
  withFetch(403, PLA_403, async () => {
    const err = await captureThrow(() => verifyApiKey('fake-token'))
    assert.ok(err)
    assert.equal(err.status, 403)
    assert.equal(err.code, 'FORBIDDEN_ERROR.PLA_NOT_ACCEPTED')
  }))

await t('verifyApiKey: genuine 401 NOT_AUTHORIZED still gets the credential checklist', () =>
  withFetch(401, NOT_AUTHORIZED_401, async () => {
    const err = await captureThrow(() => verifyApiKey('fake-token'))
    assert.ok(err, 'expected verifyApiKey to throw on 401')
    assert.match(err.message, /Apple rejected the App Store Connect API key/i)
    assert.match(err.message, /The \.p8 file is correct/i)
    assert.doesNotMatch(err.message, /required agreement/i)
  }))

// ─── Layer 2: telemetry categorizer ─────────────────────────────────────────

await t('mapIosOnboardingError: PLA code → apple_agreements_missing', () => {
  const err = Object.assign(new Error('Apple API error (403): … (FORBIDDEN_ERROR.PLA_NOT_ACCEPTED)'), {
    status: 403,
    code: 'FORBIDDEN_ERROR.PLA_NOT_ACCEPTED',
  })
  assert.equal(mapIosOnboardingError(err, 'verifying-key'), 'apple_agreements_missing')
})

await t('mapIosOnboardingError: PLA message-only (status/code stripped by TUI) → apple_agreements_missing', () => {
  // The iOS TUI engine collapses the thrown error to its message string, so the
  // reconstructed Error carries no status/code — the message must still classify.
  const raw = 'Apple API error (403): Unable to process request - PLA Update available — must agree to the latest Program License Agreement.'
  assert.equal(mapIosOnboardingError(new Error(raw), 'verifying-key'), 'apple_agreements_missing')
})

await t('mapIosOnboardingError: a non-agreement 403 still maps to apple_api_forbidden (no over-match)', () => {
  const err = Object.assign(new Error('Apple API error (403): some other forbidden thing (FORBIDDEN.SOMETHING_ELSE)'), {
    status: 403,
    code: 'FORBIDDEN.SOMETHING_ELSE',
  })
  assert.equal(mapIosOnboardingError(err, 'verifying-key'), 'apple_api_forbidden')
})

// ─── Layer 3: error-screen recovery advice ──────────────────────────────────

await t('getBuildOnboardingRecoveryAdvice: raw PLA message → agreements page, not credential advice', () => {
  const advice = getBuildOnboardingRecoveryAdvice(
    'Apple API error (403): Unable to process request - PLA Update available — must agree to the latest Program License Agreement. (FORBIDDEN_ERROR.PLA_NOT_ACCEPTED)',
    'verifying-key',
    'bunx',
    'com.example.app',
  )
  assert.ok(advice.docs.includes('https://appstoreconnect.apple.com/agreements'), 'links the agreements page')
  assert.ok(!advice.summary.some(line => line.includes('Double-check the .p8')), 'must NOT surface the credential checklist')
})

if (failures > 0) {
  process.stderr.write(`\n${failures} test(s) failed\n`)
  process.exit(1)
}
process.stdout.write('OK\n')
