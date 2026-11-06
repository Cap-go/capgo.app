import type { AccountProfile, AccountSetOptions } from '../schemas/account'
import type { OptionsBase } from '../schemas/base'
import { intro, log, outro } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { CliUserError } from '../shared/cli-user-error'
import { parseEmailPreferenceFlags, USER_EMAIL_PREFERENCE_KEYS } from '../shared/email-preferences'
import { formatTable } from '../terminal-table'
import { findSavedKey, formatCapgoCliInvokeError, invokeCapgoCliApi } from '../utils'

function requireApikey(apikey: string | undefined, silent: boolean): string {
  const key = apikey || findSavedKey(silent)
  if (!key) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to manage your account')
    throw new Error('Missing API key')
  }
  return key
}

function nullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null)
    return value
  return value === '' || value === 'null' ? null : value
}

export async function getAccountInternal(options: OptionsBase, silent = false): Promise<AccountProfile> {
  if (!silent)
    intro('Account settings')
  const apikey = requireApikey(options.apikey, silent)

  const { data, error } = await invokeCapgoCliApi<AccountProfile>('user', {
    apikey,
    method: 'GET',
    apiHost: options.apiHost,
  })
  if (error || !data) {
    const message = error ? await formatCapgoCliInvokeError(error) : 'Empty response'
    if (!silent)
      log.error(`Cannot get account settings: ${message}`)
    throw new Error(`Cannot get account settings: ${message}`)
  }

  if (!silent) {
    log.info(formatTable({
      headers: ['Setting', 'Value'],
      rows: [
        ['Account ID', data.id],
        ['Email', data.email],
        ['First name', data.first_name ?? ''],
        ['Last name', data.last_name ?? ''],
        ['Country', data.country ?? ''],
        ['Discord username', data.discord_username ?? ''],
        ['Format locale', data.format_locale ?? ''],
        ['Email notifications', String(data.enable_notifications)],
        ['Newsletter', String(data.opt_for_newsletters)],
        ...Object.entries(data.email_preferences ?? {}).map(([key, value]) => [`Email: ${key}`, String(value)]),
      ],
    }))
    outro('Done ✅')
  }
  return data
}

export async function setAccountInternal(options: AccountSetOptions, silent = false): Promise<AccountProfile> {
  if (!silent)
    intro('Update account settings')
  const apikey = requireApikey(options.apikey, silent)

  const flagPreferences = parseEmailPreferenceFlags(options.emailPreference, USER_EMAIL_PREFERENCE_KEYS)
  const emailPreferences = options.emailPreferences || flagPreferences
    ? { ...options.emailPreferences, ...flagPreferences }
    : undefined
  if (emailPreferences) {
    const unknownKey = Object.keys(emailPreferences).find(key => !(USER_EMAIL_PREFERENCE_KEYS as readonly string[]).includes(key))
    if (unknownKey)
      throw new CliUserError(`Unknown email preference "${unknownKey}". Allowed: ${USER_EMAIL_PREFERENCE_KEYS.join(', ')}`)
  }

  const body: Record<string, unknown> = {}
  if (options.firstName !== undefined)
    body.first_name = options.firstName
  if (options.lastName !== undefined)
    body.last_name = options.lastName
  if (options.country !== undefined)
    body.country = options.country
  if (options.discordUsername !== undefined)
    body.discord_username = nullableText(options.discordUsername)
  if (options.formatLocale !== undefined)
    body.format_locale = nullableText(options.formatLocale)
  if (options.notifications !== undefined)
    body.enable_notifications = options.notifications
  if (options.newsletter !== undefined)
    body.opt_for_newsletters = options.newsletter
  if (emailPreferences)
    body.email_preferences = emailPreferences

  if (!Object.keys(body).length) {
    if (!silent)
      log.error('Nothing to update, pass at least one setting (see --help)')
    throw new CliUserError('Nothing to update')
  }

  const { data, error } = await invokeCapgoCliApi<AccountProfile>('user', {
    apikey,
    method: 'PUT',
    body,
    apiHost: options.apiHost,
  })
  if (error || !data) {
    const message = error ? await formatCapgoCliInvokeError(error) : 'Empty response'
    if (!silent)
      log.error(`Cannot update account settings: ${message}`)
    throw new Error(`Cannot update account settings: ${message}`)
  }

  void trackEvent({ channel: 'account', event: 'Account Settings Updated', apikey, tags: { fields: Object.keys(body).join(',') } })

  if (!silent) {
    log.success('Account settings updated')
    outro('Done ✅')
  }
  return data
}

export async function getAccount(options: OptionsBase) {
  await getAccountInternal(options)
}

export async function setAccount(options: AccountSetOptions) {
  await setAccountInternal(options)
}
