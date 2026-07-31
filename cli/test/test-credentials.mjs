#!/usr/bin/env node
/**
 * Test suite for build credentials merging and validation
 * Tests the three-tier credential sourcing:
 * 1. CLI args (highest priority)
 * 2. Environment variables (middle priority)
 * 3. Saved credentials file (lowest priority)
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

console.log('🧪 Testing build credentials functionality...\n')

// Mock home directory for testing
const testHome = join(tmpdir(), `capgo-test-${Date.now()}`)
const originalHome = process.env.HOME

let testsPassed = 0
let testsFailed = 0

async function setupTestEnv() {
  process.env.HOME = testHome
  await mkdir(testHome, { recursive: true })
}

async function cleanupTestEnv() {
  process.env.HOME = originalHome
  await rm(testHome, { recursive: true, force: true })
}

function clearCredentialEnvVars() {
  const credKeys = [
    'BUILD_CERTIFICATE_BASE64',
    'CAPGO_IOS_PROVISIONING_MAP',
    'CAPGO_IOS_PROVISIONING_MAP_BASE64',
    'P12_PASSWORD',
    'APPLE_KEY_ID',
    'APPLE_ISSUER_ID',
    'APPLE_KEY_CONTENT',
    'APP_STORE_CONNECT_TEAM_ID',
    'ANDROID_KEYSTORE_FILE',
    'KEYSTORE_KEY_ALIAS',
    'KEYSTORE_KEY_PASSWORD',
    'KEYSTORE_STORE_PASSWORD',
    'PLAY_CONFIG_JSON',
    'BUILD_OUTPUT_UPLOAD_ENABLED',
    'BUILD_OUTPUT_RETENTION_SECONDS',
    'CAPGO_ANDROID_FLAVOR',
    'FASTLANE_USER',
    'FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD',
    'APPLE_APP_ID',
    'CAPGO_STORE_SUBMIT_REVIEW',
    'CAPGO_STORE_RELEASE_NAME',
    'CAPGO_STORE_RELEASE_NOTES',
    'CAPGO_STORE_RELEASE_NOTES_LOCALIZED',
    'CAPGO_IOS_TESTFLIGHT_GROUPS',
    'CAPGO_IOS_AUTOMATIC_RELEASE',
  ]
  for (const key of credKeys) {
    delete process.env[key]
  }
}

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
    throw new Error(message || `Expected ${expected}, got ${actual}`)
  }
}

// Import credentials module from the SDK export
// The CLI bundles everything, but the SDK exports are separate
async function importCredentials() {
  // Import from TypeScript source directly since we're testing
  // This requires running in the context where TypeScript can be executed
  const modulePath = '../src/build/credentials.ts'
  try {
    const module = await import(modulePath)
    return module
  }
  catch (err) {
    // Fallback: try to use the bundled SDK if available
    console.error('   Note: Importing from TypeScript source. Make sure you have ts-node or bun.')
    throw err
  }
}

// Test 1: Load credentials from environment variables
await test('Load credentials from environment variables', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  // Set some env vars
  process.env.APPLE_KEY_ID = 'ABC1234567'
  process.env.P12_PASSWORD = 'testpass123'
  process.env.ANDROID_KEYSTORE_FILE = 'base64keystore'

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assertEquals(creds.APPLE_KEY_ID, 'ABC1234567', 'APPLE_KEY_ID should be loaded from env')
  assertEquals(creds.P12_PASSWORD, 'testpass123', 'P12_PASSWORD should be loaded from env')
  assertEquals(creds.ANDROID_KEYSTORE_FILE, 'base64keystore', 'ANDROID_KEYSTORE_FILE should be loaded from env')
  assert(!creds.APPLE_ISSUER_ID, 'Unset env vars should not be in result')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 1b: Load Apple ID + app-specific password credentials from environment
await test('Load app-specific password credentials from environment variables', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  process.env.FASTLANE_USER = 'dev@example.com'
  process.env.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD = 'abcd-efgh-ijkl-mnop'
  process.env.APPLE_APP_ID = '1234567890'

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assertEquals(creds.FASTLANE_USER, 'dev@example.com', 'FASTLANE_USER should be loaded from env')
  assertEquals(creds.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD, 'abcd-efgh-ijkl-mnop', 'app-specific password should be loaded from env')
  assertEquals(creds.APPLE_APP_ID, '1234567890', 'APPLE_APP_ID should be loaded from env')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 2: Merge credentials with proper precedence (CLI > Env > Saved)
await test('Merge credentials with proper precedence', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { updateSavedCredentials, mergeCredentials } = await importCredentials()

  // 1. Save credentials to file (lowest priority)
  await updateSavedCredentials('com.test.app', 'ios', {
    APPLE_KEY_ID: 'SAVED123456',
    P12_PASSWORD: 'savedpass',
    BUILD_CERTIFICATE_BASE64: 'savedcert',
  })

  // 2. Set env vars (middle priority)
  process.env.APPLE_KEY_ID = 'ENV12345678'
  process.env.BUILD_CERTIFICATE_BASE64 = 'envcert'

  // 3. Provide CLI args (highest priority)
  const cliArgs = {
    APPLE_KEY_ID: 'CLI12345678',
  }

  const merged = await mergeCredentials('com.test.app', 'ios', cliArgs)

  // CLI should win
  assertEquals(merged.APPLE_KEY_ID, 'CLI12345678', 'CLI args should take precedence')

  // Env should win over saved
  assertEquals(merged.BUILD_CERTIFICATE_BASE64, 'envcert', 'Env vars should override saved')

  // Saved should be used when nothing else provided
  assertEquals(merged.P12_PASSWORD, 'savedpass', 'Saved credentials should be used as fallback')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 3: Return undefined when no credentials found
await test('Return undefined when no credentials found', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { mergeCredentials } = await importCredentials()
  const merged = await mergeCredentials('com.nonexistent.app', 'ios')

  assertEquals(merged, undefined, 'Should return undefined when no credentials found')

  await cleanupTestEnv()
})

// Test 4: Platform-specific credentials isolation
await test('Platform-specific credentials are isolated', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { updateSavedCredentials, mergeCredentials } = await importCredentials()

  // Save iOS credentials
  await updateSavedCredentials('com.test.app', 'ios', {
    APPLE_KEY_ID: 'IOSKEY12345',
    P12_PASSWORD: 'iospass',
  })

  // Save Android credentials
  await updateSavedCredentials('com.test.app', 'android', {
    KEYSTORE_KEY_ALIAS: 'androidalias',
    KEYSTORE_KEY_PASSWORD: 'androidpass',
  })

  // Get iOS credentials
  const iosCreds = await mergeCredentials('com.test.app', 'ios')
  assertEquals(iosCreds.APPLE_KEY_ID, 'IOSKEY12345', 'Should get iOS credentials')
  assert(!iosCreds.KEYSTORE_KEY_ALIAS, 'Should not get Android credentials in iOS')

  // Get Android credentials
  const androidCreds = await mergeCredentials('com.test.app', 'android')
  assertEquals(androidCreds.KEYSTORE_KEY_ALIAS, 'androidalias', 'Should get Android credentials')
  assert(!androidCreds.APPLE_KEY_ID, 'Should not get iOS credentials in Android')

  await cleanupTestEnv()
})

// Test 5: Environment variables work for all credential types
await test('All credential types can be loaded from environment', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  // Set all iOS credential env vars
  process.env.BUILD_CERTIFICATE_BASE64 = 'cert'
  process.env.CAPGO_IOS_PROVISIONING_MAP = '{"com.test.app":{"profile":"base64","name":"test"}}'
  process.env.P12_PASSWORD = 'pass'
  process.env.APPLE_KEY_ID = 'keyid'
  process.env.APPLE_ISSUER_ID = 'issuerid'
  process.env.APPLE_KEY_CONTENT = 'keycontent'
  process.env.APP_STORE_CONNECT_TEAM_ID = 'teamid'

  // Set all Android credential env vars
  process.env.ANDROID_KEYSTORE_FILE = 'keystore'
  process.env.KEYSTORE_KEY_ALIAS = 'alias'
  process.env.KEYSTORE_KEY_PASSWORD = 'keypass'
  process.env.KEYSTORE_STORE_PASSWORD = 'storepass'
  process.env.PLAY_CONFIG_JSON = 'playconfig'

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  // Check iOS
  assertEquals(creds.BUILD_CERTIFICATE_BASE64, 'cert')
  assertEquals(creds.CAPGO_IOS_PROVISIONING_MAP, '{"com.test.app":{"profile":"base64","name":"test"}}')
  assertEquals(creds.P12_PASSWORD, 'pass')
  assertEquals(creds.APPLE_KEY_ID, 'keyid')
  assertEquals(creds.APPLE_ISSUER_ID, 'issuerid')

  // Check Android
  assertEquals(creds.ANDROID_KEYSTORE_FILE, 'keystore')
  assertEquals(creds.KEYSTORE_KEY_ALIAS, 'alias')
  assertEquals(creds.KEYSTORE_KEY_PASSWORD, 'keypass')
  assertEquals(creds.PLAY_CONFIG_JSON, 'playconfig')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 6: CLI args override everything
await test('CLI args override both env vars and saved credentials', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { updateSavedCredentials, mergeCredentials } = await importCredentials()

  // Saved: value1
  await updateSavedCredentials('com.test.app', 'ios', {
    APPLE_KEY_ID: 'SAVED123456',
  })

  // Env: value2
  process.env.APPLE_KEY_ID = 'ENV12345678'

  // CLI: value3
  const cliArgs = {
    APPLE_KEY_ID: 'CLI12345678',
  }

  const merged = await mergeCredentials('com.test.app', 'ios', cliArgs)

  assertEquals(merged.APPLE_KEY_ID, 'CLI12345678', 'CLI args must override everything')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 7: Output options follow CLI > Env > Saved precedence
await test('Output options follow CLI > Env > Saved precedence', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { updateSavedCredentials, mergeCredentials } = await importCredentials()

  // Saved credentials (lowest priority)
  await updateSavedCredentials('com.test.app', 'ios', {
    BUILD_OUTPUT_UPLOAD_ENABLED: 'false',
    BUILD_OUTPUT_RETENTION_SECONDS: '3600',
  })

  // Env vars (middle priority)
  process.env.BUILD_OUTPUT_UPLOAD_ENABLED = 'true'
  process.env.BUILD_OUTPUT_RETENTION_SECONDS = '2h'

  // CLI args (highest priority)
  const merged = await mergeCredentials('com.test.app', 'ios', {
    BUILD_OUTPUT_UPLOAD_ENABLED: 'false',
    BUILD_OUTPUT_RETENTION_SECONDS: '14400',
  })

  assertEquals(merged.BUILD_OUTPUT_UPLOAD_ENABLED, 'false', 'CLI output upload should override env and saved')
  assertEquals(merged.BUILD_OUTPUT_RETENTION_SECONDS, '14400', 'CLI output retention should override env and saved')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 8: Env output retention accepts unit durations and normalizes to seconds
await test('Environment output retention with unit is normalized to seconds', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { loadCredentialsFromEnv } = await importCredentials()

  process.env.BUILD_OUTPUT_RETENTION_SECONDS = '3h'
  const creds = loadCredentialsFromEnv()

  assertEquals(creds.BUILD_OUTPUT_RETENTION_SECONDS, '10800', 'Env output retention should be normalized to seconds')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 9: CAPGO_ANDROID_FLAVOR is loaded from environment
await test('CAPGO_ANDROID_FLAVOR is loaded from environment', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  process.env.CAPGO_ANDROID_FLAVOR = 'dev'

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assertEquals(creds.CAPGO_ANDROID_FLAVOR, 'dev', 'CAPGO_ANDROID_FLAVOR should be loaded from env')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 10: CAPGO_ANDROID_FLAVOR empty string is not loaded
await test('CAPGO_ANDROID_FLAVOR empty string is not loaded', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  process.env.CAPGO_ANDROID_FLAVOR = ''

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assert(!creds.CAPGO_ANDROID_FLAVOR, 'Empty CAPGO_ANDROID_FLAVOR should not be in result')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 10b: CAPGO_ANDROID_FLAVOR whitespace-only env var is trimmed and ignored
await test('CAPGO_ANDROID_FLAVOR whitespace-only env var is ignored', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  process.env.CAPGO_ANDROID_FLAVOR = '   '

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assert(!creds.CAPGO_ANDROID_FLAVOR, 'Whitespace-only CAPGO_ANDROID_FLAVOR should not be in result')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 10c: CAPGO_ANDROID_FLAVOR env var with surrounding whitespace is trimmed
await test('CAPGO_ANDROID_FLAVOR env var is trimmed', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  process.env.CAPGO_ANDROID_FLAVOR = '  dev  '

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assertEquals(creds.CAPGO_ANDROID_FLAVOR, 'dev', 'CAPGO_ANDROID_FLAVOR should be trimmed')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 11: CAPGO_ANDROID_FLAVOR participates in credential merge precedence
await test('CAPGO_ANDROID_FLAVOR follows CLI > Env > Saved precedence', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { updateSavedCredentials, mergeCredentials } = await importCredentials()

  // Saved: flavor1
  await updateSavedCredentials('com.test.app', 'android', {
    CAPGO_ANDROID_FLAVOR: 'saved_flavor',
    KEYSTORE_KEY_ALIAS: 'alias',
  })

  // Env: flavor2
  process.env.CAPGO_ANDROID_FLAVOR = 'env_flavor'

  // No CLI override — env should win over saved
  const merged = await mergeCredentials('com.test.app', 'android')
  assertEquals(merged.CAPGO_ANDROID_FLAVOR, 'env_flavor', 'Env CAPGO_ANDROID_FLAVOR should override saved')

  // CLI override — CLI should win
  const mergedWithCli = await mergeCredentials('com.test.app', 'android', {
    CAPGO_ANDROID_FLAVOR: 'cli_flavor',
  })
  assertEquals(mergedWithCli.CAPGO_ANDROID_FLAVOR, 'cli_flavor', 'CLI CAPGO_ANDROID_FLAVOR should override env and saved')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Test 12: CAPGO_ANDROID_FLAVOR is isolated to android platform
await test('CAPGO_ANDROID_FLAVOR is isolated to android platform', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { updateSavedCredentials, mergeCredentials } = await importCredentials()

  // Save flavor in android credentials
  await updateSavedCredentials('com.test.app', 'android', {
    CAPGO_ANDROID_FLAVOR: 'dev',
    KEYSTORE_KEY_ALIAS: 'alias',
  })

  // Save some iOS credentials
  await updateSavedCredentials('com.test.app', 'ios', {
    APPLE_KEY_ID: 'IOSKEY12345',
  })

  // iOS merge should not contain CAPGO_ANDROID_FLAVOR
  const iosCreds = await mergeCredentials('com.test.app', 'ios')
  assert(!iosCreds.CAPGO_ANDROID_FLAVOR, 'CAPGO_ANDROID_FLAVOR should not leak into iOS credentials')

  // Android merge should contain it
  const androidCreds = await mergeCredentials('com.test.app', 'android')
  assertEquals(androidCreds.CAPGO_ANDROID_FLAVOR, 'dev', 'CAPGO_ANDROID_FLAVOR should be in Android credentials')

  await cleanupTestEnv()
})

// ─── Test: --no-playstore-upload nulls out PLAY_CONFIG_JSON ──────────────────

await test('--no-playstore-upload: deleting PLAY_CONFIG_JSON removes it from credentials', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const { updateSavedCredentials, mergeCredentials } = await importCredentials()

  // Save android credentials including PLAY_CONFIG_JSON
  await updateSavedCredentials('com.test.app', 'android', {
    ANDROID_KEYSTORE_FILE: 'keystoredata',
    KEYSTORE_KEY_ALIAS: 'myalias',
    KEYSTORE_KEY_PASSWORD: 'keypass',
    KEYSTORE_STORE_PASSWORD: 'storepass',
    PLAY_CONFIG_JSON: '{"type":"service_account"}',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
  })

  const merged = await mergeCredentials('com.test.app', 'android')

  // Verify PLAY_CONFIG_JSON is present before deletion
  assert(merged.PLAY_CONFIG_JSON === '{"type":"service_account"}', 'PLAY_CONFIG_JSON should be present before deletion')

  // Simulate --no-playstore-upload: delete PLAY_CONFIG_JSON
  delete merged.PLAY_CONFIG_JSON

  assert(!('PLAY_CONFIG_JSON' in merged), 'PLAY_CONFIG_JSON should not be in credentials after deletion')
  assertEquals(merged.ANDROID_KEYSTORE_FILE, 'keystoredata', 'Other credentials should remain')
  assertEquals(merged.BUILD_OUTPUT_UPLOAD_ENABLED, 'true', 'Output upload should still be enabled')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// ─── Test: CAPGO_IOS_PROVISIONING_MAP_BASE64 is decoded into the JSON form ───

await test('CAPGO_IOS_PROVISIONING_MAP_BASE64 is base64-decoded to the JSON form', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const json = '{"com.test.app":{"profile":"base64data","name":"match AppStore com.test.app"}}'
  process.env.CAPGO_IOS_PROVISIONING_MAP_BASE64 = Buffer.from(json, 'utf-8').toString('base64')

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assertEquals(creds.CAPGO_IOS_PROVISIONING_MAP, json, 'BASE64 form must be decoded to raw JSON')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

await test('CAPGO_IOS_PROVISIONING_MAP takes precedence over the BASE64 form', async () => {
  await setupTestEnv()
  clearCredentialEnvVars()

  const rawJson = '{"com.test.app":{"profile":"raw","name":"raw"}}'
  const otherJson = '{"com.test.app":{"profile":"b64","name":"b64"}}'
  process.env.CAPGO_IOS_PROVISIONING_MAP = rawJson
  process.env.CAPGO_IOS_PROVISIONING_MAP_BASE64 = Buffer.from(otherJson, 'utf-8').toString('base64')

  const { loadCredentialsFromEnv } = await importCredentials()
  const creds = loadCredentialsFromEnv()

  assertEquals(creds.CAPGO_IOS_PROVISIONING_MAP, rawJson, 'Raw JSON form must win over BASE64')

  clearCredentialEnvVars()
  await cleanupTestEnv()
})

// Print summary
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
