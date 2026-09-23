import type { BrowserLoginSession } from '../../init/browser-login.js'
import { validateAndSaveKey } from '../../auth/session.js'
import { beginBrowserLogin, completeBrowserLogin } from '../../init/browser-login.js'
import { resolveAccountIdentity } from '../../user/whoami.js'
import { createSupabaseClient, findSavedKeySilent, resolveUserIdFromApiKey } from '../../utils.js'

export interface BuilderLoginOptions {
  supaHost?: string
  supaAnon?: string
}

export interface BuilderLoginServices {
  browserAvailable: boolean
  validateExisting: (key: string) => Promise<void>
  getAccountEmail: (key: string) => Promise<string>
  savePasted: (key: string) => Promise<void>
  beginBrowser: (onUrl: (url: string) => void) => Promise<BrowserLoginSession>
  completeBrowser: (session: BrowserLoginSession, key: string) => Promise<void>
}

export function resolveBuilderCandidateKey(explicitKey?: string): string | undefined {
  return explicitKey?.trim() || findSavedKeySilent()
}

export function createBuilderLoginServices(options: BuilderLoginOptions = {}): BuilderLoginServices {
  const saveOptions = { local: false, supaHost: options.supaHost, supaAnon: options.supaAnon }
  return {
    browserAvailable: !options.supaHost && !options.supaAnon,
    validateExisting: async (key) => {
      const client = await createSupabaseClient(key, options.supaHost, options.supaAnon, true)
      await resolveUserIdFromApiKey(client, key, true, {
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      })
    },
    getAccountEmail: async (key) => {
      const { email } = await resolveAccountIdentity(key, {
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      })
      return email
    },
    savePasted: async (key) => {
      await validateAndSaveKey(key, saveOptions)
    },
    beginBrowser: onUrl => beginBrowserLogin(onUrl),
    completeBrowser: async (session, key) => {
      await completeBrowserLogin(session, key, saveOptions)
    },
  }
}
