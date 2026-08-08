// test/prescan/checks-store-access.test.ts
//
// Hermetic: the network-touching validators are injected via the internal
// check factories, so NO real Google/Apple call is ever made. The factories
// also let us assert the precise outcome -> severity mapping (spec section 4)
// and the appliesTo upload-intent gating (spec section 3) without a network.
import type { AscAccessResult } from '../../src/build/onboarding/apple-access'
import type { ValidationResult } from '../../src/build/onboarding/android/service-account-validation'
import type { Finding, ScanContext } from '../../src/build/prescan/types'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import forge from 'node-forge'
import {
  ASC_PRESCAN_AUTH_ENFORCE_AFTER,
  classifyAscAuthFinding,
  makeAscKeyAccess,
  makePlaySaAccess,
  playSaAccess,
} from '../../src/build/prescan/checks/store-access'
import { makeCtx, makeProject } from './helpers'

// ---- shared fixtures -------------------------------------------------------

const PLAY_JSON_B64 = Buffer.from(JSON.stringify({
  type: 'service_account',
  client_email: 'ci@demo.iam.gserviceaccount.com',
  project_id: 'demo-proj',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://oauth2.googleapis.com/token',
}), 'utf8').toString('base64')

function p8KeyContentB64(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return forge.util.encode64(pem)
}

const APPLE_KEY_CONTENT = p8KeyContentB64()

const APPLE_TRIPLET = {
  APPLE_KEY_ID: 'ABCDE12345',
  APPLE_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
  APPLE_KEY_CONTENT,
}

/** A minimal pbxproj that exposes one signable target with our bundle id. */
const PBXPROJ = `// !$*UTF8*$!
{
  objects = {
    AAAA /* App */ = {
      isa = PBXNativeTarget;
      name = App;
      productType = "com.apple.product-type.application";
      buildConfigurationList = LLLL /* config list */;
    };
    LLLL /* config list */ = {
      isa = XCConfigurationList;
      buildConfigurations = ( CCCC /* Release */ );
    };
    CCCC /* Release */ = {
      isa = XCBuildConfiguration;
      name = Release;
      buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.demo.app; };
    };
  };
}
`

function androidCtx(partial: Partial<ScanContext> = {}): ScanContext {
  const dir = makeProject({
    'android/app/build.gradle': 'android {\n  defaultConfig {\n    applicationId "com.demo.app"\n  }\n}\n',
  })
  return makeCtx({
    projectDir: dir,
    platform: 'android',
    credentials: { PLAY_CONFIG_JSON: PLAY_JSON_B64 },
    ...partial,
  })
}

function iosCtx(partial: Partial<ScanContext> = {}): ScanContext {
  const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': PBXPROJ })
  return makeCtx({
    projectDir: dir,
    platform: 'ios',
    distributionMode: 'app_store',
    credentials: { ...APPLE_TRIPLET },
    ...partial,
  })
}

function severities(findings: Finding[]): string[] {
  return findings.map(f => f.severity)
}

// ---- Play: android/play-sa-access -----------------------------------------

describe('android/play-sa-access', () => {
  it('has the spec id and applies only to android', () => {
    expect(playSaAccess.id).toBe('android/play-sa-access')
    expect(playSaAccess.platforms).toEqual(['android'])
    expect(playSaAccess.remote).toBeUndefined()
  })

  it('ok=true -> no findings', async () => {
    let receivedPackage = ''
    const fakeValidator = async (opts: { packageName: string }): Promise<ValidationResult> => {
      receivedPackage = opts.packageName
      return { ok: true, serviceAccountEmail: 'ci@demo.iam.gserviceaccount.com', projectId: 'demo-proj' }
    }
    const check = makePlaySaAccess(fakeValidator)
    const findings = await check.run(androidCtx())
    expect(findings).toEqual([])
    expect(receivedPackage).toBe('com.demo.app')
  })

  it('no-app-access -> error (reuses validator message, SA email is safe)', async () => {
    const message = 'The service account ci@demo.iam.gserviceaccount.com cannot access com.demo.app in Play Console.'
    const fakeValidator = async (): Promise<ValidationResult> => ({
      ok: false,
      kind: 'no-app-access',
      serviceAccountEmail: 'ci@demo.iam.gserviceaccount.com',
      message,
    })
    const check = makePlaySaAccess(fakeValidator)
    const findings = await check.run(androidCtx())
    expect(findings.length).toBe(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.id).toBe('android/play-sa-access')
    expect(findings[0]!.detail).toBe(message)
  })

  it('token-error -> error and does NOT echo the validator message verbatim', async () => {
    const secretish = 'token endpoint said: invalid_grant for key abcdef0123456789abcdef0123456789abcdef'
    const fakeValidator = async (): Promise<ValidationResult> => ({
      ok: false,
      kind: 'token-error',
      message: secretish,
    })
    const check = makePlaySaAccess(fakeValidator)
    const findings = await check.run(androidCtx())
    expect(findings.length).toBe(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.detail ?? '').not.toContain(secretish)
    expect(findings[0]!.title ?? '').not.toContain(secretish)
  })

  it('network-error -> info (offline degrades to non-blocking)', async () => {
    const fakeValidator = async (): Promise<ValidationResult> => ({
      ok: false,
      kind: 'network-error',
      message: 'fetch failed',
    })
    const check = makePlaySaAccess(fakeValidator)
    const findings = await check.run(androidCtx())
    expect(findings.length).toBe(1)
    expect(findings[0]!.severity).toBe('info')
  })

  it('shape-error -> info or skipped (local play-sa-json owns shape)', async () => {
    const fakeValidator = async (): Promise<ValidationResult> => ({
      ok: false,
      kind: 'shape-error',
      message: 'missing private_key',
    })
    const check = makePlaySaAccess(fakeValidator)
    const findings = await check.run(androidCtx())
    expect(findings.every(f => f.severity === 'info')).toBe(true)
    expect(findings.length).toBeLessThanOrEqual(1)
  })

  it('falls back to config.appId then ctx.appId for the package name', async () => {
    let receivedPackage = ''
    const fakeValidator = async (opts: { packageName: string }): Promise<ValidationResult> => {
      receivedPackage = opts.packageName
      return { ok: true, serviceAccountEmail: 'x', projectId: 'y' }
    }
    const check = makePlaySaAccess(fakeValidator)
    // No gradle applicationId on disk -> falls through to config?.appId
    const dir = makeProject({ 'package.json': '{}' })
    const ctx = makeCtx({
      projectDir: dir,
      platform: 'android',
      appId: 'com.fallback.app',
      config: { appId: 'com.config.app' } as any,
      credentials: { PLAY_CONFIG_JSON: PLAY_JSON_B64 },
    })
    await check.run(ctx)
    expect(receivedPackage).toBe('com.config.app')
  })

  it('probes the FLAVORED applicationIdSuffix package, not the bare defaultConfig id', async () => {
    let receivedPackage = ''
    const fakeValidator = async (opts: { packageName: string }): Promise<ValidationResult> => {
      receivedPackage = opts.packageName
      return { ok: true, serviceAccountEmail: 'x', projectId: 'y' }
    }
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    applicationId "com.x.app"
  }
  productFlavors {
    prod {
      applicationIdSuffix ".prod"
    }
  }
}
`,
    })
    const ctx = makeCtx({
      projectDir: dir,
      platform: 'android',
      androidFlavor: 'prod',
      credentials: { PLAY_CONFIG_JSON: PLAY_JSON_B64 },
    })
    await makePlaySaAccess(fakeValidator).run(ctx)
    expect(receivedPackage).toBe('com.x.app.prod')
  })

  it('downgrades no-app-access to a WARNING when the effective package is ambiguous (flavors but no flavor selected)', async () => {
    const fakeValidator = async (): Promise<ValidationResult> => ({
      ok: false,
      kind: 'no-app-access',
      serviceAccountEmail: 'ci@demo.iam.gserviceaccount.com',
      message: 'cannot access com.x.app',
    })
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    applicationId "com.x.app"
  }
  productFlavors {
    prod {
      applicationIdSuffix ".prod"
    }
  }
}
`,
    })
    // No androidFlavor selected, but a productFlavors block exists -> ambiguous.
    const ctx = makeCtx({
      projectDir: dir,
      platform: 'android',
      credentials: { PLAY_CONFIG_JSON: PLAY_JSON_B64 },
    })
    const findings = await makePlaySaAccess(fakeValidator).run(ctx)
    expect(findings.length).toBe(1)
    expect(findings[0]!.severity).toBe('warning')
  })
  // ---- appliesTo gating ----
  it('does NOT apply when PLAY_CONFIG_JSON is absent', () => {
    const ctx = androidCtx({ credentials: {} })
    expect(playSaAccess.appliesTo!(ctx)).toBe(false)
  })

  it('does NOT apply on the ios platform', () => {
    const ctx = makeCtx({
      projectDir: makeProject({ 'package.json': '{}' }),
      platform: 'ios',
      credentials: { PLAY_CONFIG_JSON: PLAY_JSON_B64 },
    })
    expect(playSaAccess.appliesTo!(ctx)).toBe(false)
  })

  it('applies when android + PLAY_CONFIG_JSON present', () => {
    expect(playSaAccess.appliesTo!(androidCtx())).toBe(true)
  })

  it('does NOT leak the PLAY_CONFIG_JSON value into any finding field', async () => {
    const fakeValidator = async (): Promise<ValidationResult> => ({
      ok: false,
      kind: 'token-error',
      message: 'rejected',
    })
    const check = makePlaySaAccess(fakeValidator)
    const findings = await check.run(androidCtx())
    for (const f of findings) {
      const blob = `${f.title}${f.detail ?? ''}${f.fix ?? ''}`
      expect(blob).not.toContain(PLAY_JSON_B64)
    }
  })
})

// ---- Apple: ios/asc-key-access --------------------------------------------

describe('ios/asc-key-access', () => {
  it('ok=true -> no findings, passes decoded PEM + bundle id from pbxproj', async () => {
    let received: { keyId: string, issuerId: string, p8Pem: string, bundleId?: string } | null = null
    const fakeAssert = async (opts: { keyId: string, issuerId: string, p8Pem: string, bundleId?: string }): Promise<AscAccessResult> => {
      received = opts
      return { ok: true }
    }
    const check = makeAscKeyAccess(fakeAssert)
    const findings = await check.run(iosCtx())
    expect(findings).toEqual([])
    expect(received!.keyId).toBe(APPLE_TRIPLET.APPLE_KEY_ID)
    expect(received!.issuerId).toBe(APPLE_TRIPLET.APPLE_ISSUER_ID)
    expect(received!.p8Pem).toContain('BEGIN PRIVATE KEY')
    expect(received!.bundleId).toBe('com.demo.app')
  })

  it('HTTP 401 -> deferred error with Apple reason and a 14-day deadline', async () => {
    const fakeAssert = async (): Promise<AscAccessResult> => ({
      ok: false,
      kind: 'auth-error',
      message: 'API key verification failed.',
      status: 401,
      code: 'NOT_AUTHORIZED',
      title: 'Authentication credentials are missing or invalid.',
      detail: 'Provide a properly configured bearer token.',
    })
    const check = makeAscKeyAccess(fakeAssert)
    const findings = await check.run(iosCtx())
    expect(findings.length).toBe(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.id).toBe('ios/asc-key-access')
    expect(findings[0]!.title).toContain('HTTP 401')
    expect(findings[0]!.title).toContain('Apple rejected')
    expect(findings[0]!.detail).toContain('NOT_AUTHORIZED')
    expect(findings[0]!.detail).toContain('properly configured bearer token')
    expect(findings[0]!.enforceAfter).toBe(ASC_PRESCAN_AUTH_ENFORCE_AFTER)
    expect(ASC_PRESCAN_AUTH_ENFORCE_AFTER).toBe('2026-08-17T00:00:00.000Z')
  })

  it('known agreement HTTP 403 -> deferred error with targeted guidance', async () => {
    const fakeAssert = async (): Promise<AscAccessResult> => ({
      ok: false,
      kind: 'auth-error',
      message: 'Apple requires an agreement.',
      status: 403,
      code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED',
      title: 'A required agreement is missing.',
      detail: 'The Account Holder must accept the agreement.',
    })
    const findings = await makeAscKeyAccess(fakeAssert).run(iosCtx())
    expect(findings[0]).toMatchObject({
      severity: 'error',
      enforceAfter: ASC_PRESCAN_AUTH_ENFORCE_AFTER,
    })
    expect(findings[0]!.title).toContain('HTTP 403')
    expect(findings[0]!.detail).toContain('REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED')
    expect(findings[0]!.fix).toContain('Account Holder')
  })

  it('unknown HTTP 403 -> warning with Apple reason because the probe differs from upload', async () => {
    const fakeAssert = async (): Promise<AscAccessResult> => ({
      ok: false,
      kind: 'auth-error',
      message: 'API key verification failed.',
      status: 403,
      code: 'FORBIDDEN.SOME_NEW_REASON',
      title: 'This operation is forbidden.',
      detail: 'The caller cannot list this resource.',
    })
    const findings = await makeAscKeyAccess(fakeAssert).run(iosCtx())
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.title).toContain('HTTP 403')
    expect(findings[0]!.detail).toContain('FORBIDDEN.SOME_NEW_REASON')
    expect(findings[0]!.detail).toContain('cannot list this resource')
    expect(findings[0]!.detail).toContain('differs from the TestFlight upload path')
    expect(findings[0]!.enforceAfter).toBeUndefined()
  })

  it('no-app-access (2xx but bundle id absent) -> warning', async () => {
    const fakeAssert = async (): Promise<AscAccessResult> => ({
      ok: false,
      kind: 'no-app-access',
      message: 'The App Store Connect API key cannot see an app with bundle id com.demo.app.',
    })
    const check = makeAscKeyAccess(fakeAssert)
    const findings = await check.run(iosCtx())
    expect(findings.length).toBe(1)
    expect(findings[0]!.severity).toBe('warning')
  })

  it('network/timeout -> warning', async () => {
    const fakeAssert = async (): Promise<AscAccessResult> => ({
      ok: false,
      kind: 'network',
      message: 'Could not reach App Store Connect (network error or timeout).',
    })
    const check = makeAscKeyAccess(fakeAssert)
    const findings = await check.run(iosCtx())
    expect(findings.length).toBe(1)
    expect(findings[0]!.severity).toBe('warning')
  })

  it('HTTP 5xx -> warning with the sanitized Apple reason', async () => {
    const fakeAssert = async (): Promise<AscAccessResult> => ({
      ok: false,
      kind: 'network',
      message: 'App Store Connect returned HTTP 503.',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      title: 'Service unavailable',
      detail: 'Try again later.',
    })
    const findings = await makeAscKeyAccess(fakeAssert).run(iosCtx())
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.title).toContain('HTTP 503')
    expect(findings[0]!.detail).toContain('SERVICE_UNAVAILABLE')
    expect(findings[0]!.detail).toContain('Try again later')
  })

  it('classifies a non-auth HTTP status independently without losing its status', () => {
    const finding = classifyAscAuthFinding({
      ok: false,
      kind: 'auth-error',
      message: 'Upstream mentioned HTTP 403 while returning HTTP 500.',
      status: 500,
      code: 'INTERNAL_ERROR',
      title: 'Internal error',
      detail: 'Retry later.',
    })
    expect(finding).toMatchObject({
      severity: 'warning',
      title: 'App Store Connect preflight returned HTTP 500',
    })
    expect(finding.detail).toContain('INTERNAL_ERROR')
  })

  it('local JWT signing failure names Apple key material', () => {
    const finding = classifyAscAuthFinding({
      ok: false,
      kind: 'auth-error',
      message: 'Invalid App Store Connect key material (.p8 / Key ID / Issuer ID). The CLI could not build a JWT, so Apple was never contacted.',
    })
    expect(finding.severity).toBe('error')
    expect(finding.title).toBe('Invalid App Store Connect key material (.p8 / Key ID / Issuer ID)')
    expect(finding.title).not.toContain('Could not authenticate')
    expect(finding.fix ?? '').toContain('App Store Connect API key')
  })

  it('skips cleanly (no finding) when APPLE_KEY_CONTENT does not decode to a PEM', async () => {
    let called = false
    const fakeAssert = async (): Promise<AscAccessResult> => {
      called = true
      return { ok: true }
    }
    const check = makeAscKeyAccess(fakeAssert)
    const ctx = iosCtx({ credentials: { ...APPLE_TRIPLET, APPLE_KEY_CONTENT: 'not-base64-pem' } })
    const findings = await check.run(ctx)
    expect(called).toBe(false)
    expect(severities(findings)).not.toContain('error')
  })

  // ---- appliesTo gating ----
  it('does NOT apply for ad_hoc distribution', () => {
    const ctx = iosCtx({ distributionMode: 'ad_hoc' })
    expect(makeAscKeyAccess(async () => ({ ok: true })).appliesTo!(ctx)).toBe(false)
  })

  it('does NOT apply with a partial ASC triplet', () => {
    const ctx = iosCtx({ credentials: { APPLE_KEY_ID: APPLE_TRIPLET.APPLE_KEY_ID } })
    expect(makeAscKeyAccess(async () => ({ ok: true })).appliesTo!(ctx)).toBe(false)
  })

  it('does NOT apply on android', () => {
    const ctx = makeCtx({
      projectDir: makeProject({ 'package.json': '{}' }),
      platform: 'android',
      credentials: { ...APPLE_TRIPLET },
    })
    expect(makeAscKeyAccess(async () => ({ ok: true })).appliesTo!(ctx)).toBe(false)
  })

  it('applies for app_store + complete triplet', () => {
    expect(makeAscKeyAccess(async () => ({ ok: true })).appliesTo!(iosCtx())).toBe(true)
  })

  it('does NOT leak APPLE_KEY_CONTENT into any finding field', async () => {
    const fakeAssert = async (): Promise<AscAccessResult> => ({
      ok: false,
      kind: 'auth-error',
      message: 'rejected',
    })
    const check = makeAscKeyAccess(fakeAssert)
    const findings = await check.run(iosCtx())
    for (const f of findings) {
      const blob = `${f.title}${f.detail ?? ''}${f.fix ?? ''}`
      expect(blob).not.toContain(APPLE_KEY_CONTENT)
      expect(blob).not.toContain('BEGIN PRIVATE KEY')
    }
  })
})
