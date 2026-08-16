import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { intro, isCancel, log, outro, password } from '@clack/prompts'
import { checkAlerts } from './api/update'
import { flushDeferredCommandInvocation } from './analytics/track'
import { resolveLoginCommandApiKey } from './auth/command-input'
import { validateAndSaveKey } from './auth/session'
import { CliUserError } from './shared/cli-user-error'

interface Options {
  apikey?: string
  local: boolean
  supaHost?: string
  supaAnon?: string
}

export function doLoginExists() {
  const userHomeDir = homedir()
  return existsSync(`${userHomeDir}/.capgo`) || existsSync('.capgo')
}

export async function loginInternal(apikey: string | undefined, options: Options, silent = false): Promise<string> {
  if (!silent)
    intro(`Login to Capgo`)

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

  if (!silent) {
    log.success(`login saved into .capgo file in ${local ? 'local' : 'home'} directory`)
    outro('Done ✅')
  }

  return apikey
}

export async function login(apikey: string, options: Options) {
  const validatedApiKey = await loginInternal(resolveLoginCommandApiKey(apikey, options.apikey), options, false)
  flushDeferredCommandInvocation(validatedApiKey)
}
