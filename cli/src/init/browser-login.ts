import type { SaveKeyOptions } from '../auth/session'
import { randomBytes } from 'node:crypto'
import { isCancel, log, password } from '@clack/prompts'
import open from 'open'
import { validateAndSaveKey } from '../auth/session'
import { CliUserError } from '../shared/cli-user-error'
import { consoleWebUrl, createSupabaseClient, fetchOrganizationsV7, resolveUserIdFromApiKey, sendEvent } from '../utils'

interface BrowserLoginOptions extends SaveKeyOptions {
  local: boolean
}

export interface BrowserLoginSession {
  session: string
  url: string
  browserOpened: boolean
}

interface BrowserLoginEvent {
  channel: 'user-login'
  event: 'User CLI login'
  tracking_version: 2
  org_id: string
  description: string
  notifyConsole: true
}

interface BrowserLoginDependencies {
  createSession: () => string
  openUrl: (url: string) => Promise<unknown>
  promptForKey: () => Promise<string | undefined>
  validateKey: (key: string, options: SaveKeyOptions) => Promise<{ userId: string }>
  listOrganizationIds: (key: string, options: BrowserLoginOptions) => Promise<string[]>
  sendEvent: (key: string, payload: BrowserLoginEvent) => Promise<void>
  writeUrl: (message: string) => void
}

async function promptForKey(): Promise<string | undefined> {
  const value = await password({
    message: 'Paste the API key from the Capgo dashboard:',
    mask: '*',
  })
  return isCancel(value) ? undefined : String(value)
}

async function listOrganizationIds(key: string, options: BrowserLoginOptions): Promise<string[]> {
  const supabase = await createSupabaseClient(key, options.supaHost, options.supaAnon, true)
  const httpOptions = { supaHost: options.supaHost, supaAnon: options.supaAnon }
  await resolveUserIdFromApiKey(supabase, key, true, httpOptions)
  const organizations = await fetchOrganizationsV7(key, httpOptions)
  return organizations.map(org => org.gid)
}

const defaults: BrowserLoginDependencies = {
  createSession: () => randomBytes(16).toString('base64url'),
  openUrl: url => open(url),
  promptForKey,
  validateKey: validateAndSaveKey,
  listOrganizationIds,
  sendEvent,
  writeUrl: message => log.info(message),
}

export function shouldStartInitBrowserLogin(resolvedKey: string | undefined, interactive: boolean): boolean {
  return !resolvedKey && interactive
}

export async function beginBrowserLogin(
  onUrl: (url: string) => void,
  overrides: Partial<BrowserLoginDependencies> = {},
): Promise<BrowserLoginSession> {
  const dependencies = { ...defaults, ...overrides }
  const session = dependencies.createSession()
  const url = consoleWebUrl(`/login-cli?session=${encodeURIComponent(session)}`)
  onUrl(url)
  try {
    await dependencies.openUrl(url)
    return { session, url, browserOpened: true }
  }
  catch {
    return { session, url, browserOpened: false }
  }
}

export async function completeBrowserLogin(
  browserSession: BrowserLoginSession,
  key: string,
  options: BrowserLoginOptions,
  overrides: Partial<BrowserLoginDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaults, ...overrides }
  await dependencies.validateKey(key, {
    local: options.local,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  try {
    const orgIds = await dependencies.listOrganizationIds(key, options)
    await Promise.allSettled(orgIds.map(orgId => dependencies.sendEvent(key, {
      channel: 'user-login',
      event: 'User CLI login',
      tracking_version: 2,
      org_id: orgId,
      description: `cli-login:${browserSession.session}`,
      notifyConsole: true,
    })))
  }
  catch {
    // Saving a valid key is the success condition; browser confirmation is best effort.
  }
}

export async function loginInitInBrowser(
  options: BrowserLoginOptions,
  overrides: Partial<BrowserLoginDependencies> = {},
): Promise<string> {
  const dependencies = { ...defaults, ...overrides }
  const session = await beginBrowserLogin(
    url => dependencies.writeUrl(`Open this URL to create your CLI key: ${url}`),
    dependencies,
  )
  const key = await dependencies.promptForKey()
  if (!key)
    throw new CliUserError('CLI login cancelled')
  await completeBrowserLogin(session, key, options, dependencies)
  return key
}
