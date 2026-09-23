import { readFileSync } from 'node:fs'
import { describe, expect, it, mock } from 'bun:test'
import { loginInitInBrowser, shouldStartInitBrowserLogin } from '../../src/init/browser-login'
import * as loginModule from '../../src/login'

const helperSource = readFileSync(new URL('../../src/init/browser-login.ts', import.meta.url), 'utf8')
const initSource = readFileSync(new URL('../../src/init/command.ts', import.meta.url), 'utf8')
const loginSource = readFileSync(new URL('../../src/login.ts', import.meta.url), 'utf8')
const initPromptsSource = readFileSync(new URL('../../src/init/prompts.ts', import.meta.url), 'utf8')
const initRuntimeSource = readFileSync(new URL('../../src/init/runtime.tsx', import.meta.url), 'utf8')
const initComponentsSource = readFileSync(new URL('../../src/init/ui/components.tsx', import.meta.url), 'utf8')

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
    const savedKeyLookup = initApp.indexOf('options.apikey = findSavedKeySilent() ?? \'\'')
    const browserGate = initApp.indexOf('shouldStartInitBrowserLogin(options.apikey, supportsBrowserLogin && canPromptInteractively({ silent: options.silent }))')
    const authenticatedClient = initApp.indexOf('const supabase = await createSupabaseClient(options.apikey')

    expect(savedKeyLookup).toBeGreaterThanOrEqual(0)
    expect(browserGate).toBeGreaterThan(savedKeyLookup)
    expect(browserGate).toBeLessThan(authenticatedClient)
    expect(initApp).not.toContain('findSavedKey(true)')
    expect(initApp).toContain('const supportsBrowserLogin = !options.local && !options.supaHost && !options.supaAnon')
    expect(initApp).toContain('options.apikey = await loginInitInBrowser({')
  })

  it('keeps the init login method and API-key input inside Ink', () => {
    const initApp = initSource.slice(initSource.indexOf('export async function initApp('))

    expect(initApp).toContain("await pSelect<LoginMethod>({")
    expect(initApp).toContain("message: 'How would you like to log in?'")
    expect(initApp).toContain('options: LOGIN_METHOD_OPTIONS')
    expect(initApp).toContain("message: 'Paste the API key from the Capgo dashboard:'")
    expect(initApp).toContain("mask: '*'")
    expect(initApp).toContain('promptForKey: promptForInitApiKey')
    expect(initApp).toContain('writeUrl: message => pLog.info(message)')
  })

  it('confirms a successful interactive login before onboarding continues', () => {
    const initApp = initSource.slice(initSource.indexOf('export async function initApp('))
    const authenticated = initApp.indexOf('authenticatedViaLoginPrompt = true')
    const successMessage = initApp.indexOf("pLog.success('Login successful')")
    const authenticatedClient = initApp.indexOf('const supabase = await createSupabaseClient(options.apikey')

    expect(authenticated).toBeGreaterThanOrEqual(0)
    expect(successMessage).toBeGreaterThan(authenticated)
    expect(successMessage).toBeLessThan(authenticatedClient)
  })

  it('masks sensitive Ink text prompts without replacing their submitted value', () => {
    expect(initPromptsSource).toContain('mask?: string')
    expect(initPromptsSource).toContain('requestInitText(options.message, options.placeholder, options.validate, options.mask)')
    expect(initRuntimeSource).toContain('mask?: string')
    expect(initRuntimeSource).toContain('mask,')
    expect(initComponentsSource).toContain('prompt.mask ? prompt.mask.repeat(value.length) : value')
    expect(initComponentsSource).toContain('prompt.resolve(value)')
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

describe('login browser choice', () => {
  it('offers browser generation before manual API-key paste', async () => {
    const chooseLoginMethod = (loginModule as typeof loginModule & {
      chooseLoginMethod?: (prompt: (options: {
        message: string
        options: Array<{ value: string, label: string }>
      }) => Promise<string>) => Promise<string>
    }).chooseLoginMethod

    expect(typeof chooseLoginMethod).toBe('function')
    if (!chooseLoginMethod)
      return

    let promptOptions: { message: string, options: Array<{ value: string, label: string }> } | undefined
    const method = await chooseLoginMethod(async (options) => {
      promptOptions = options
      return 'browser'
    })

    expect(method).toBe('browser')
    expect(promptOptions?.options).toEqual([
      { value: 'browser', label: 'Open the browser to generate an API key automatically' },
      { value: 'paste', label: 'Paste an API key' },
    ])
  })

  it('uses browser login only when the login command has no explicit API key', () => {
    const loginAction = loginSource.slice(loginSource.indexOf('export async function login('))
    const resolveKey = loginAction.indexOf('resolveLoginCommandApiKey(apikey, options.apikey)')
    const chooseMethod = loginAction.indexOf('await chooseLoginMethod()')
    const browserLogin = loginAction.indexOf('await loginInitInBrowser(options)')
    const manualLogin = loginAction.indexOf('await loginInternal(resolvedApiKey, options, false)')

    expect(resolveKey).toBeGreaterThanOrEqual(0)
    expect(chooseMethod).toBeGreaterThan(resolveKey)
    expect(browserLogin).toBeGreaterThan(chooseMethod)
    expect(manualLogin).toBeGreaterThan(browserLogin)
    expect(loginAction).toContain('const supportsBrowserLogin = !options.local && !options.supaHost && !options.supaAnon')
    expect(loginAction).toContain('if (!resolvedApiKey && supportsBrowserLogin)')
    expect(loginAction).toContain("if (loginMethod === 'browser')")
  })

  it('fails before prompting when login has no key outside an interactive terminal', () => {
    const loginAction = loginSource.slice(loginSource.indexOf('export async function login('))
    const interactivityGate = loginAction.indexOf('if (!resolvedApiKey && !canPromptInteractively())')
    const missingKeyMessage = loginAction.indexOf("log.error('Missing API key. Provide it as an argument or with --apikey.')")
    const interactiveIntro = loginAction.indexOf('intro(`Login to Capgo`)')
    const chooseMethod = loginAction.indexOf('await chooseLoginMethod()')
    const manualPrompt = loginAction.indexOf('await loginInternal(resolvedApiKey, options, false)')

    expect(interactivityGate).toBeGreaterThanOrEqual(0)
    expect(missingKeyMessage).toBeGreaterThan(interactivityGate)
    expect(interactiveIntro).toBeGreaterThan(missingKeyMessage)
    expect(interactivityGate).toBeLessThan(chooseMethod)
    expect(interactivityGate).toBeLessThan(manualPrompt)
    expect(loginAction).toContain("throw new CliUserError('Missing API key')")
  })
})
