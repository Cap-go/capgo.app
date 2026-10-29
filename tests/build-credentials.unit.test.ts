import { afterEach, describe, expect, it, vi } from 'vitest'
import { unwrapSavedCredentialsFile } from '../supabase/functions/_backend/public/build/credentials.ts'
import {
  buildCredentialsKeyVersion,
  createBuildCredentialsUploadToken,
  getBuildCredentialsKeyring,
  openBuildCredentials,
  sealBuildCredentials,
  verifyBuildCredentialsUploadToken,
} from '../supabase/functions/_backend/utils/build_credentials_crypto.ts'
import {
  assertAllowedCredentialKey,
  assertStorableCredentialKeys,
  BuildCredentialsValidationError,
  checkCredentialRequirements,
  mergeStoredCredentialsForBuild,
  normalizeCredentialValues,
  parseCredentialRecord,
  isStoredReservedEnvKey,
  readMobileprovisionExpiry,
  summarizeCredentials,
} from '../supabase/functions/_backend/utils/build_credentials_validation.ts'
import { isSecretBodyRoute, redactSensitiveUrl } from '../supabase/functions/_backend/utils/sensitive_url.ts'

const SECRET = 'test-build-credentials-secret-0123456789abcdef'
const OTHER_SECRET = 'other-build-credentials-secret-0123456789abcdef'

function b64(value: string) {
  return Buffer.from(value, 'utf8').toString('base64')
}

const profileBase64 = b64('garbage<?xml version="1.0"?><plist><dict><key>ExpirationDate</key>\n<date>2027-03-01T12:00:00Z</date></dict></plist>garbage')
const provisioningMap = JSON.stringify({ 'com.test.app': { profile: profileBase64, name: 'App Store Profile' } })

const completeIos = {
  BUILD_CERTIFICATE_BASE64: 'cert',
  P12_PASSWORD: 'p12',
  CAPGO_IOS_PROVISIONING_MAP: provisioningMap,
  APPLE_KEY_ID: 'KEYID',
  APPLE_ISSUER_ID: 'issuer',
  APPLE_KEY_CONTENT: 'p8',
  APP_STORE_CONNECT_TEAM_ID: 'TEAM123',
}

const completeAndroid = {
  ANDROID_KEYSTORE_FILE: 'keystore',
  KEYSTORE_KEY_ALIAS: 'alias',
  KEYSTORE_KEY_PASSWORD: 'pw',
  PLAY_CONFIG_JSON: 'play',
}

function expectValidationError(fn: () => unknown, message: string | RegExp) {
  expect(fn).toThrow(BuildCredentialsValidationError)
  expect(fn).toThrow(message)
}

describe('build credentials crypto', () => {
  it.concurrent('round-trips and binds the ciphertext to app_id + platform', async () => {
    const sealed = await sealBuildCredentials({ secret: SECRET, appId: 'com.test.app', platform: 'ios', credentials: completeIos })
    expect(sealed.ciphertext).toMatch(/^v1:/)
    expect(sealed.ciphertext).not.toContain('cert')
    expect(sealed.keyVersion).toBe(await buildCredentialsKeyVersion(SECRET))

    const opened = await openBuildCredentials({ keyring: { current: SECRET }, appId: 'com.test.app', platform: 'ios', ...sealed })
    expect(opened.credentials).toEqual(completeIos)
    expect(opened.needsReseal).toBe(false)

    await expect(openBuildCredentials({ keyring: { current: SECRET }, appId: 'com.other.app', platform: 'ios', ...sealed })).rejects.toThrow()
    await expect(openBuildCredentials({ keyring: { current: SECRET }, appId: 'com.test.app', platform: 'android', ...sealed })).rejects.toThrow()
  })

  it.concurrent('supports key rotation through the previous key', async () => {
    const sealed = await sealBuildCredentials({ secret: OTHER_SECRET, appId: 'com.test.app', platform: 'android', credentials: completeAndroid })
    const opened = await openBuildCredentials({ keyring: { current: SECRET, previous: OTHER_SECRET }, appId: 'com.test.app', platform: 'android', ...sealed })
    expect(opened.credentials).toEqual(completeAndroid)
    expect(opened.needsReseal).toBe(true)
    await expect(openBuildCredentials({ keyring: { current: SECRET }, appId: 'com.test.app', platform: 'android', ...sealed })).rejects.toThrow('unknown key version')
  })

  it.concurrent('rejects tampered ciphertext', async () => {
    const sealed = await sealBuildCredentials({ secret: SECRET, appId: 'com.test.app', platform: 'ios', credentials: completeIos })
    const [v, iv, ct] = sealed.ciphertext.split(':')
    // Flip a character that is always changed (not the last one, whose low bits may be padding).
    const target = ct!.at(-2)
    const tampered = `${v}:${iv}:${ct!.slice(0, -2)}${target === 'A' ? 'B' : 'A'}${ct!.slice(-1)}`
    await expect(openBuildCredentials({ keyring: { current: SECRET }, appId: 'com.test.app', platform: 'ios', ciphertext: tampered, keyVersion: sealed.keyVersion })).rejects.toThrow()
  })

  it.concurrent('signs and verifies upload tokens', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const claims = { app_id: 'com.test.app', platform: 'ios' as const, mode: 'merge' as const, user_id: 'user-1', apikey_id: 42, exp }
    const token = await createBuildCredentialsUploadToken(SECRET, claims)
    const ok = await verifyBuildCredentialsUploadToken(SECRET, token)
    expect(ok.ok).toBe(true)
    if (ok.ok)
      expect(ok.claims).toMatchObject(claims)

    expect(await verifyBuildCredentialsUploadToken(OTHER_SECRET, token)).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyBuildCredentialsUploadToken(SECRET, `${token}x`)).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyBuildCredentialsUploadToken(SECRET, token, exp + 1)).toEqual({ ok: false, reason: 'expired' })

    // Payload swap with the original signature must fail.
    const [, signature] = token.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, app_id: 'com.evil.app', nonce: 'x' })).toString('base64url')
    expect(await verifyBuildCredentialsUploadToken(SECRET, `${forgedPayload}.${signature}`)).toEqual({ ok: false, reason: 'invalid' })
  })

  it.concurrent('issues a fresh nonce per token and refuses tokens without one', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const claims = { app_id: 'com.test.app', platform: 'ios' as const, mode: 'replace' as const, user_id: 'user-1', apikey_id: 42, exp }
    const a = await verifyBuildCredentialsUploadToken(SECRET, await createBuildCredentialsUploadToken(SECRET, claims))
    const b = await verifyBuildCredentialsUploadToken(SECRET, await createBuildCredentialsUploadToken(SECRET, claims))
    if (!a.ok || !b.ok)
      throw new Error('expected valid tokens')
    expect(a.claims.nonce).toMatch(/^[\w-]{16}$/)
    expect(a.claims.nonce).not.toBe(b.claims.nonce)

    // A correctly signed payload without a nonce cannot be made single use: refused.
    const { createHmac } = await import('node:crypto')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = createHmac('sha256', SECRET).update(`capgo-build-credentials-upload:v1.${payload}`).digest('base64url')
    expect(await verifyBuildCredentialsUploadToken(SECRET, `${payload}.${signature}`)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('build credentials keyring', () => {
  const c = {} as never
  const apiSecret = 'prod-api-secret-0123456789abcdef'
  const dedicated = 'dedicated-build-credentials-key-0123456789'
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives from API_SECRET when no dedicated key is set', () => {
    vi.stubEnv('BUILD_CREDENTIALS_ENCRYPTION_KEY', '')
    vi.stubEnv('BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS', '')
    vi.stubEnv('API_SECRET', apiSecret)
    expect(getBuildCredentialsKeyring(c)).toEqual({ current: apiSecret, previous: undefined })
  })

  it('prefers the dedicated key and keeps API_SECRET as the implicit previous key', async () => {
    vi.stubEnv('BUILD_CREDENTIALS_ENCRYPTION_KEY', '')
    vi.stubEnv('BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS', '')
    vi.stubEnv('API_SECRET', apiSecret)
    const sealed = await sealBuildCredentials({ secret: getBuildCredentialsKeyring(c).current, appId: 'com.example.app', platform: 'ios', credentials: { P12_PASSWORD: 'p' } })

    vi.stubEnv('BUILD_CREDENTIALS_ENCRYPTION_KEY', dedicated)
    const keyring = getBuildCredentialsKeyring(c)
    expect(keyring).toEqual({ current: dedicated, previous: apiSecret })
    // Rows sealed with the API_SECRET fallback still open, and are flagged for re-sealing.
    const opened = await openBuildCredentials({ keyring, appId: 'com.example.app', platform: 'ios', ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion })
    expect(opened).toEqual({ credentials: { P12_PASSWORD: 'p' }, needsReseal: true })
  })

  it('is unavailable without a usable secret', () => {
    vi.stubEnv('BUILD_CREDENTIALS_ENCRYPTION_KEY', '')
    vi.stubEnv('API_SECRET', 'short')
    expect(() => getBuildCredentialsKeyring(c)).toThrow()
  })
})

describe('build credentials key rules', () => {
  it.concurrent('accepts Capgo keys and custom build env names', () => {
    expect(() => assertAllowedCredentialKey('BUILD_CERTIFICATE_BASE64')).not.toThrow()
    expect(() => assertAllowedCredentialKey('CAPGO_IOS_DISTRIBUTION')).not.toThrow()
    expect(() => assertAllowedCredentialKey('SENTRY_AUTH_TOKEN')).not.toThrow()
  })

  it.concurrent('rejects invalid and reserved names like --build-env', () => {
    expectValidationError(() => assertAllowedCredentialKey('lower_case'), 'env var names must be uppercase letters, digits and _')
    expectValidationError(() => assertAllowedCredentialKey('JOB_ID'), '--build-env JOB_ID: reserved by Capgo; use the dedicated build option instead')
    expectValidationError(() => assertAllowedCredentialKey('CAPGO_SOMETHING'), 'reserved by Capgo')
    expectValidationError(() => assertAllowedCredentialKey('OUTPUT_UPLOAD_URL_X'), 'reserved by Capgo')
  })

  it.concurrent('refuses to store loader/interpreter env names but keeps normal custom env', () => {
    for (const key of ['NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', 'GRADLE_OPTS', 'BASH_ENV', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'RUBYOPT', 'PERL5OPT', 'PYTHONSTARTUP', 'PATH', 'NPM_CONFIG_NODE_OPTIONS', 'GIT_SSH_COMMAND'])
      expect(isStoredReservedEnvKey(key)).toBe(true)
    for (const key of ['SENTRY_AUTH_TOKEN', 'P12_PASSWORD', 'ORG_GRADLE_PROJECT_MAPS_KEY', 'NPM_TOKEN'])
      expect(isStoredReservedEnvKey(key)).toBe(false)
    // Still valid per-build --build-env names (published CLIs unchanged).
    expect(() => parseCredentialRecord({ NODE_OPTIONS: '--max-old-space-size=4096' })).not.toThrow()
    expectValidationError(() => assertStorableCredentialKeys({ SENTRY_AUTH_TOKEN: 'x', NODE_OPTIONS: 'y', LD_PRELOAD: 'z' }), 'LD_PRELOAD, NODE_OPTIONS: cannot be stored on Capgo because they change how build tools load code')
    expect(() => assertStorableCredentialKeys({ SENTRY_AUTH_TOKEN: 'x' })).not.toThrow()
  })

  it.concurrent('requires a flat record of strings', () => {
    expectValidationError(() => parseCredentialRecord([]), 'must be a JSON object')
    expectValidationError(() => parseCredentialRecord({ P12_PASSWORD: 1 }), 'credentials.P12_PASSWORD must be a string')
  })
})

describe('build credentials normalizers', () => {
  it.concurrent('normalizes booleans, track, status, priority, retention and xcode version', () => {
    const out = normalizeCredentialValues('android', {
      BUILD_OUTPUT_UPLOAD_ENABLED: 'yes',
      SKIP_BUILD_NUMBER_BUMP: '0',
      PLAY_STORE_TRACK: 'Beta',
      PLAY_STORE_RELEASE_STATUS: 'inprogress',
      PLAY_STORE_IN_APP_UPDATE_PRIORITY: '3',
      BUILD_OUTPUT_RETENTION_SECONDS: '2h',
      KEYSTORE_STORE_PASSWORD: 'only-store',
      EMPTY_VALUE: '   ',
    })
    expect(out).toMatchObject({
      BUILD_OUTPUT_UPLOAD_ENABLED: 'true',
      SKIP_BUILD_NUMBER_BUMP: 'false',
      PLAY_STORE_TRACK: 'beta',
      PLAY_STORE_RELEASE_STATUS: 'inProgress',
      PLAY_STORE_IN_APP_UPDATE_PRIORITY: '3',
      BUILD_OUTPUT_RETENTION_SECONDS: '7200',
      KEYSTORE_KEY_PASSWORD: 'only-store',
      KEYSTORE_STORE_PASSWORD: 'only-store',
    })
    expect(out).not.toHaveProperty('EMPTY_VALUE')
    expect(normalizeCredentialValues('ios', { CAPGO_IOS_XCODE_VERSION: 'Xcode 26.1' }).CAPGO_IOS_XCODE_VERSION).toBe('26.1')
  })

  it.concurrent('decodes the base64 provisioning map alias', () => {
    const out = normalizeCredentialValues('ios', { CAPGO_IOS_PROVISIONING_MAP_BASE64: b64(provisioningMap) })
    expect(out.CAPGO_IOS_PROVISIONING_MAP).toBe(provisioningMap)
    expect(out).not.toHaveProperty('CAPGO_IOS_PROVISIONING_MAP_BASE64')
  })

  it.concurrent('rejects invalid values with CLI messages', () => {
    expectValidationError(() => normalizeCredentialValues('ios', { CAPGO_IOS_DISTRIBUTION: 'enterprise' }), 'Invalid CAPGO_IOS_DISTRIBUTION value: \'enterprise\'. Must be one of: app_store, ad_hoc')
    expectValidationError(() => normalizeCredentialValues('ios', { CAPGO_IOS_XCODE_VERSION: 'latest' }), 'Use a version like 26, 26.1 or 16.4.1')
    expectValidationError(() => normalizeCredentialValues('android', { PLAY_STORE_TRACK: 'nightly' }), 'android-track must be one of: internal, alpha, beta, production')
    expectValidationError(() => normalizeCredentialValues('android', { PLAY_STORE_IN_APP_UPDATE_PRIORITY: '9' }), 'in-app-update-priority must be an integer between 0 and 5')
    expectValidationError(() => normalizeCredentialValues('android', { BUILD_OUTPUT_RETENTION_SECONDS: '10' }), 'output-retention must be at least 3600 seconds (1h)')
    expectValidationError(() => normalizeCredentialValues('ios', { APPLE_APP_ID: 'abc' }), 'APPLE_APP_ID must be the app\'s numeric App Store Connect id')
    expectValidationError(() => normalizeCredentialValues('ios', { CAPGO_IOS_PROVISIONING_MAP: '{}' }), 'CAPGO_IOS_PROVISIONING_MAP must be a non-empty JSON object')
    expectValidationError(() => normalizeCredentialValues('ios', { BUILD_PROVISION_PROFILE_BASE64: 'legacy' }), 'Legacy provisioning profile format detected. Run: npx @capgo/cli build credentials migrate --platform ios')
  })
})

describe('build credentials requirement matrix', () => {
  it.concurrent('accepts a complete iOS app_store set and defaults distribution', () => {
    const result = checkCredentialRequirements('ios', completeIos)
    expect(result.missing).toEqual([])
    expect(result.credentials.CAPGO_IOS_DISTRIBUTION).toBe('app_store')
  })

  it.concurrent('reports missing iOS requirements', () => {
    const { missing } = checkCredentialRequirements('ios', {})
    expect(missing).toContain('BUILD_CERTIFICATE_BASE64 (or --build-certificate-base64)')
    expect(missing).toContain('CAPGO_IOS_PROVISIONING_MAP (use --ios-provisioning-profile or save via "build credentials save")')
    expect(missing).toContain('APP_STORE_CONNECT_TEAM_ID (or --app-store-connect-team-id)')
    expect(missing.some(m => m.includes('build has no output destination'))).toBe(true)
  })

  it.concurrent('handles iOS upload auth variants', () => {
    const base = { BUILD_CERTIFICATE_BASE64: 'c', CAPGO_IOS_PROVISIONING_MAP: provisioningMap, APP_STORE_CONNECT_TEAM_ID: 'T' }
    expect(checkCredentialRequirements('ios', { ...base, FASTLANE_USER: 'u', FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'p', APPLE_APP_ID: '123' }).missing).toEqual([])
    expect(checkCredentialRequirements('ios', { ...base, FASTLANE_USER: 'u' }).missing[0]).toMatch(/^Incomplete app-specific password credentials - missing: FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD/)
    expect(checkCredentialRequirements('ios', { ...base, APPLE_KEY_ID: 'k' }).missing[0]).toMatch(/^Incomplete App Store Connect API key - missing: APPLE_ISSUER_ID/)
    expect(checkCredentialRequirements('ios', { ...base, BUILD_OUTPUT_UPLOAD_ENABLED: 'true' }).missing[0]).toMatch(/--skip-build-number-bump and --skip-marketing-version-bump/)
    expect(checkCredentialRequirements('ios', { ...base, BUILD_OUTPUT_UPLOAD_ENABLED: 'true', SKIP_BUILD_NUMBER_BUMP: 'true', SKIP_MARKETING_VERSION_BUMP: 'true' }).missing).toEqual([])
    expect(checkCredentialRequirements('ios', { ...base, CAPGO_IOS_DISTRIBUTION: 'ad_hoc' }).missing).toEqual([])
  })

  it.concurrent('requires app_store + API key for iOS store review submission', () => {
    expect(checkCredentialRequirements('ios', { ...completeIos, CAPGO_IOS_DISTRIBUTION: 'ad_hoc', CAPGO_STORE_SUBMIT_REVIEW: 'true' }).missing)
      .toContain('--submit-to-store-review on iOS requires --ios-distribution app_store')
  })

  it.concurrent('applies the Android matrix', () => {
    expect(checkCredentialRequirements('android', completeAndroid).missing).toEqual([])
    const { missing } = checkCredentialRequirements('android', { ANDROID_KEYSTORE_FILE: 'k', KEYSTORE_KEY_ALIAS: 'a', KEYSTORE_KEY_PASSWORD: 'p' })
    expect(missing).toEqual(['PLAY_CONFIG_JSON or BUILD_OUTPUT_UPLOAD_ENABLED=true (build has no output destination - enable either Play Store upload or Capgo download link)'])
    expect(checkCredentialRequirements('android', { ANDROID_KEYSTORE_FILE: 'k', KEYSTORE_KEY_ALIAS: 'a', KEYSTORE_KEY_PASSWORD: 'p', CAPGO_STORE_SUBMIT_REVIEW: 'true' }).missing)
      .toEqual(['PLAY_CONFIG_JSON is required for --submit-to-store-review on Android'])
    expect(checkCredentialRequirements('android', {}).missing).toContain('KEYSTORE_KEY_PASSWORD or KEYSTORE_STORE_PASSWORD (at least one password required)')
  })
})

describe('mergeStoredCredentialsForBuild', () => {
  it.concurrent('layers stored < request credentials < request build_options and splits like the CLI', () => {
    const result = mergeStoredCredentialsForBuild({
      platform: 'ios',
      stored: { ...completeIos, CAPGO_IOS_DISTRIBUTION: 'ad_hoc', CAPGO_IOS_SCHEME: 'StoredScheme', BUILD_OUTPUT_UPLOAD_ENABLED: 'true', SENTRY_AUTH_TOKEN: 'stored' },
      requestCredentials: { SENTRY_AUTH_TOKEN: 'request' },
      requestBuildOptions: { platform: 'ios', buildMode: 'release', cliVersion: '8.0.0', iosDistribution: 'app_store' },
    })
    expect(result.buildOptions).toMatchObject({
      iosDistribution: 'app_store',
      iosScheme: 'StoredScheme',
      outputUploadEnabled: true,
      outputRetentionSeconds: 3600,
      cliVersion: '8.0.0',
    })
    expect(result.buildCredentials.SENTRY_AUTH_TOKEN).toBe('request')
    expect(result.buildCredentials.BUILD_CERTIFICATE_BASE64).toBe('cert')
    // Non-secret options never reach build_credentials.
    expect(result.buildCredentials).not.toHaveProperty('CAPGO_IOS_DISTRIBUTION')
    expect(result.buildCredentials).not.toHaveProperty('CAPGO_IOS_SCHEME')
    expect(result.buildCredentials).not.toHaveProperty('BUILD_OUTPUT_UPLOAD_ENABLED')
  })

  it.concurrent('keeps symbols upload off by default and maps the stored opt-in to build_options', () => {
    const base = { platform: 'ios', requestCredentials: {}, requestBuildOptions: {} } as const
    expect(mergeStoredCredentialsForBuild({ ...base, stored: completeIos }).buildOptions.symbolsUploadEnabled).toBe(false)
    const result = mergeStoredCredentialsForBuild({ ...base, stored: { ...completeIos, BUILD_SYMBOLS_UPLOAD_ENABLED: 'yes' } })
    expect(result.buildOptions.symbolsUploadEnabled).toBe(true)
    expect(result.buildCredentials).not.toHaveProperty('BUILD_SYMBOLS_UPLOAD_ENABLED')
  })

  it.concurrent('ignores loader env names in stored credentials but keeps request (--build-env) ones', () => {
    const result = mergeStoredCredentialsForBuild({
      platform: 'android',
      stored: { ...completeAndroid, NODE_OPTIONS: '--require /tmp/evil.js', LD_PRELOAD: '/tmp/evil.so' },
      requestCredentials: { JAVA_TOOL_OPTIONS: '-Xmx4g' },
      requestBuildOptions: {},
    })
    expect(result.buildCredentials).not.toHaveProperty('NODE_OPTIONS')
    expect(result.buildCredentials).not.toHaveProperty('LD_PRELOAD')
    expect(result.buildCredentials.JAVA_TOOL_OPTIONS).toBe('-Xmx4g')
  })

  it.concurrent('throws the CLI missing-credentials message', () => {
    expect(() => mergeStoredCredentialsForBuild({ platform: 'android', stored: { KEYSTORE_KEY_ALIAS: 'a' }, requestCredentials: {}, requestBuildOptions: {} }))
      .toThrow(/^Missing required credentials for android: ANDROID_KEYSTORE_FILE \(or --android-keystore-file\)/)
  })

  it.concurrent('drops PLAY_CONFIG_JSON with playstoreUpload=false (--no-playstore-upload)', () => {
    expect(() => mergeStoredCredentialsForBuild({ platform: 'android', stored: completeAndroid, requestCredentials: {}, requestBuildOptions: {}, playstoreUpload: false }))
      .toThrow('PLAY_CONFIG_JSON or BUILD_OUTPUT_UPLOAD_ENABLED=true')
    const result = mergeStoredCredentialsForBuild({ platform: 'android', stored: completeAndroid, requestCredentials: {}, requestBuildOptions: { outputUploadEnabled: true }, playstoreUpload: false })
    expect(result.buildCredentials).not.toHaveProperty('PLAY_CONFIG_JSON')
    expect(result.buildCredentials.KEYSTORE_STORE_PASSWORD).toBe('pw')
  })
})

describe('summarizeCredentials', () => {
  it.concurrent('returns key names and non-secret facts only', () => {
    const summary = summarizeCredentials('ios', { ...completeIos, SENTRY_AUTH_TOKEN: 'tok' })
    expect(summary).toMatchObject({
      platform: 'ios',
      missing: [],
      ios_distribution: 'app_store',
      app_store_connect_team_id: 'TEAM123',
      ios_upload_auth: 'app_store_connect_api_key',
      custom_build_env_keys: ['SENTRY_AUTH_TOKEN'],
      provisioning_profiles: [{ bundle_id: 'com.test.app', name: 'App Store Profile', expires_at: '2027-03-01T12:00:00.000Z' }],
    })
    const serialized = JSON.stringify(summary)
    for (const secret of ['cert', 'p12', 'p8', 'tok', profileBase64])
      expect(serialized).not.toContain(`"${secret}"`)
    expect(serialized).not.toContain(profileBase64)
  })

  it.concurrent('reads mobileprovision expiry best effort', () => {
    expect(readMobileprovisionExpiry(profileBase64)).toBe('2027-03-01T12:00:00.000Z')
    expect(readMobileprovisionExpiry('not base64 !!')).toBeNull()
  })
})

describe('unwrapSavedCredentialsFile', () => {
  it.concurrent('accepts flat, per-platform and whole-file shapes', () => {
    expect(unwrapSavedCredentialsFile({ P12_PASSWORD: 'x' }, 'com.test.app', 'ios')).toEqual({ P12_PASSWORD: 'x' })
    expect(unwrapSavedCredentialsFile({ ios: { P12_PASSWORD: 'x' } }, 'com.test.app', 'ios')).toEqual({ P12_PASSWORD: 'x' })
    expect(unwrapSavedCredentialsFile({ 'com.test.app': { ios: { P12_PASSWORD: 'x' } }, 'com.other': { ios: { P12_PASSWORD: 'y' } } }, 'com.test.app', 'ios')).toEqual({ P12_PASSWORD: 'x' })
    expect(() => unwrapSavedCredentialsFile({ 'com.test.app': { android: {} } }, 'com.test.app', 'ios')).toThrow('has no ios credentials')
  })
})

describe('sensitive URL helpers', () => {
  it.concurrent('redacts the credentials upload token from URLs', () => {
    expect(redactSensitiveUrl('https://api.capgo.app/build/credentials/upload/abc.def?x=1')).toBe('https://api.capgo.app/build/credentials/upload/[redacted]?x=1')
    expect(redactSensitiveUrl('--> PUT /functions/v1/build/credentials/upload/abc.def 200')).toBe('--> PUT /functions/v1/build/credentials/upload/[redacted] 200')
    expect(redactSensitiveUrl('https://api.capgo.app/build/credentials/upload-url')).toBe('https://api.capgo.app/build/credentials/upload-url')
  })

  it.concurrent('flags routes whose bodies carry signing secrets', () => {
    for (const url of ['https://api.capgo.app/build/request', 'https://api.capgo.app/build/credentials', 'https://x/functions/v1/build/credentials/upload/t', '/build/credentials/upload-url'])
      expect(isSecretBodyRoute(url)).toBe(true)
    for (const url of ['https://api.capgo.app/build/start/job', 'https://api.capgo.app/build/requests', 'https://api.capgo.app/bundle'])
      expect(isSecretBodyRoute(url)).toBe(false)
  })
})
