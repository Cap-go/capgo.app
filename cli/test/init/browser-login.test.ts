import { readFileSync } from 'node:fs'
import { describe, expect, it, mock } from 'bun:test'
import { beginBrowserLogin, completeBrowserLogin, loginInitInBrowser, shouldStartInitBrowserLogin } from '../../src/init/browser-login'
import * as loginModule from '../../src/login'

const helperSource = readFileSync(new URL('../../src/init/browser-login.ts', import.meta.url), 'utf8')
const initPromptsSource = readFileSync(new URL('../../src/init/prompts.ts', import.meta.url), 'utf8')
const initComponentsSource = readFileSync(new URL('../../src/init/ui/components.tsx', import.meta.url), 'utf8')

describe('init browser login', () => {
  it('keeps a browser session when opening the browser fails', async () => {
    const urls: string[] = []
    const session = await beginBrowserLogin(url => urls.push(url), {
      createSession: () => 'browser-session',
      openUrl: async () => { throw new Error('browser unavailable') },
    })

    expect(session).toEqual({
      session: 'browser-session',
      url: 'https://console.capgo.app/login-cli?session=browser-session',
      browserOpened: false,
    })
    expect(urls).toEqual([session.url])
  })

  it('completes the same session after validating the key', async () => {
    const order: string[] = []
    await completeBrowserLogin({
      session: 'browser-session',
      url: 'https://console.capgo.app/login-cli?session=browser-session',
      browserOpened: true,
    }, 'fake-key', { local: false }, {
      validateKey: async () => { order.push('validate'); return { userId: 'user-1' } },
      listOrganizationIds: async () => { order.push('organizations'); return ['org-1'] },
      sendEvent: async (_key, payload) => { order.push(payload.description) },
    })
    expect(order).toEqual(['validate', 'organizations', 'cli-login:browser-session'])
  })

  it('starts only for an interactive init with no resolved key', () => {
    expect(shouldStartInitBrowserLogin('', true)).toBe(true)
    expect(shouldStartInitBrowserLogin('argument-or-saved-key', true)).toBe(false)
    expect(shouldStartInitBrowserLogin('', false)).toBe(false)
  })

  it('uses a password prompt with star masking', () => {
    expect(helperSource).toContain("mask: '*'")
    expect(helperSource).not.toContain('text({')
  })

  it('masks sensitive Ink text prompts without replacing their submitted value', () => {
    expect(initPromptsSource).toContain('requestInitText(options.message, options.placeholder, options.validate, options.mask)')
    expect(initComponentsSource).toContain('prompt.mask ? prompt.mask.repeat(value.length) : value')
    expect(initComponentsSource).toContain('prompt.resolve(value)')
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
      apiHost: undefined,
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
})
