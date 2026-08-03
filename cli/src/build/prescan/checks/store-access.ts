// src/build/prescan/checks/store-access.ts
//
// Group C - remote store-access checks. They reach Google Play / App Store
// Connect to confirm the upload credentials actually have access to the target
// app BEFORE the build runs. These probes use related store API endpoints, not
// Fastlane's exact upload path, so endpoint-specific denials stay warnings.
//
// They are NOT marked `remote: true`: the engine's remote-skip predicate keys
// off `ctx.supabase` (Capgo's backend), which is the wrong signal here. Instead
// they gate on intent-to-upload via `appliesTo` (willUploadToPlay /
// willUploadToAppStore) and self-classify offline/transport failures as warnings
// so users see that verification did not complete without treating it as proof
// that the upload itself will fail.
//
// SECRET-HANDLING (mandatory): PLAY_CONFIG_JSON / APPLE_KEY_CONTENT /
// APPLE_KEY_ID / APPLE_ISSUER_ID raw values NEVER appear in Finding
// title/detail/fix. The injected validators only surface safe copy (SA email,
// package name, sanitized Apple error fields); for Play token-error we keep the
// finding terse and do not echo the validator message verbatim.
import type { ValidateOptions, ValidationResult } from '../../onboarding/android/service-account-validation.js'
import type { AscAccessResult, AssertAscAccessOptions } from '../../onboarding/apple-access.js'
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { Buffer } from 'node:buffer'
import forge from 'node-forge'
import { validateServiceAccountJson } from '../../onboarding/android/service-account-validation.js'
import { assertAscAccess } from '../../onboarding/apple-access.js'
import { resolveEffectiveApplicationId } from '../gradle'
import { willUploadToAppStore, willUploadToPlay } from '../upload-intent'

/** 7s per-request budget so the fetch aborts cleanly before the engine's 10s race. */
const STORE_ACCESS_TIMEOUT_MS = 7000

/** ASC authentication failures become build-blocking after a 14-day rollout. */
export const ASC_PRESCAN_AUTH_ENFORCE_AFTER = '2026-08-17T00:00:00.000Z'

const PLAY_FIX = 'Invite the service-account email in Play Console -> Users and permissions, then grant it release access for this app.'
const ASC_FIX = 'App Store Connect rejected the API key - check the Key ID / Issuer ID / .p8 and that the key has Admin or Developer access (or sign the pending agreement).'
const ASC_AGREEMENT_CODES = new Set([
  'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED',
  'FORBIDDEN_ERROR.PLA_NOT_ACCEPTED',
])
const ASC_AUTH_CODE_RE = /(?:^|[._-])(NOT_AUTHORIZED|UNAUTHORIZED|AUTHENTICATION(?:_ERROR)?|INVALID_(?:TOKEN|CREDENTIALS?))(?:$|[._-])/i
const ASC_AUTH_TEXT_RE = /authentication credentials? (?:are )?(?:missing or invalid)|invalid (?:bearer )?token|token (?:is )?(?:invalid|expired)/i

function ascReason(result: Extract<AscAccessResult, { ok: false }>): string {
  const heading = [result.code ? `[${result.code}]` : '', result.title ?? ''].filter(Boolean).join(' ')
  return [heading, result.detail].filter(Boolean).join(' - ') || result.message
}

function isAgreementFailure(result: Extract<AscAccessResult, { ok: false }>): boolean {
  return Boolean(
    result.status === 403
    && (
      (result.code && ASC_AGREEMENT_CODES.has(result.code))
      || /\bPLA_NOT_ACCEPTED\b|required agreement|program license agreement/i.test(`${result.code ?? ''} ${result.title ?? ''} ${result.detail ?? ''}`)
    ),
  )
}

function isDefinitiveAuthFailure(result: Extract<AscAccessResult, { ok: false }>): boolean {
  if (result.status === 401)
    return true
  if (result.status !== 403)
    return false
  return ASC_AUTH_CODE_RE.test(result.code ?? '')
    || ASC_AUTH_TEXT_RE.test(`${result.title ?? ''} ${result.detail ?? ''}`)
}

/** Injectable validator type so tests can supply a fake without any network. */
type PlayValidator = (opts: ValidateOptions) => Promise<ValidationResult>
type AscAsserter = (opts: AssertAscAccessOptions) => Promise<AscAccessResult>

/**
 * Build a 7s AbortController that fires the abort itself (the engine's race
 * resolves a timeout Finding but does not cancel in-flight fetches). The caller
 * must clear the returned timer in a finally block.
 */
function abortAfter(ms: number): { signal: AbortSignal, clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/**
 * android/play-sa-access factory. Accepts the (injectable) service-account
 * validator so the check is fully hermetic under test.
 */
export function makePlaySaAccess(validator: PlayValidator): PrescanCheck {
  return {
    id: 'android/play-sa-access',
    platforms: ['android'],
    appliesTo: ctx => willUploadToPlay(ctx),
    async run(ctx: ScanContext): Promise<Finding[]> {
      const raw = ctx.credentials?.PLAY_CONFIG_JSON
      if (!raw)
        return []
      // Probe the package the build will ACTUALLY upload: a flavored build
      // applies the flavor's applicationId / applicationIdSuffix on top of
      // defaultConfig, so probing the bare defaultConfig id 404s on a valid
      // flavored Play app. When the effective id can't be resolved
      // unambiguously, we keep the probe (for diagnostics) but downgrade a
      // no-app-access result to a warning so we never block on a guess.
      const effective = resolveEffectiveApplicationId(ctx.projectDir, ctx.androidFlavor)
      const packageName = effective.packageName ?? ctx.config?.appId ?? ctx.appId
      const jsonBytes = Buffer.from(raw, 'base64')

      const { signal, clear } = abortAfter(STORE_ACCESS_TIMEOUT_MS)
      let result: ValidationResult
      try {
        result = await validator({
          jsonBytes,
          packageName,
          signal,
          timeoutMs: STORE_ACCESS_TIMEOUT_MS,
        })
      }
      finally {
        clear()
      }

      if (result.ok)
        return []

      switch (result.kind) {
        case 'no-app-access':
          // result.message names the SA email + package - both safe to print.
          // Downgrade to a warning (mirroring the iOS side) when the effective
          // package could not be resolved unambiguously: the 404 may just be
          // the wrong probed package, not a genuine missing grant.
          return [{
            id: 'android/play-sa-access',
            severity: effective.ambiguous ? 'warning' : 'error',
            title: 'The Play service account cannot access this app',
            detail: result.message,
            fix: PLAY_FIX,
          }]
        case 'token-error':
          // Terse: do NOT echo the validator message verbatim (auth diagnostics).
          return [{
            id: 'android/play-sa-access',
            severity: 'error',
            title: 'Google rejected the Play service-account key',
            detail: 'The service-account JSON failed to authenticate with Google. Re-download a fresh key from the Google Cloud console.',
            fix: PLAY_FIX,
          }]
        case 'network-error':
          // Offline / transport / abort / timeout -> non-blocking notice.
          return [{
            id: 'android/play-sa-access',
            severity: 'info',
            title: 'Could not verify Play service-account access (network error or timeout)',
            detail: 'The build will still attempt the upload; this check is best-effort and skipped offline.',
          }]
        case 'shape-error':
          // The local android/play-sa-json check owns shape diagnostics; surface
          // a quiet info here at most so we never double-report as an error.
          return [{
            id: 'android/play-sa-access',
            severity: 'info',
            title: 'Skipped Play access check (service-account JSON shape problem)',
            detail: 'See the android/play-sa-json finding for the shape error.',
          }]
        default:
          return []
      }
    },
  }
}

/**
 * ios/asc-key-access factory. Accepts the (injectable) App Store Connect access
 * asserter so the check is fully hermetic under test.
 */
export function makeAscKeyAccess(asserter: AscAsserter): PrescanCheck {
  return {
    id: 'ios/asc-key-access',
    platforms: ['ios'],
    appliesTo: ctx => willUploadToAppStore(ctx),
    async run(ctx: ScanContext): Promise<Finding[]> {
      const { APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_KEY_CONTENT } = ctx.credentials ?? {}
      if (!APPLE_KEY_ID || !APPLE_ISSUER_ID || !APPLE_KEY_CONTENT)
        return []

      // Decode the base64 .p8 -> PEM. A non-PEM value is the local
      // ios/asc-key-valid check's job to flag; here we just skip cleanly so we
      // do not fire a confusing access error on top of it.
      let p8Pem = ''
      try {
        p8Pem = forge.util.decode64(APPLE_KEY_CONTENT)
      }
      catch {
        return []
      }
      if (!p8Pem.includes('-----BEGIN PRIVATE KEY-----'))
        return []

      const bundleId = await pbxprojBundleId(ctx)

      const { signal, clear } = abortAfter(STORE_ACCESS_TIMEOUT_MS)
      let result: AscAccessResult
      try {
        result = await asserter({
          keyId: APPLE_KEY_ID,
          issuerId: APPLE_ISSUER_ID,
          p8Pem,
          bundleId,
          signal,
          timeoutMs: STORE_ACCESS_TIMEOUT_MS,
        })
      }
      finally {
        clear()
      }

      if (result.ok)
        return []

      switch (result.kind) {
        case 'auth-error': {
          const reason = ascReason(result)
          if (isAgreementFailure(result)) {
            return [{
              id: 'ios/asc-key-access',
              severity: 'error',
              enforceAfter: ASC_PRESCAN_AUTH_ENFORCE_AFTER,
              title: 'Apple requires an App Store Connect agreement (HTTP 403)',
              detail: reason,
              fix: 'Ask the Account Holder to accept pending agreements in App Store Connect → Business, then retry.',
            }]
          }
          if (isDefinitiveAuthFailure(result)) {
            return [{
              id: 'ios/asc-key-access',
              severity: 'error',
              enforceAfter: ASC_PRESCAN_AUTH_ENFORCE_AFTER,
              title: `App Store Connect authentication failed during preflight (HTTP ${result.status})`,
              detail: reason,
              fix: ASC_FIX,
            }]
          }
          if (result.status === 403) {
            return [{
              id: 'ios/asc-key-access',
              severity: 'warning',
              title: 'Apple denied the App Store Connect preflight request (HTTP 403)',
              detail: `${reason} This /v1/apps probe differs from the TestFlight upload path, so the build may still succeed.`,
              fix: 'Review Apple\'s reason and confirm the key can access the target app. Use --fail-on-warnings only if this probe must be strict.',
            }]
          }
          // A local signing failure has no HTTP status. It is definitive because
          // the CLI could not construct a token from the supplied key material.
          return [{
            id: 'ios/asc-key-access',
            severity: 'error',
            title: 'Could not authenticate the App Store Connect API key',
            detail: reason,
            fix: ASC_FIX,
          }]
        }
        case 'no-app-access':
          // 2xx but the project bundle id is absent from /apps -> warning.
          return [{
            id: 'ios/asc-key-access',
            severity: 'warning',
            title: 'The App Store Connect API key cannot see this app',
            detail: result.message,
            fix: 'Confirm the app exists in App Store Connect and the API key role can access it, or fix the bundle identifier.',
          }]
        case 'network':
          return [{
            id: 'ios/asc-key-access',
            severity: 'warning',
            title: result.status
              ? `App Store Connect preflight returned HTTP ${result.status}`
              : 'Could not verify App Store Connect access (network error or timeout)',
            detail: result.status
              ? `${ascReason(result)} The build will still attempt the upload.`
              : 'The build will still attempt the upload; retry when network access is available.',
          }]
        default:
          return []
      }
    },
  }
}

/** Resolve the project's iOS bundle id from the pbxproj signable targets. */
async function pbxprojBundleId(ctx: ScanContext): Promise<string | undefined> {
  try {
    const { findSignableTargets, readPbxproj } = await import('../../pbxproj-parser')
    const pbx = readPbxproj(ctx.projectDir)
    if (!pbx)
      return ctx.config?.appId ?? ctx.appId
    const targets = findSignableTargets(pbx)
    const expected = ctx.config?.appId ?? ctx.appId
    // Prefer a target matching the Capacitor appId; else the first signable one.
    const match = targets.find(t => t.bundleId === expected) ?? targets[0]
    return match?.bundleId ?? expected
  }
  catch {
    return ctx.config?.appId ?? ctx.appId
  }
}

/** Wired checks (real validators) appended to the registry. */
export const playSaAccess: PrescanCheck = makePlaySaAccess(validateServiceAccountJson)
export const ascKeyAccess: PrescanCheck = makeAscKeyAccess(assertAscAccess)
