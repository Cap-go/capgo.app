import { readFileSync } from 'node:fs'
import { describe, expect, it, mock } from 'bun:test'
import { loginInitInBrowser, shouldStartInitBrowserLogin } from '../../src/init/browser-login'

const helperSource = readFileSync(new URL('../../src/init/browser-login.ts', import.meta.url), 'utf8')
const initSource = readFileSync(new URL('../../src/init/command.ts', import.meta.url), 'utf8')

describe('init browser login', () => {
  it('starts only for an interactive init with no resolved key', () => {
    expect(shouldStartInitBrowserLogin('', true)).toBe(true)
    expect(shouldStartInitBrowserLogin('argument-or-saved-key', true)).toBe(false)
    expect(shouldStartInitBrowserLogin('', false)).toBe(false)
  })

  it('uses a password prompt with star masking', () => {
    expect(helperSource).toContain("mask: '*'")
    expect(helperSource).not.toContain('text({')
  })

  it('wires browser login after saved-key lookup and only for interactive init', () => {
    const initApp = initSource.slice(initSource.indexOf('export async function initApp('))
    const savedKeyLookup = initApp.indexOf('options.apikey = findSavedKey(true)')
    const browserGate = initApp.indexOf('shouldStartInitBrowserLogin(options.apikey, supportsBrowserLogin && canPromptInteractively({ silent: options.silent }))')
    const authenticatedClient = initApp.indexOf('const supabase = await createSupabaseClient(options.apikey')

    expect(savedKeyLookup).toBeGreaterThanOrEqual(0)
    expect(browserGate).toBeGreaterThan(savedKeyLookup)
    expect(browserGate).toBeLessThan(authenticatedClient)
    expect(initApp).toContain('const supportsBrowserLogin = !options.local && !options.supaHost && !options.supaAnon')
    expect(initApp).toContain('options.apikey = await loginInitInBrowser({')
  })

  it('resolves plain API-key identity before listing organizations', () => {
    const resolveUserId = helperSource.indexOf('await resolveUserIdFromApiKey(supabase, key, true)')
    const listOrganizations = helperSource.indexOf("await supabase.rpc('get_orgs_v7')")

    expect(resolveUserId).toBeGreaterThanOrEqual(0)
    expect(listOrganizations).toBeGreaterThanOrEqual(0)
    expect(resolveUserId).toBeLessThan(listOrganizations)
  })

  it('opens the correlated URL, saves the masked input, and notifies every org', async () => {
    const output: string[] = []
    const openUrl = mock(async () => undefined)
    const validateKey = mock(async () => ({ userId: 'user-1' }))
    const sendEvent = mock(async () => undefined)
    const key = await loginInitInBrowser({ local: false }, {
      createSession: () => 'AbCdEfGhIjKlMnOpQrStUv',
      openUrl,
      promptForKey: async () => 'super-secret-key',
      validateKey,
      listOrganizationIds: async () => ['org-a', 'org-b'],
      sendEvent,
      writeUrl: message => output.push(message),
    })

    expect(key).toBe('super-secret-key')
    expect(openUrl).toHaveBeenCalledWith('https://console.capgo.app/login-cli?session=AbCdEfGhIjKlMnOpQrStUv')
    expect(validateKey).toHaveBeenCalledWith('super-secret-key', {
      local: false,
      supaAnon: undefined,
      supaHost: undefined,
    })
    expect(sendEvent).toHaveBeenCalledTimes(2)
    expect(sendEvent).toHaveBeenCalledWith('super-secret-key', {
      channel: 'user-login',
      event: 'User CLI login',
      tracking_version: 2,
      org_id: 'org-a',
      description: 'cli-login:AbCdEfGhIjKlMnOpQrStUv',
      notifyConsole: true,
      notify: false,
    })
    expect(output.join('\n')).toContain('/login-cli?session=AbCdEfGhIjKlMnOpQrStUv')
    expect(output.join('\n')).not.toContain('super-secret-key')
  })

  it('keeps browser launch and notification lookup best effort after a valid save', async () => {
    await expect(loginInitInBrowser({ local: false }, {
      createSession: () => 'AbCdEfGhIjKlMnOpQrStUv',
      openUrl: async () => { throw new Error('no browser') },
      promptForKey: async () => 'valid-key',
      validateKey: async () => ({ userId: 'user-1' }),
      listOrganizationIds: async () => { throw new Error('offline') },
      sendEvent: async () => { throw new Error('offline') },
      writeUrl: () => undefined,
    })).resolves.toBe('valid-key')
  })
})
