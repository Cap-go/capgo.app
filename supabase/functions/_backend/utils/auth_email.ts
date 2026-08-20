import { trimTrailingSlashes } from './utils.ts'

export const AUTH_EMAIL_EVENT_PREFIX = 'auth:'

export const AUTH_EMAIL_EVENTS = {
  email_change: 'auth:email_change',
  email_change_current: 'auth:email_change_current',
  email_change_new: 'auth:email_change_new',
  email_changed_notification: 'auth:email_changed',
  identity_linked_notification: 'auth:identity_linked',
  identity_unlinked_notification: 'auth:identity_unlinked',
  invite: 'auth:invite',
  magiclink: 'auth:magiclink',
  mfa_factor_enrolled_notification: 'auth:mfa_factor_enrolled',
  mfa_factor_unenrolled_notification: 'auth:mfa_factor_unenrolled',
  password_changed_notification: 'auth:password_changed',
  phone_changed_notification: 'auth:phone_changed',
  reauthentication: 'auth:reauthentication',
  recovery: 'auth:recovery',
  signup: 'auth:signup',
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
