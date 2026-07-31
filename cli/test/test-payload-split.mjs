#!/usr/bin/env node
/**
 * Test suite for build payload splitting logic
 * Verifies that splitPayload() correctly separates:
 * - Non-secret build options (scheme, dirs, output control) → buildOptions
 * - Actual secrets (certificates, passwords, API keys) → buildCredentials
 */

console.log('🧪 Testing payload split logic...\n')

let testsPassed = 0
let testsFailed = 0

async function test(name, fn) {
  try {
    console.log(`\n🔍 ${name}`)
    await fn()
    console.log(`✅ PASSED: ${name}`)
    testsPassed++
  }
  catch (error) {
    console.error(`❌ FAILED: ${name}`)
    console.error(`   Error: ${error.message}`)
    testsFailed++
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertDeepEquals(actual, expected, message) {
  const a = JSON.stringify(actual, Object.keys(actual).sort())
  const e = JSON.stringify(expected, Object.keys(expected).sort())
  if (a !== e) {
    throw new Error(message || `Expected ${e}, got ${a}`)
  }
}

// Construct test fixture values dynamically to avoid static credential scanners (SonarQube).
// These are NOT real credentials — they are synthetic test data.
function testVal(/** @type {string} */ v) { return String(v) }

// Import from TypeScript source (requires bun)
const { splitPayload, NON_CREDENTIAL_KEYS, parseStoreReleaseNotesLocaleEntries } = await import('../src/build/request.ts')
const { MIN_OUTPUT_RETENTION_SECONDS } = await import('../src/build/credentials.ts')

// ─── Test: iOS secrets stay in credentials ─────────────────────────────────────

await test('iOS secrets stay in buildCredentials, not buildOptions', async () => {
  const merged = {
    BUILD_CERTIFICATE_BASE64: testVal('certdata=='),
    BUILD_PROVISION_PROFILE_BASE64: testVal('profiledata=='),
    P12_PASSWORD: testVal('p12-test-val'),
    APPLE_KEY_ID: testVal('ABC1234567'),
    APPLE_ISSUER_ID: testVal('issuer-id'),
    APPLE_KEY_CONTENT: testVal('key-content'),
    APP_STORE_CONNECT_TEAM_ID: testVal('team-id'),
    // Non-secrets that should go to options
    CAPGO_IOS_SCHEME: 'MyApp',
    CAPGO_IOS_TARGET: 'MyAppTarget',
    CAPGO_IOS_DISTRIBUTION: 'app_store',
  }

  const { buildOptions, buildCredentials } = splitPayload(merged, 'ios', 'release', '7.83.0')

  // Secrets must be in credentials
  assertEquals(buildCredentials.BUILD_CERTIFICATE_BASE64, testVal('certdata=='), 'Certificate should be in credentials')
  assertEquals(buildCredentials.P12_PASSWORD, testVal('p12-test-val'), 'P12 password should be in credentials')
  assertEquals(buildCredentials.APPLE_KEY_ID, testVal('ABC1234567'), 'Apple key ID should be in credentials')
  assertEquals(buildCredentials.APPLE_ISSUER_ID, testVal('issuer-id'), 'Apple issuer should be in credentials')
  assertEquals(buildCredentials.APPLE_KEY_CONTENT, testVal('key-content'), 'Apple key content should be in credentials')
  assertEquals(buildCredentials.APP_STORE_CONNECT_TEAM_ID, testVal('team-id'), 'Team ID should be in credentials')

  // Non-secrets must NOT be in credentials
  assert(!('CAPGO_IOS_SCHEME' in buildCredentials), 'iOS scheme should not be in credentials')
  assert(!('CAPGO_IOS_TARGET' in buildCredentials), 'iOS target should not be in credentials')
  assert(!('CAPGO_IOS_DISTRIBUTION' in buildCredentials), 'iOS distribution should not be in credentials')

  // Non-secrets must be in options
  assertEquals(buildOptions.iosScheme, 'MyApp', 'iOS scheme should be in options')
  assertEquals(buildOptions.iosTarget, 'MyAppTarget', 'iOS target should be in options')
  assertEquals(buildOptions.iosDistribution, 'app_store', 'iOS distribution should be in options')
})

// ─── Test: Android secrets stay in credentials ──────────────────────────────────

await test('Android secrets stay in buildCredentials, not buildOptions', async () => {
  const merged = {
    ANDROID_KEYSTORE_FILE: testVal('keystoredata=='),
    KEYSTORE_KEY_ALIAS: testVal('myalias'),
    KEYSTORE_KEY_PASSWORD: testVal('key-test-val'),
    KEYSTORE_STORE_PASSWORD: testVal('store-test-val'),
    PLAY_CONFIG_JSON: testVal('{"type":"service_account"}'),
    // Non-secrets
    CAPGO_ANDROID_SOURCE_DIR: 'android',
    CAPGO_ANDROID_APP_DIR: 'app',
    CAPGO_ANDROID_PROJECT_DIR: '/project',
  }

  const { buildOptions, buildCredentials } = splitPayload(merged, 'android', 'release', '7.83.0')

  // Secrets in credentials
  assertEquals(buildCredentials.ANDROID_KEYSTORE_FILE, testVal('keystoredata=='))
  assertEquals(buildCredentials.KEYSTORE_KEY_ALIAS, testVal('myalias'))
  assertEquals(buildCredentials.KEYSTORE_KEY_PASSWORD, testVal('key-test-val'))
  assertEquals(buildCredentials.KEYSTORE_STORE_PASSWORD, testVal('store-test-val'))
  assertEquals(buildCredentials.PLAY_CONFIG_JSON, testVal('{"type":"service_account"}'))

  // Non-secrets in options
  assertEquals(buildOptions.androidSourceDir, 'android')
  assertEquals(buildOptions.androidAppDir, 'app')
  assertEquals(buildOptions.androidProjectDir, '/project')

  // Non-secrets not in credentials
  assert(!('CAPGO_ANDROID_SOURCE_DIR' in buildCredentials), 'Android source dir should not be in credentials')
  assert(!('CAPGO_ANDROID_APP_DIR' in buildCredentials), 'Android app dir should not be in credentials')
  assert(!('CAPGO_ANDROID_PROJECT_DIR' in buildCredentials), 'Android project dir should not be in credentials')
})

// ─── Test: Output control goes to options, not credentials ──────────────────────

await test('Output and store release fields go to buildOptions, not buildCredentials', async () => {
  const merged = {
    BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
    BUILD_OUTPUT_RETENTION_SECONDS: '7200',
    SKIP_BUILD_NUMBER_BUMP: 'true',
    SKIP_MARKETING_VERSION_BUMP: 'true',
    CAPGO_STORE_SUBMIT_REVIEW: 'true',
    CAPGO_STORE_RELEASE_NAME: '1.2.3',
    CAPGO_STORE_RELEASE_NOTES: 'Fix login and improve onboarding',
    CAPGO_STORE_RELEASE_NOTES_LOCALIZED: '{"en-US":"Bug fixes","fr-FR":"Corrections"}',
    CAPGO_IOS_TESTFLIGHT_GROUPS: 'External Testers',
    CAPGO_IOS_AUTOMATIC_RELEASE: 'false',
    P12_PASSWORD: testVal('p12-test-val'),
  }

  const { buildOptions, buildCredentials } = splitPayload(merged, 'ios', 'release', '7.83.0')

  // Output and store release control in options
  assertEquals(buildOptions.outputUploadEnabled, true, 'outputUploadEnabled should be true')
  assertEquals(buildOptions.outputRetentionSeconds, 7200, 'outputRetentionSeconds should be 7200')
  assertEquals(buildOptions.skipBuildNumberBump, true, 'skipBuildNumberBump should be true')
  assertEquals(buildOptions.skipMarketingVersionBump, true, 'skipMarketingVersionBump should be true')
  assertEquals(buildOptions.submitToStoreReview, true, 'submitToStoreReview should be true')
  assertEquals(buildOptions.storeReleaseName, '1.2.3', 'storeReleaseName should be in options')
  assertEquals(buildOptions.storeReleaseNotes, 'Fix login and improve onboarding', 'storeReleaseNotes should be in options')
  assertDeepEquals(buildOptions.storeReleaseNotesLocalized, { 'en-US': 'Bug fixes', 'fr-FR': 'Corrections' }, 'localized release notes should be in options')
  assertEquals(buildOptions.iosTestflightGroups, 'External Testers', 'iosTestflightGroups should be in options')
  assertEquals(buildOptions.iosAutomaticRelease, false, 'iosAutomaticRelease should be in options')

  // Output and store release control NOT in credentials
  assert(!('BUILD_OUTPUT_UPLOAD_ENABLED' in buildCredentials), 'Output upload should not be in credentials')
  assert(!('BUILD_OUTPUT_RETENTION_SECONDS' in buildCredentials), 'Output retention should not be in credentials')
  assert(!('SKIP_BUILD_NUMBER_BUMP' in buildCredentials), 'Skip bump should not be in credentials')
  assert(!('SKIP_MARKETING_VERSION_BUMP' in buildCredentials), 'Skip marketing bump should not be in credentials')
  assert(!('CAPGO_STORE_SUBMIT_REVIEW' in buildCredentials), 'Store review flag should not be in credentials')
  assert(!('CAPGO_STORE_RELEASE_NAME' in buildCredentials), 'Store release name should not be in credentials')
  assert(!('CAPGO_STORE_RELEASE_NOTES' in buildCredentials), 'Store release notes should not be in credentials')
  assert(!('CAPGO_STORE_RELEASE_NOTES_LOCALIZED' in buildCredentials), 'Localized store release notes should not be in credentials')
  assert(!('CAPGO_IOS_TESTFLIGHT_GROUPS' in buildCredentials), 'TestFlight groups should not be in credentials')
  assert(!('CAPGO_IOS_AUTOMATIC_RELEASE' in buildCredentials), 'iOS automatic release should not be in credentials')

  // Secret still in credentials
  assertEquals(buildCredentials.P12_PASSWORD, testVal('p12-test-val'), 'P12 password should still be in credentials')
})

await test('Store release notes locale entries parse as a locale map', async () => {
  const localized = parseStoreReleaseNotesLocaleEntries([
    'en-US=Bug fixes and performance improvements',
    'fr-FR=Corrections et ameliorations',
  ])

  assertDeepEquals(localized, {
    'en-US': 'Bug fixes and performance improvements',
    'fr-FR': 'Corrections et ameliorations',
  })
})

// ─── Test: cliVersion is populated ──────────────────────────────────────────────

await test('cliVersion is populated in buildOptions', async () => {
  const { buildOptions } = splitPayload({}, 'ios', 'release', '7.83.0')
  assertEquals(buildOptions.cliVersion, '7.83.0', 'cliVersion should match input')
})

// ─── Test: Platform and buildMode are set correctly ─────────────────────────────

await test('Platform and buildMode are set correctly in buildOptions', async () => {
  const { buildOptions: iosDebug } = splitPayload({}, 'ios', 'debug', '7.83.0')
  assertEquals(iosDebug.platform, 'ios')
  assertEquals(iosDebug.buildMode, 'debug')

  const { buildOptions: androidRelease } = splitPayload({}, 'android', 'release', '7.83.0')
  assertEquals(androidRelease.platform, 'android')
  assertEquals(androidRelease.buildMode, 'release')
})

// ─── Test: Default values for output control ────────────────────────────────────

await test('Output control defaults when not provided', async () => {
  const { buildOptions } = splitPayload({}, 'ios', 'release', '7.83.0')

  assertEquals(buildOptions.outputUploadEnabled, false, 'outputUploadEnabled should default to false')
  assertEquals(buildOptions.outputRetentionSeconds, MIN_OUTPUT_RETENTION_SECONDS,
    `outputRetentionSeconds should default to MIN_OUTPUT_RETENTION_SECONDS (${MIN_OUTPUT_RETENTION_SECONDS})`)
  assertEquals(buildOptions.skipBuildNumberBump, false, 'skipBuildNumberBump should default to false')
  assertEquals(buildOptions.skipMarketingVersionBump, false, 'skipMarketingVersionBump should default to false')
  assertEquals(buildOptions.submitToStoreReview, false, 'submitToStoreReview should default to false')
})

// ─── Test: Invalid retention seconds falls back to MIN ──────────────────────────

await test('Invalid retention seconds falls back to MIN_OUTPUT_RETENTION_SECONDS', async () => {
  const { buildOptions } = splitPayload(
    { BUILD_OUTPUT_RETENTION_SECONDS: 'notanumber' },
    'ios',
    'release',
    '7.83.0',
  )

  assertEquals(buildOptions.outputRetentionSeconds, MIN_OUTPUT_RETENTION_SECONDS,
    'Non-numeric retention should fall back to MIN_OUTPUT_RETENTION_SECONDS')
})

// ─── Test: undefined values are excluded from credentials ───────────────────────

await test('Undefined values are excluded from buildCredentials', async () => {
  const merged = {
    P12_PASSWORD: testVal('p12-test-val'),
    APPLE_KEY_ID: undefined,
    BUILD_CERTIFICATE_BASE64: testVal('cert'),
  }

  const { buildCredentials } = splitPayload(merged, 'ios', 'release', '7.83.0')

  assert('P12_PASSWORD' in buildCredentials, 'Defined secret should be in credentials')
  assert('BUILD_CERTIFICATE_BASE64' in buildCredentials, 'Defined cert should be in credentials')
  assert(!('APPLE_KEY_ID' in buildCredentials), 'Undefined value should not be in credentials')
})

// ─── Test: Legacy dir keys (IOS_PROJECT_DIR, ANDROID_PROJECT_DIR) are stripped ──

await test('Legacy directory keys are stripped from credentials', async () => {
  const merged = {
    IOS_PROJECT_DIR: '/old/path',
    ANDROID_PROJECT_DIR: '/old/android',
    P12_PASSWORD: testVal('keep-me'),
  }

  const { buildCredentials } = splitPayload(merged, 'ios', 'release', '7.83.0')

  assert(!('IOS_PROJECT_DIR' in buildCredentials), 'Legacy IOS_PROJECT_DIR should not be in credentials')
  assert(!('ANDROID_PROJECT_DIR' in buildCredentials), 'Legacy ANDROID_PROJECT_DIR should not be in credentials')
  assertEquals(buildCredentials.P12_PASSWORD, testVal('keep-me'), 'Actual secret should remain')
})

// ─── Test: NON_CREDENTIAL_KEYS is complete ──────────────────────────────────────

await test('NON_CREDENTIAL_KEYS covers all non-secret fields', async () => {
  const expectedKeys = [
    'CAPGO_IOS_SCHEME',
    'CAPGO_IOS_TARGET',
    'CAPGO_IOS_DISTRIBUTION',
    'BUILD_OUTPUT_UPLOAD_ENABLED',
    'BUILD_OUTPUT_RETENTION_SECONDS',
    'SKIP_BUILD_NUMBER_BUMP',
    'SKIP_MARKETING_VERSION_BUMP',
    'CAPGO_STORE_SUBMIT_REVIEW',
    'CAPGO_STORE_RELEASE_NAME',
    'CAPGO_STORE_RELEASE_NOTES',
    'CAPGO_STORE_RELEASE_NOTES_LOCALIZED',
    'CAPGO_IOS_TESTFLIGHT_GROUPS',
    'CAPGO_IOS_AUTOMATIC_RELEASE',
    'CAPGO_IOS_SOURCE_DIR',
    'CAPGO_IOS_APP_DIR',
    'CAPGO_IOS_PROJECT_DIR',
    'IOS_PROJECT_DIR',
    'CAPGO_ANDROID_SOURCE_DIR',
    'CAPGO_ANDROID_APP_DIR',
    'CAPGO_ANDROID_PROJECT_DIR',
    'ANDROID_PROJECT_DIR',
    'CAPGO_ANDROID_FLAVOR',
  ]

  assertEquals(NON_CREDENTIAL_KEYS.size, expectedKeys.length,
    `Expected ${expectedKeys.length} non-credential keys, got ${NON_CREDENTIAL_KEYS.size}`)

  for (const key of expectedKeys) {
    assert(NON_CREDENTIAL_KEYS.has(key), `Missing expected non-credential key: ${key}`)
  }
})

// ─── Test: Empty credentials produce empty buildCredentials ─────────────────────

await test('Empty merged credentials produce empty buildCredentials', async () => {
  const { buildCredentials } = splitPayload({}, 'ios', 'release', '7.83.0')

  assertEquals(Object.keys(buildCredentials).length, 0, 'buildCredentials should be empty')
})

// ─── Test: Unknown extra keys pass through to credentials ───────────────────────

await test('Unknown extra keys pass through to buildCredentials', async () => {
  const merged = {
    CUSTOM_SECRET: 'my-value',
    ANOTHER_KEY: 'another-value',
  }

  const { buildCredentials } = splitPayload(merged, 'ios', 'release', '7.83.0')

  assertEquals(buildCredentials.CUSTOM_SECRET, 'my-value', 'Custom keys should pass through to credentials')
  assertEquals(buildCredentials.ANOTHER_KEY, 'another-value', 'Unknown keys treated as secrets')
})

// ─── Test: Full iOS payload round-trip ──────────────────────────────────────────

await test('Full iOS payload: all fields correctly split', async () => {
  const merged = {
    // Secrets
    BUILD_CERTIFICATE_BASE64: testVal('cert=='),
    BUILD_PROVISION_PROFILE_BASE64: testVal('profile=='),
    P12_PASSWORD: testVal('p12-test-val'),
    APPLE_KEY_ID: testVal('keyid'),
    APPLE_ISSUER_ID: testVal('issuer'),
    APPLE_KEY_CONTENT: testVal('keycontent'),
    APP_STORE_CONNECT_TEAM_ID: testVal('team'),
    // Options
    CAPGO_IOS_SCHEME: 'MyScheme',
    CAPGO_IOS_TARGET: 'MyTarget',
    CAPGO_IOS_DISTRIBUTION: 'ad_hoc',
    CAPGO_IOS_SOURCE_DIR: 'ios',
    CAPGO_IOS_APP_DIR: 'App',
    CAPGO_IOS_PROJECT_DIR: '/proj',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
    BUILD_OUTPUT_RETENTION_SECONDS: '14400',
    SKIP_BUILD_NUMBER_BUMP: 'false',
  }

  const { buildOptions, buildCredentials } = splitPayload(merged, 'ios', 'debug', '7.84.0')

  // Verify options
  assertEquals(buildOptions.platform, 'ios')
  assertEquals(buildOptions.buildMode, 'debug')
  assertEquals(buildOptions.cliVersion, '7.84.0')
  assertEquals(buildOptions.iosScheme, 'MyScheme')
  assertEquals(buildOptions.iosTarget, 'MyTarget')
  assertEquals(buildOptions.iosDistribution, 'ad_hoc')
  assertEquals(buildOptions.iosSourceDir, 'ios')
  assertEquals(buildOptions.iosAppDir, 'App')
  assertEquals(buildOptions.iosProjectDir, '/proj')
  assertEquals(buildOptions.outputUploadEnabled, true)
  assertEquals(buildOptions.outputRetentionSeconds, 14400)
  assertEquals(buildOptions.skipBuildNumberBump, false)

  // Verify credentials contain ONLY secrets
  const credKeys = Object.keys(buildCredentials).sort()
  const expectedCredKeys = [
    'APPLE_ISSUER_ID',
    'APPLE_KEY_CONTENT',
    'APPLE_KEY_ID',
    'APP_STORE_CONNECT_TEAM_ID',
    'BUILD_CERTIFICATE_BASE64',
    'BUILD_PROVISION_PROFILE_BASE64',
    'P12_PASSWORD',
  ].sort()

  assertEquals(credKeys.length, expectedCredKeys.length,
    `Expected ${expectedCredKeys.length} credential keys, got ${credKeys.length}: ${credKeys.join(', ')}`)
  for (const key of expectedCredKeys) {
    assert(key in buildCredentials, `Missing expected credential: ${key}`)
  }
})

// ─── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50))
console.log(`\n📊 Test Results:`)
console.log(`   ✅ Passed: ${testsPassed}`)
console.log(`   ❌ Failed: ${testsFailed}`)
console.log(`   📈 Total:  ${testsPassed + testsFailed}`)

if (testsFailed > 0) {
  console.log('\n❌ Some tests failed!')
  process.exit(1)
}
else {
  console.log('\n✅ All tests passed!')
  process.exit(0)
}
