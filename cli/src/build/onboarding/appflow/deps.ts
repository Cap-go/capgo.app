// Production wiring for the Appflow migration flow's effect dependencies.
//
// The flow itself (flow.ts) is pure/injectable: it asks for a token cache, a
// browser opener, a redacted logger, and four validators. This module builds
// the REAL deps by reusing the existing CLI building blocks:
//   - token cache  -> a JSON file under ~/.capgo-credentials/ (same dir as creds)
//   - log          -> appendInternalLog (the support-bundle internal log; redacted)
//   - openBrowser  -> node child_process spawn (same pattern as auth.ts default)
//   - validators   -> android service-account-validation.ts, android keystore.ts,
//                     ios validate-app-password.ts (all advisory, never throw)
//
// On flow completion the collected per-platform Capgo creds are persisted into
// the SAME credential store the native flows write (updateSavedCredentials), so
// downstream build/CI steps cannot tell migrated creds from natively-set-up ones.
import { Buffer } from 'node:buffer'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { appendInternalLog } from '../../../support/internal-log.js'
import { ensureSecureDirectory, writeFileAtomic } from '../../../utils/safeWrites.js'
import { updateSavedCredentials } from '../../credentials.js'
import { validateServiceAccountJson as androidValidateServiceAccountJson } from '../android/service-account-validation.js'
import { tryUnlockPrivateKey as androidTryUnlockPrivateKey } from '../android/keystore.js'
import { validateAppleAppPassword as iosValidateAppleAppPassword } from '../ios/validate-app-password.js'
import { isMacOS, runAscKeyHelper } from '../asc-key/helper.js'
import type { AppflowEffectDeps, AppflowGenerateResult } from './flow.js'
import type { AppflowProgress } from './types.js'
import type { AppflowToken } from './auth.js'

const CREDENTIALS_DIR = join(homedir(), '.capgo-credentials')
const APPFLOW_TOKEN_FILE = join(CREDENTIALS_DIR, 'appflow-token.json')
// An App Store Connect API key (.p8) is a small PEM file (~250 bytes). Cap the
// accepted size well above that so a symlink/regular-file masquerading as a huge
// file can never be slurped into APPLE_KEY_CONTENT.
const MAX_P8_BYTES = 64 * 1024

/** Load a cached Appflow token, or null when absent/unreadable. Never throws. */
export function loadAppflowToken(): AppflowToken | null {
  try {
    if (!existsSync(APPFLOW_TOKEN_FILE))
      return null
    const raw = readFileSync(APPFLOW_TOKEN_FILE, 'utf8')
    const parsed = JSON.parse(raw) as AppflowToken
    // A cache that carries only access_token but no numeric expiry fields would
    // pass a naive check yet break isExpired() downstream (it would never refresh
    // and later fail as an opaque Appflow API error). Require the full shape.
    if (
      parsed
      && typeof parsed.access_token === 'string'
      && typeof parsed.expires_in === 'number'
      && Number.isFinite(parsed.expires_in)
      && typeof parsed.capturedAtMs === 'number'
      && Number.isFinite(parsed.capturedAtMs)
    )
      return parsed
    return null
  }
  catch {
    return null
  }
}

/** Persist an Appflow token to the credentials dir (0700 dir / best-effort). Never throws. */
/** Persist an Appflow token to the credentials dir atomically (0700 dir / 0600
 * file, temp+rename). Best-effort and never throws: a failure just means the next
 * run re-auths. Uses the shared safe-write helpers (symlink-guarded, atomic). */
export function saveAppflowToken(token: AppflowToken): void {
  void (async () => {
    try {
      await ensureSecureDirectory(CREDENTIALS_DIR, 0o700)
      await writeFileAtomic(APPFLOW_TOKEN_FILE, JSON.stringify(token), { mode: 0o600 })
    }
    catch {
      // Token caching is best-effort: a failure just means the next run re-auths.
    }
  })()
}

/** Best-effort browser open, mirroring auth.ts's defaultOpen (also printed by the caller). */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  }
  catch {
    // best-effort; the URL is also surfaced by the flow
  }
}

/**
 * PLAY_CONFIG_JSON is stored base64-encoded (the same convention the native
 * android flow uses — see android/types.ts). Decode it to the raw service-account
 * JSON bytes for validation; if the value is already raw JSON (starts with '{'),
 * pass it through as utf8. Exported for unit testing the encoding contract.
 */
export function serviceAccountJsonBytes(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('utf8').trimStart().startsWith('{') ? decoded : Buffer.from(value, 'utf8')
}

/**
 * Cap an advisory reason/message to a single line of bounded length, stripping
 * newlines/control chars, so an unbounded upstream (Google) string cannot blow up
 * the validate-results view or the MCP NextStepResult.summary it flows into.
 */
const MAX_ADVISORY_REASON = 200
function capAdvisoryReason(raw: string | undefined): string {
  const source = raw ?? 'unknown'
  const stripped = Array.from(source, ch => ((ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7F ? ' ' : ch)).join('')
  const flat = stripped.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ADVISORY_REASON ? `${flat.slice(0, MAX_ADVISORY_REASON - 1)}…` : flat
}

/**
 * Adapter: the flow asks for `(json, packageName?) => { ok, reason? }`; the
 * existing validator takes `{ jsonBytes, packageName }` and returns a tagged
 * union. We pass the migrated service-account JSON (decoded) + the migrated
 * Play package name. Advisory only — any throw is caught and surfaced upstream.
 */
function makeValidateServiceAccountJson(packageName?: string): NonNullable<AppflowEffectDeps['validateServiceAccountJson']> {
  return async (json: string, pkg?: string) => {
    const effectivePkg = pkg ?? packageName
    if (!effectivePkg)
      return { ok: false, reason: 'no package name available to probe Play access' }
    const result = await androidValidateServiceAccountJson({ jsonBytes: serviceAccountJsonBytes(json), packageName: effectivePkg })
    if (result.ok)
      return { ok: true }
    // Cap the Google API reason (a single line, bounded length, no control chars)
    // so an unbounded upstream string cannot blow up the validate-results view /
    // MCP summary it flows into.
    return { ok: false, reason: capAdvisoryReason(result.message) }
  }
}

/**
 * Adapter: the flow asks for `(keystoreB64, storePass, alias) => boolean`; the
 * existing validator takes raw bytes + the store password and returns a tagged
 * union. The alias is informational (node-forge unlocks the whole PKCS#12 with
 * one password) — we treat a successful unlock as a pass. Never throws.
 */
function tryUnlockPrivateKey(keystoreB64: string, storePass: string, _alias: string): Promise<boolean> {
  try {
    const bytes = Buffer.from(keystoreB64, 'base64')
    return Promise.resolve(androidTryUnlockPrivateKey(bytes, storePass).ok)
  }
  catch {
    return Promise.resolve(false)
  }
}

/**
 * Adapter: confirm an imported iOS signing certificate (.p12) opens with its
 * password. A .p12 is a PKCS#12 container like an Android keystore, so the same
 * node-forge unlock applies. LOCAL only (no remote calls), advisory, never throws.
 */
function validateP12(p12B64: string, password: string): Promise<boolean> {
  try {
    const bytes = Buffer.from(p12B64, 'base64')
    return Promise.resolve(androidTryUnlockPrivateKey(bytes, password).ok)
  }
  catch {
    return Promise.resolve(false)
  }
}

/**
 * Adapter: the flow asks for `(user, pw) => { valid, message?, kind? }`; reuse
 * the iTMSTransporter probe. We FORWARD `kind` ('authenticated' | 'rejected' |
 * 'unreachable') so the flow can distinguish a transport failure (could not reach
 * Apple) from a genuine credential rejection — a network problem must NOT be
 * reported as a bad password.
 */
function validateAppleAppPassword(user: string, pw: string): Promise<{ valid: boolean, message?: string, kind?: 'authenticated' | 'rejected' | 'unreachable' }> {
  return iosValidateAppleAppPassword(user, pw).then(r => ({ valid: r.valid, message: r.message, kind: r.kind }))
}

/**
 * Generator: drive the EXISTING standalone App Store Connect API-key (.p8)
 * helper (asc-key/helper.ts — the same self-contained, subprocess-driven module
 * the iOS onboarding TUI uses) and map its result onto the Capgo iOS cred
 * fields. Returns the SAME keys the native flow persists (`updateSavedCredentials`):
 *   APPLE_KEY_ID / APPLE_ISSUER_ID / APPLE_KEY_CONTENT (base64 of the .p8).
 * Never throws: NotMacOSError (or any error) becomes a non-ok advisory result.
 */
async function generateIosP8Key(): Promise<AppflowGenerateResult> {
  if (!isMacOS())
    return { ok: false, message: 'the App Store Connect API-key helper requires macOS 14+' }
  try {
    const outcome = await runAscKeyHelper()
    if (!outcome.ok)
      return { ok: false, message: outcome.message }
    const { keyId, issuerId, privateKey } = outcome.credentials
    return {
      ok: true,
      creds: {
        APPLE_KEY_ID: keyId,
        APPLE_ISSUER_ID: issuerId,
        APPLE_KEY_CONTENT: Buffer.from(privateKey, 'utf8').toString('base64'),
      },
    }
  }
  catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Generator: set up a Google Play service account (-> PLAY_CONFIG_JSON).
 *
 * The standalone Google API primitives (android/{oauth-google,gcp-api,play-api}.ts)
 * are reusable, but the END-TO-END "generate" orchestration (project pick, Play
 * developer-id entry, package pick) is interactive and lives in the Android
 * onboarding wizard's own step graph; it cannot be driven non-interactively here
 * without re-implementing that wizard. So the gap-fill records the intent and
 * routes the user to the dedicated Android setup rather than blocking the
 * migration. Advisory, never throws — the flow surfaces this note and continues.
 */
function generateAndroidServiceAccount(_opts: { packageName?: string }): Promise<AppflowGenerateResult> {
  return Promise.resolve({
    ok: false,
    message: 'finish Google Play service-account setup with `capgo build setup --android` (interactive)',
  })
}

/**
 * Reader: load a user-provided App Store Connect API key (.p8) file and return
 * its base64-encoded bytes, ready to store as APPLE_KEY_CONTENT (the same
 * encoding the native iOS flow and the generate path use). Reads the raw bytes
 * (a .p8 is PEM text, but we base64 the file as-is to match the generate path).
 * Advisory: returns null on any error (missing / unreadable file), never throws.
 */
export async function readP8File(path: string): Promise<string | null> {
  try {
    if (!path || !existsSync(path))
      return null
    // Only ever read an actual App Store Connect API key: the path MUST end with
    // `.p8` (case-insensitive) and be a REGULAR file. This blocks reading arbitrary
    // files (e.g. ~/.ssh/id_rsa, /etc/passwd) into APPLE_KEY_CONTENT — a file-content
    // exfiltration vector when an AI agent intermediates the p8Path input over MCP.
    if (!/\.p8$/i.test(path))
      return null
    // Reject SYMLINKS (lstat, not stat — a `*.p8` symlink could point at any local
    // file) and oversized files BEFORE reading, closing the file-content
    // exfiltration vector when an AI agent intermediates p8Path over MCP.
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_P8_BYTES)
      return null
    const bytes = readFileSync(path)
    return Buffer.from(bytes).toString('base64')
  }
  catch {
    return null
  }
}

/**
 * Build the production AppflowEffectDeps for a given app id. The `packageName`
 * (the Play package, when known) sharpens the service-account probe; pass the
 * appId as a fallback. Token cache, browser, logger, and validators are all
 * wired here so the engine and the TUI share one source of truth.
 */
export function buildAppflowEffectDeps(opts: { appId?: string, packageName?: string } = {}): AppflowEffectDeps {
  return {
    appId: opts.appId,
    log: (s: string) => appendInternalLog(s),
    loadToken: loadAppflowToken,
    saveToken: saveAppflowToken,
    openBrowser,
    validateServiceAccountJson: makeValidateServiceAccountJson(opts.packageName ?? opts.appId),
    tryUnlockPrivateKey,
    validateAppleAppPassword,
    validateP12,
    generateIosP8Key,
    generateAndroidServiceAccount,
    readP8File,
  }
}

/**
 * Persist the collected per-platform Capgo creds into the REAL credential store
 * (the same path the native flows use), so the build/validate/CI tail cannot
 * tell migrated creds from natively-set-up ones. Writes only the platforms that
 * actually collected creds. Returns the platforms written.
 */
export async function persistAppflowCredentials(appId: string, progress: AppflowProgress, local?: boolean): Promise<('ios' | 'android')[]> {
  const written: ('ios' | 'android')[] = []
  if (progress.ios && Object.keys(progress.ios).length > 0) {
    await updateSavedCredentials(appId, 'ios', progress.ios, local)
    written.push('ios')
  }
  if (progress.android && Object.keys(progress.android).length > 0) {
    await updateSavedCredentials(appId, 'android', progress.android, local)
    written.push('android')
  }
  return written
}
