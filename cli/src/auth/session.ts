import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import process from 'node:process'
import { createSupabaseClient, resolveUserIdFromApiKey, sendEvent } from '../utils'
import { appendToSafeFile, writeFileAtomic } from '../utils/safeWrites'

/**
 * Shared, UI-free authentication core.
 *
 * `cli/src/login.ts` (the interactive `capgo login` command) and the MCP login
 * tools (`capgo_login` / `capgo_whoami` / `capgo_logout`) all funnel through these
 * helpers so there is a single validate / persist / introspect path — no forked
 * security logic. The user-facing message builders live here too (pure functions)
 * so the tool wording is covered by unit tests rather than only the integration
 * smoke test.
 */

export type KeySource = 'env' | 'global' | 'local'

export interface LoginState {
  loggedIn: boolean
  /** Resolved user id — only populated when `validate` succeeded. */
  userId?: string
  /** Where the resolved key came from, if any (also set when a present key fails validation). */
  source?: KeySource
  /**
   * Only meaningful when `validate` was requested. `true` = confirmed valid this
   * call; `false` = a key is present but could NOT be verified (network/server
   * error), so it is reported as still-logged-in-but-unverified rather than as a
   * definitive sign-out. Undefined when no validation was attempted.
   */
  verified?: boolean
}

export interface SaveKeyOptions {
  /** Persist to `./.capgo` (project-local) instead of `~/.capgo` (global). */
  local?: boolean
  supaHost?: string
  supaAnon?: string
}

const globalKeyPath = () => `${homedir()}/.capgo`
const LOCAL_KEY_PATH = '.capgo'

/** Read a key file's content, treating empty/whitespace/unreadable as absent. */
function readKeyFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value || undefined
  }
  catch {
    return undefined
  }
}

/**
 * Resolve the key AND its source together, by the SAME precedence and the SAME
 * content read `findSavedKeySilent()` uses (env → ~/.capgo → ./.capgo). Returning
 * both from one resolution avoids a separate existsSync scan drifting from the key
 * actually selected (e.g. an empty ~/.capgo would be skipped for the key but a
 * parallel existsSync would wrongly label the source 'global').
 */
function resolveKeyAndSource(): { key?: string, source?: KeySource } {
  const envKey = process.env.CAPGO_TOKEN?.trim()
  if (envKey)
    return { key: envKey, source: 'env' }
  const globalKey = readKeyFile(globalKeyPath())
  if (globalKey)
    return { key: globalKey, source: 'global' }
  const localKey = readKeyFile(LOCAL_KEY_PATH)
  if (localKey)
    return { key: localKey, source: 'local' }
  return {}
}

/**
 * Append an entry to `.gitignore` only if it isn't already present, so repeated
 * project-local logins don't accumulate duplicate lines.
 */
async function ensureGitignored(entry: string): Promise<void> {
  let existing = ''
  try {
    existing = readFileSync('.gitignore', 'utf8')
  }
  catch {
    existing = ''
  }
  const alreadyListed = existing.split(/\r?\n/).some(line => line.trim() === entry)
  if (!alreadyListed)
    await appendToSafeFile('.gitignore', `${entry}\n`, 0o600)
}

/**
 * Validate an API key against Capgo and, if valid, persist it (0o600).
 * Returns the resolved user id. Throws on a missing/invalid key or a disallowed
 * local write (local requires a git repository, mirroring `capgo login --local`).
 *
 * Nothing is written when validation fails.
 */
export async function validateAndSaveKey(apikey: string, options: SaveKeyOptions = {}): Promise<{ userId: string }> {
  if (!apikey)
    throw new Error('Missing API key')

  const local = options.local ?? false
  if (local && !existsSync('.git'))
    throw new Error('To save a project-local key you must be inside a git repository')

  // Validate BEFORE writing so an invalid key never lands on disk.
  const supabase = await createSupabaseClient(apikey, options.supaHost, options.supaAnon, true)
  const userId = await resolveUserIdFromApiKey(supabase, apikey, true, {
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (local) {
    await writeFileAtomic(LOCAL_KEY_PATH, `${apikey}\n`, { mode: 0o600 })
    await ensureGitignored('.capgo')
  }
  else {
    await writeFileAtomic(globalKeyPath(), `${apikey}\n`, { mode: 0o600 })
  }

  await sendEvent(apikey, {
    channel: 'user-login',
    event: 'User CLI login',
    tracking_version: 2,
  }).catch(() => {})

  return { userId }
}

/**
 * Report whether a saved key exists.
 *
 * Presence-only by default (no network) so it is cheap enough to gate every tool
 * call. Pass `{ validate: true }` (used by `capgo_whoami`) to additionally confirm
 * the key still authenticates and resolve the user id.
 */
export async function getLoginState(options: { validate?: boolean } = {}): Promise<LoginState> {
  const { key, source } = resolveKeyAndSource()
  if (!key)
    return { loggedIn: false }

  if (!options.validate)
    return { loggedIn: true, source }

  try {
    const supabase = await createSupabaseClient(key, undefined, undefined, true)
    const userId = await resolveUserIdFromApiKey(supabase, key, true)
    return { loggedIn: true, userId, source, verified: true }
  }
  catch (error) {
    // Only a definitively-bad key reads as logged-out; a transient failure
    // (network/server) keeps the present key as logged-in-but-unverified.
    const message = error instanceof Error ? error.message : String(error)
    if (/invalid api key|insufficient permissions/i.test(message))
      return { loggedIn: false, source }
    return { loggedIn: true, source, verified: false }
  }
}

/**
 * Remove the saved key. Clears the global key (`~/.capgo`) by default, or the
 * project-local key (`./.capgo`) when `local` is set. Never touches `CAPGO_TOKEN`
 * (an env var is not ours to unset). Returns whether a file was actually removed.
 */
export async function clearSavedKey(options: { local?: boolean } = {}): Promise<{ cleared: boolean }> {
  const path = options.local ? LOCAL_KEY_PATH : globalKeyPath()
  if (!existsSync(path))
    return { cleared: false }
  await rm(path, { force: true })
  return { cleared: true }
}

// ── User-facing message builders (pure, unit-tested) ─────────────────────────

/** Success text for capgo_login. */
export function loginSuccessMessage(userId: string, local: boolean): string {
  const where = local ? './.capgo' : '~/.capgo'
  return `Signed in to Capgo (user ${userId}). Saved to ${where}. You can now use the authenticated tools.`
}

/** Status text for capgo_whoami, covering verified / unverified / invalid / signed-out. */
export function whoamiMessage(state: LoginState): string {
  if (state.loggedIn && state.verified === false)
    return `A ${state.source} Capgo key is set, but Capgo could not be reached to verify it right now. Tools may still work if the key is valid.`
  if (state.loggedIn)
    return `Signed in to Capgo (user ${state.userId}) using the ${state.source} key.`
  if (state.source)
    return `Not signed in: a saved ${state.source} key exists but is no longer valid. Generate a new one at https://console.capgo.app/connect and call capgo_login.`
  return 'Not signed in. Generate a key at https://console.capgo.app/connect and call capgo_login.'
}

/**
 * Honest text for capgo_logout. `remaining` is the post-clear login state: if a
 * credential is still reachable (CAPGO_TOKEN, or the other on-disk scope) we say
 * so explicitly instead of falsely claiming the session is signed out.
 */
export function logoutMessage(cleared: boolean, removedLocal: boolean, remaining: LoginState): string {
  const where = removedLocal ? './.capgo' : '~/.capgo'
  if (remaining.loggedIn) {
    const via = remaining.source === 'env'
      ? 'the CAPGO_TOKEN environment variable'
      : `a ${remaining.source} key (${remaining.source === 'local' ? './.capgo' : '~/.capgo'})`
    const how = remaining.source === 'env'
      ? 'Unset CAPGO_TOKEN to fully sign out.'
      : `Run capgo_logout with scope "${remaining.source}" to remove it.`
    return `${cleared ? `Removed ${where}` : `No ${where} to remove`}, but you are still signed in via ${via}. ${how}`
  }
  return cleared ? `Signed out — removed ${where}.` : `No ${where} key to remove; you are signed out.`
}
