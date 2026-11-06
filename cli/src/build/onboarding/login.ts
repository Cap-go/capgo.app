import type { BrowserLoginSession } from '../../init/browser-login.js'
import { validateAndSaveKey } from '../../auth/session.js'
import { beginBrowserLogin, completeBrowserLogin } from '../../init/browser-login.js'
import { resolveAccountIdentity } from '../../user/whoami.js'
import { createCapgoClient, findSavedKeySilent, resolveUserIdFromApiKey } from '../../utils.js'

export interface BuilderLoginOptions {
  apiHost?: string
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
  const saveOptions = { local: false, apiHost: options.apiHost }
  return {
    browserAvailable: !options.apiHost,
    validateExisting: async (key) => {
      const client = await createCapgoClient(key, options.apiHost, true)
      await resolveUserIdFromApiKey(client, key, true, {
        apiHost: options.apiHost,
      })
    },
    getAccountEmail: async (key) => {
      const { email } = await resolveAccountIdentity(key, {
        apiHost: options.apiHost,
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
