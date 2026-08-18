import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { intro, isCancel, log, outro, password, select } from '@clack/prompts'
import { flushDeferredCommandInvocation } from './analytics/track'
import { checkAlerts } from './api/update'
import { resolveLoginCommandApiKey } from './auth/command-input'
import { validateAndSaveKey } from './auth/session'
import { loginInitInBrowser } from './init/browser-login'
import { CliUserError } from './shared/cli-user-error'
import { canPromptInteractively } from './utils'

interface Options {
  apikey?: string
  local: boolean
  supaHost?: string
  supaAnon?: string
}

export type LoginMethod = 'browser' | 'paste'
type LoginMethodPrompt = (options: {
  message: string
  options: Array<{ value: LoginMethod, label: string }>
}) => Promise<unknown>

export const LOGIN_METHOD_OPTIONS: Array<{ value: LoginMethod, label: string }> = [
  { value: 'browser', label: 'Open the browser to generate an API key automatically' },
  { value: 'paste', label: 'Paste an API key' },
]

export async function chooseLoginMethod(prompt: LoginMethodPrompt = options => select(options)): Promise<LoginMethod> {
  const method = await prompt({
    message: 'How would you like to log in?',
    options: LOGIN_METHOD_OPTIONS,
  })

  if (isCancel(method)) {
    log.warn('Login cancelled')
    throw new CliUserError('Login cancelled')
  }
  if (method !== 'browser' && method !== 'paste')
    throw new CliUserError('Invalid login method')
  return method
}

export function doLoginExists() {
  const userHomeDir = homedir()
  return existsSync(`${userHomeDir}/.capgo`) || existsSync('.capgo')
}

function showLoginSuccess(local: boolean) {
  log.success(`login saved into .capgo file in ${local ? 'local' : 'home'} directory`)
  outro('Done ✅')
}

export async function loginInternal(apikey: string | undefined, options: Options, silent = false): Promise<string> {
  if (!apikey && !silent) {
    const apikeyInput = await password({
      message: 'Enter your API key:',
      mask: '*',
    })

    if (isCancel(apikeyInput)) {
      log.warn('Login cancelled')
      throw new CliUserError('Login cancelled')
    }
    apikey = apikeyInput as string
  }

  if (!apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to upload your bundle')
    throw new Error('Missing API key')
  }

  if (!silent)
    await checkAlerts()

  const { local } = options

  if (local && !existsSync('.git')) {
    if (!silent)
      log.error('To use local you should be in a git repository')
    throw new Error('Not in a git repository')
  }

  // Validate, persist (0o600) and emit the login event via the shared auth core.
  await validateAndSaveKey(apikey, {
    local,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (!silent)
    showLoginSuccess(local)

  return apikey
}

export async function login(apikey: string, options: Options) {
  let resolvedApiKey = resolveLoginCommandApiKey(apikey, options.apikey)
  const supportsBrowserLogin = !options.local && !options.supaHost && !options.supaAnon

  if (!resolvedApiKey && !canPromptInteractively()) {
    log.error('Missing API key. Provide it as an argument or with --apikey.')
    throw new CliUserError('Missing API key')
  }

  intro(`Login to Capgo`)

  if (!resolvedApiKey && supportsBrowserLogin) {
    const loginMethod = await chooseLoginMethod()
    if (loginMethod === 'browser') {
      await checkAlerts()
      resolvedApiKey = await loginInitInBrowser(options)
      showLoginSuccess(options.local)
      flushDeferredCommandInvocation(resolvedApiKey)
      return
    }
  }

  const validatedApiKey = await loginInternal(resolvedApiKey, options, false)
  flushDeferredCommandInvocation(validatedApiKey)
}
