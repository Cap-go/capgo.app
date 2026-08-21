import type { SaveKeyOptions } from '../auth/session'
import { randomBytes } from 'node:crypto'
import { isCancel, log, password } from '@clack/prompts'
import open from 'open'
import { validateAndSaveKey } from '../auth/session'
import { CliUserError } from '../shared/cli-user-error'
import { consoleWebUrl, createSupabaseClient, resolveUserIdFromApiKey, sendEvent } from '../utils'

interface BrowserLoginOptions extends SaveKeyOptions {
  local: boolean
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
  await resolveUserIdFromApiKey(supabase, key, true)
  const { data, error } = await supabase.rpc('get_orgs_v7')
  if (error)
    throw error
  return (data ?? []).map(org => org.gid)
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

export async function loginInitInBrowser(
  options: BrowserLoginOptions,
  overrides: Partial<BrowserLoginDependencies> = {},
): Promise<string> {
  const dependencies = { ...defaults, ...overrides }
  const session = dependencies.createSession()
  const url = consoleWebUrl(`/login-cli?session=${encodeURIComponent(session)}`)
  dependencies.writeUrl(`Open this URL to create your CLI key: ${url}`)
  try {
    await dependencies.openUrl(url)
  }
  catch {
    // The printed URL is the fallback when a browser cannot be opened.
  }

  const key = await dependencies.promptForKey()
  if (!key)
    throw new CliUserError('CLI login cancelled')
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
      description: `cli-login:${session}`,
      notifyConsole: true,
    })))
  }
  catch {
    // Saving a valid key is the success condition; browser confirmation is best effort.
  }

  return key
}
