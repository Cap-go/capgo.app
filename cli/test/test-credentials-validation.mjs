#!/usr/bin/env node
/**
 * Test suite for build credentials validation
 * Tests that the required credentials are properly validated for each platform
 */

console.log('🧪 Testing build credentials validation...\n')

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

// Helper: run iOS validation logic matching request.ts
// Helper: run iOS validation logic matching request.ts
function validateIosCredentials(credentials) {
  const missingCreds = []
  const distributionMode = credentials.CAPGO_IOS_DISTRIBUTION || 'app_store'
  if (credentials.CAPGO_STORE_SUBMIT_REVIEW === 'true' && distributionMode !== 'app_store') {
    missingCreds.push('--submit-to-store-review on iOS requires --ios-distribution app_store')
  }

  if (!credentials.BUILD_CERTIFICATE_BASE64)
    missingCreds.push('BUILD_CERTIFICATE_BASE64')
  if (!credentials.CAPGO_IOS_PROVISIONING_MAP)
    missingCreds.push('CAPGO_IOS_PROVISIONING_MAP')

  // App Store Connect API key validation depends on distribution mode
  if (distributionMode === 'app_store') {
    // app_store mode: needs either an App Store Connect API key OR an Apple ID +
    // app-specific password (e.g. migrated Ionic Appflow apps).
    const hasAppleKeyId = !!credentials.APPLE_KEY_ID
    const hasAppleIssuerId = !!credentials.APPLE_ISSUER_ID
    const hasAppleKeyContent = !!credentials.APPLE_KEY_CONTENT
    const anyAppleApiField = hasAppleKeyId || hasAppleIssuerId || hasAppleKeyContent
    const hasCompleteAppleApiKey = hasAppleKeyId && hasAppleIssuerId && hasAppleKeyContent

    const hasFastlaneUser = !!credentials.FASTLANE_USER
    const hasAppSpecificPassword = !!credentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD
    const hasAppleAppId = !!credentials.APPLE_APP_ID
    const anyAppSpecificField = hasFastlaneUser || hasAppSpecificPassword || hasAppleAppId
    const hasCompleteAppSpecificPassword = hasFastlaneUser && hasAppSpecificPassword && hasAppleAppId

    if (credentials.CAPGO_STORE_SUBMIT_REVIEW === 'true' && !hasCompleteAppleApiKey) {
      missingCreds.push('App Store Connect API key (APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT) is required for --submit-to-store-review on iOS')
    }

    if (hasAppleAppId && !/^\d+$/.test(String(credentials.APPLE_APP_ID).trim())) {
      missingCreds.push('APPLE_APP_ID must be the app\'s numeric App Store Connect id (digits only, e.g. 1234567890)')
    }

    if (hasCompleteAppleApiKey) {
      // App Store Connect API key present — default upload path.
    }
    else if (hasCompleteAppSpecificPassword) {
      // Apple ID + app-specific password present — alternative upload path.
    }
    else if (anyAppSpecificField) {
      const missingAppSpecificFields = []
      if (!hasFastlaneUser)
        missingAppSpecificFields.push('FASTLANE_USER')
      if (!hasAppSpecificPassword)
        missingAppSpecificFields.push('FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD')
      if (!hasAppleAppId)
        missingAppSpecificFields.push('APPLE_APP_ID')
      missingCreds.push(`Incomplete app-specific password credentials - missing: ${missingAppSpecificFields.join(', ')}`)
    }
    else if (anyAppleApiField) {
      const missingAppleFields = []
      if (!hasAppleKeyId)
        missingAppleFields.push('APPLE_KEY_ID')
      if (!hasAppleIssuerId)
        missingAppleFields.push('APPLE_ISSUER_ID')
      if (!hasAppleKeyContent)
        missingAppleFields.push('APPLE_KEY_CONTENT')
      missingCreds.push(`Incomplete App Store Connect API key - missing: ${missingAppleFields.join(', ')}`)
    }
    else if (credentials.BUILD_OUTPUT_UPLOAD_ENABLED !== 'true') {
      missingCreds.push('APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT or app-specific password or BUILD_OUTPUT_UPLOAD_ENABLED=true')
    }
    else if (credentials.SKIP_BUILD_NUMBER_BUMP !== 'true' || credentials.SKIP_MARKETING_VERSION_BUMP !== 'true') {
      missingCreds.push('APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT or app-specific password or --skip-build-number-bump and --skip-marketing-version-bump')
    }
    // else: warn only, no error
  }
  // ad_hoc mode: no API key required at all (no TestFlight, timestamp fallback for build numbers)

  if (!credentials.APP_STORE_CONNECT_TEAM_ID)
    missingCreds.push('APP_STORE_CONNECT_TEAM_ID')

  return missingCreds
}

// Test 1: iOS - no API key + no output upload → error (no destination)
await test('iOS validation errors when no API key and no output upload', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'false',
    // Missing API key, no output upload
  }

  const missingCreds = validateIosCredentials(credentials)

  assert(missingCreds.length === 1, `Should have 1 missing credential, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds[0].includes('BUILD_OUTPUT_UPLOAD_ENABLED'), 'Should suggest enabling output upload')
})

// Test 2: iOS accepts full credentials (API key + everything)
await test('iOS validation accepts complete credentials with API key', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APPLE_KEY_ID: 'keyid',
    APPLE_ISSUER_ID: 'issuerid',
    APPLE_KEY_CONTENT: 'keycontent',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 0, `Should have no missing credentials, got: ${missingCreds.join(', ')}`)
})

// Test 2b: iOS - no API key + output upload + no skip-build-number-bump → error
await test('iOS validation errors when no API key with output upload but no skip-build-number-bump', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
    // No API key, no skip-build-number-bump
  }

  const missingCreds = validateIosCredentials(credentials)

  assert(missingCreds.length === 1, `Should have 1 missing credential, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds[0].includes('skip-build-number-bump'), 'Should require skip-build-number-bump')
})

// Test 2c: iOS - no API key + output upload + only skip-build-number-bump → error
await test('iOS validation requires skip-marketing-version-bump without App Store Connect credentials', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
    SKIP_BUILD_NUMBER_BUMP: 'true',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 1, `Should have 1 missing credential, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds[0].includes('skip-marketing-version-bump'), 'Should require skip-marketing-version-bump')
})

// Test 2d: iOS - no API key + output upload + both skip flags → allow (warn only)
await test('iOS validation allows output upload without App Store Connect credentials when both version bumps are skipped', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
    SKIP_BUILD_NUMBER_BUMP: 'true',
    SKIP_MARKETING_VERSION_BUMP: 'true',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 0, `Should have no missing credentials, got: ${missingCreds.join(', ')}`)
})


// Test 4: Android requires minimum credentials
await test('Android validation requires keystore and passwords', () => {
  const credentials = {
    ANDROID_KEYSTORE_FILE: 'keystore',
    KEYSTORE_KEY_ALIAS: 'alias',
    KEYSTORE_KEY_PASSWORD: 'keypass',
    KEYSTORE_STORE_PASSWORD: 'storepass',
  }

  const missingCreds = []

  if (!credentials.ANDROID_KEYSTORE_FILE)
    missingCreds.push('ANDROID_KEYSTORE_FILE')
  if (!credentials.KEYSTORE_KEY_ALIAS)
    missingCreds.push('KEYSTORE_KEY_ALIAS')
  if (!credentials.KEYSTORE_KEY_PASSWORD)
    missingCreds.push('KEYSTORE_KEY_PASSWORD')
  if (!credentials.KEYSTORE_STORE_PASSWORD)
    missingCreds.push('KEYSTORE_STORE_PASSWORD')

  assert(missingCreds.length === 0, 'Should have no missing credentials')
})

// Test 5: Android fails without keystore
await test('Android validation fails without keystore file', () => {
  const credentials = {
    // Missing ANDROID_KEYSTORE_FILE
    KEYSTORE_KEY_ALIAS: 'alias',
    KEYSTORE_KEY_PASSWORD: 'keypass',
    KEYSTORE_STORE_PASSWORD: 'storepass',
  }

  const missingCreds = []

  if (!credentials.ANDROID_KEYSTORE_FILE)
    missingCreds.push('ANDROID_KEYSTORE_FILE')
  if (!credentials.KEYSTORE_KEY_ALIAS)
    missingCreds.push('KEYSTORE_KEY_ALIAS')
  if (!credentials.KEYSTORE_KEY_PASSWORD)
    missingCreds.push('KEYSTORE_KEY_PASSWORD')
  if (!credentials.KEYSTORE_STORE_PASSWORD)
    missingCreds.push('KEYSTORE_STORE_PASSWORD')

  assert(missingCreds.length === 1, 'Should have 1 missing credential')
  assert(missingCreds[0] === 'ANDROID_KEYSTORE_FILE', 'Should require keystore file')
})

// Test 6: Android PLAY_CONFIG_JSON is optional for build
await test('Android validation allows missing PLAY_CONFIG_JSON', () => {
  const credentials = {
    ANDROID_KEYSTORE_FILE: 'keystore',
    KEYSTORE_KEY_ALIAS: 'alias',
    KEYSTORE_KEY_PASSWORD: 'keypass',
    KEYSTORE_STORE_PASSWORD: 'storepass',
    // PLAY_CONFIG_JSON is optional
  }

  const missingCreds = []

  if (!credentials.ANDROID_KEYSTORE_FILE)
    missingCreds.push('ANDROID_KEYSTORE_FILE')
  if (!credentials.KEYSTORE_KEY_ALIAS)
    missingCreds.push('KEYSTORE_KEY_ALIAS')
  if (!credentials.KEYSTORE_KEY_PASSWORD)
    missingCreds.push('KEYSTORE_KEY_PASSWORD')
  if (!credentials.KEYSTORE_STORE_PASSWORD)
    missingCreds.push('KEYSTORE_STORE_PASSWORD')

  // PLAY_CONFIG_JSON not checked in required validation

  assert(missingCreds.length === 0, 'Should have no missing required credentials')
  assert(!credentials.PLAY_CONFIG_JSON, 'PLAY_CONFIG_JSON should be optional')
})

// Test 7: iOS fails with partial API key (2 of 3 fields) — reports specific missing fields
await test('iOS validation fails with incomplete API key and reports missing fields', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APPLE_KEY_ID: 'keyid',
    APPLE_ISSUER_ID: 'issuerid',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'false',
    // Missing APPLE_KEY_CONTENT (incomplete API key) and APP_STORE_CONNECT_TEAM_ID
  }

  const missingCreds = validateIosCredentials(credentials)

  // Should error for: incomplete API key (specific missing field) + missing team ID
  assert(missingCreds.length === 2, `Should have 2 missing credentials, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds.some(c => c.includes('Incomplete App Store Connect API key')), 'Should report incomplete API key')
  assert(missingCreds.some(c => c.includes('APPLE_KEY_CONTENT')), 'Should list APPLE_KEY_CONTENT as missing field')
  assert(missingCreds.some(c => c.includes('APP_STORE_CONNECT_TEAM_ID')), 'Should require APP_STORE_CONNECT_TEAM_ID')
})

// Test 8: iOS partial API key always errors even with output upload enabled
await test('iOS validation fails with incomplete API key even when output upload is enabled', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APPLE_KEY_ID: 'keyid',
    // Missing APPLE_ISSUER_ID and APPLE_KEY_CONTENT
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
    SKIP_BUILD_NUMBER_BUMP: 'true',
  }

  const missingCreds = validateIosCredentials(credentials)

  // Partial API key should always error — output upload doesn't bypass this
  assert(missingCreds.length === 1, `Should have 1 missing credential, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds[0].includes('Incomplete App Store Connect API key'), 'Should report incomplete API key')
  assert(missingCreds[0].includes('APPLE_ISSUER_ID'), 'Should list APPLE_ISSUER_ID as missing')
  assert(missingCreds[0].includes('APPLE_KEY_CONTENT'), 'Should list APPLE_KEY_CONTENT as missing')
})


// Test 9: ad_hoc mode passes without Apple API key
await test('iOS ad_hoc validation passes without Apple API key', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    CAPGO_IOS_DISTRIBUTION: 'ad_hoc',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 0, `Should have no missing credentials, got: ${missingCreds.join(', ')}`)
})

// Test 10: ad_hoc mode still requires cert, profile, team ID
await test('iOS ad_hoc validation still requires cert, profile, team ID', () => {
  const credentials = {
    CAPGO_IOS_DISTRIBUTION: 'ad_hoc',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 3, `Should have 3 missing credentials, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds.includes('BUILD_CERTIFICATE_BASE64'), 'Should require cert')
  assert(missingCreds.includes('CAPGO_IOS_PROVISIONING_MAP'), 'Should require provisioning map')
  assert(missingCreds.includes('APP_STORE_CONNECT_TEAM_ID'), 'Should require team ID')
})

// Test 11: missing/undefined distribution defaults to app_store behavior
await test('iOS validation defaults to app_store when CAPGO_IOS_DISTRIBUTION is undefined', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'false',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 1, `Should have 1 missing credential (API key), got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds[0].includes('BUILD_OUTPUT_UPLOAD_ENABLED'), 'Should require API key or output upload (app_store default)')
})

// Test 12: ad_hoc mode without output upload does NOT fail (explicit opt-in only)
await test('iOS ad_hoc passes without output upload enabled', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    CAPGO_IOS_DISTRIBUTION: 'ad_hoc',
    BUILD_OUTPUT_UPLOAD_ENABLED: 'false',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 0, `Should have no missing credentials, got: ${missingCreds.join(', ')}`)
})

// Test 13: iOS app-specific password (complete) passes without an API key
await test('iOS validation accepts complete Apple ID + app-specific password', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    P12_PASSWORD: 'pass',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    FASTLANE_USER: 'dev@example.com',
    FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
    APPLE_APP_ID: '1234567890',
    // No App Store Connect API key - app-specific password is the upload path
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 0, `Should have no missing credentials, got: ${missingCreds.join(', ')}`)
})

// Test 14: iOS app-specific password missing the numeric app id → error
await test('iOS validation reports missing APPLE_APP_ID for app-specific password', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    FASTLANE_USER: 'dev@example.com',
    FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
    // Missing APPLE_APP_ID
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 1, `Should have 1 missing credential, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds[0].includes('Incomplete app-specific password'), 'Should report incomplete app-specific password')
  assert(missingCreds[0].includes('APPLE_APP_ID'), 'Should list APPLE_APP_ID as missing')
})

// Test 15: iOS app-specific password with only the password set → lists the other two
await test('iOS validation lists all missing app-specific password fields', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
    // Missing FASTLANE_USER and APPLE_APP_ID
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.length === 1, `Should have 1 missing credential, got ${missingCreds.length}: ${missingCreds.join(', ')}`)
  assert(missingCreds[0].includes('FASTLANE_USER'), 'Should list FASTLANE_USER as missing')
  assert(missingCreds[0].includes('APPLE_APP_ID'), 'Should list APPLE_APP_ID as missing')
})

// Test 16: iOS app-specific password with a non-numeric APPLE_APP_ID → error
await test('iOS validation rejects a non-numeric APPLE_APP_ID', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    FASTLANE_USER: 'dev@example.com',
    FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
    APPLE_APP_ID: 'com.test.app', // bundle id by mistake, not the numeric id
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.some(c => c.includes('APPLE_APP_ID must be the app')), `Should reject non-numeric APPLE_APP_ID, got: ${missingCreds.join(', ')}`)
})

// Test 17: iOS store review needs App Store Connect API key, not app-specific password
await test('iOS store review requires App Store Connect API key', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    FASTLANE_USER: 'dev@example.com',
    FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
    APPLE_APP_ID: '1234567890',
    CAPGO_STORE_SUBMIT_REVIEW: 'true',
    CAPGO_IOS_TESTFLIGHT_GROUPS: 'External Testers',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.some(c => c.includes('App Store Connect API key')), `Should require App Store Connect API key, got: ${missingCreds.join(', ')}`)
})

// Test 18: iOS store review is only valid for app_store distribution
await test('iOS store review rejects ad_hoc distribution', () => {
  const credentials = {
    BUILD_CERTIFICATE_BASE64: 'cert',
    CAPGO_IOS_PROVISIONING_MAP: '{"com.test.app":{"profile":"base64","name":"test"}}',
    APP_STORE_CONNECT_TEAM_ID: 'teamid',
    APPLE_KEY_ID: 'keyid',
    APPLE_ISSUER_ID: 'issuerid',
    APPLE_KEY_CONTENT: 'keycontent',
    CAPGO_IOS_DISTRIBUTION: 'ad_hoc',
    CAPGO_STORE_SUBMIT_REVIEW: 'true',
    CAPGO_IOS_TESTFLIGHT_GROUPS: 'External Testers',
  }

  const missingCreds = validateIosCredentials(credentials)
  assert(missingCreds.some(c => c.includes('--ios-distribution app_store')), `Should reject ad_hoc store review, got: ${missingCreds.join(', ')}`)
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
