import { trimTrailingSlashes } from './utils.ts'

export const AUTH_EMAIL_EVENT_PREFIX = 'auth_'

export const AUTH_EMAIL_EVENTS = {
  email_change: 'auth_email_change',
  email_change_current: 'auth_email_change',
  email_change_new: 'auth_email_change',
  email_changed_notification: 'auth_email_changed_notification',
  invite: 'auth_invite',
  magiclink: 'auth_magic_link',
  mfa_factor_enrolled_notification: 'auth_mfa_factor_enrolled_notification',
  mfa_factor_unenrolled_notification: 'auth_mfa_factor_unenrolled_notification',
  password_changed_notification: 'auth_password_changed_notification',
  reauthentication: 'auth_reauthentication',
  recovery: 'auth_recovery',
  signup: 'auth_confirmation',
} as const

export interface AuthEmailPayload {
  email: string
  email_action_type: string
  factor_type?: string
  new_email?: string
  old_email?: string
  redirect_to?: string
  site_url?: string
  token?: string
  token_hash?: string
}

export interface AuthEmailBentoDetails {
  confirmation_url: string
  email: string
  factor_type: string
  new_email: string
  old_email: string
  site_url: string
  token: string
}

function textField(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function getAuthEmailBentoEvent(emailActionType: string): string {
  const actionType = textField(emailActionType)
  if (!actionType)
    return `${AUTH_EMAIL_EVENT_PREFIX}unknown`

  return AUTH_EMAIL_EVENTS[actionType as keyof typeof AUTH_EMAIL_EVENTS]
    ?? `${AUTH_EMAIL_EVENT_PREFIX}${actionType}`
}

export function buildAuthConfirmationUrl(
  supabaseUrl: string,
  tokenHash: string,
  emailActionType: string,
  redirectTo: string,
): string {
  const baseUrl = trimTrailingSlashes(textField(supabaseUrl))
  const hash = textField(tokenHash)
  const actionType = textField(emailActionType)
  if (!baseUrl || !hash || !actionType)
    return ''

  const params = new URLSearchParams({
    token: hash,
    type: actionType,
  })
  const redirect = textField(redirectTo)
  if (redirect)
    params.set('redirect_to', redirect)

  return `${baseUrl}/auth/v1/verify?${params.toString()}`
}

export function buildAuthEmailBentoDetails(
  payload: AuthEmailPayload,
  supabaseUrl: string,
  webappUrl: string,
): AuthEmailBentoDetails {
  const siteUrl = trimTrailingSlashes(textField(webappUrl)) || trimTrailingSlashes(textField(payload.site_url))

  return {
    confirmation_url: buildAuthConfirmationUrl(
      supabaseUrl,
      payload.token_hash ?? '',
      payload.email_action_type,
      payload.redirect_to ?? '',
    ),
    email: textField(payload.email),
    factor_type: textField(payload.factor_type),
    new_email: textField(payload.new_email),
    old_email: textField(payload.old_email),
    site_url: siteUrl,
    token: textField(payload.token),
  }
}
