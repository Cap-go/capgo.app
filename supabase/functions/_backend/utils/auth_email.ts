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

export interface GoTrueSendEmailEvent {
  email_data?: {
    email_action_type?: string
    factor_type?: string
    new_email?: string
    old_email?: string
    redirect_to?: string
    site_url?: string
    token?: string
    token_hash?: string
    token_hash_new?: string
    token_new?: string
  }
  user?: {
    email?: string
    new_email?: string
  }
}

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

export interface AuthEmailDelivery {
  email: string
  payload: AuthEmailPayload
}

export interface AuthEmailBentoDetails {
  confirmation_link: string
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

function verifyType(emailActionType: string): string {
  if (emailActionType === 'email_change_current' || emailActionType === 'email_change_new')
    return 'email_change'
  return emailActionType
}

function delivery(
  email: string,
  event: GoTrueSendEmailEvent,
  token: string,
  tokenHash: string,
): AuthEmailDelivery {
  const emailData = event.email_data ?? {}
  const user = event.user ?? {}
  return {
    email,
    payload: {
      email,
      email_action_type: verifyType(textField(emailData.email_action_type)),
      factor_type: textField(emailData.factor_type),
      new_email: textField(user.new_email) || textField(emailData.new_email),
      old_email: textField(emailData.old_email),
      redirect_to: textField(emailData.redirect_to),
      site_url: textField(emailData.site_url),
      token,
      token_hash: tokenHash,
    },
  }
}

export function authEmailDeliveriesFromGoTrueEvent(event: GoTrueSendEmailEvent): AuthEmailDelivery[] {
  const emailData = event.email_data ?? {}
  const user = event.user ?? {}
  const actionType = textField(emailData.email_action_type)
  const currentEmail = textField(user.email)
  const newEmail = textField(user.new_email) || textField(emailData.new_email)
  const oldEmail = textField(emailData.old_email)
  const token = textField(emailData.token)
  const tokenNew = textField(emailData.token_new)
  const tokenHash = textField(emailData.token_hash)
  const tokenHashNew = textField(emailData.token_hash_new)

  if (actionType === 'email_change' && tokenHash && tokenHashNew) {
    return [
      delivery(currentEmail, event, token, tokenHashNew),
      delivery(newEmail || currentEmail, event, tokenNew, tokenHash),
    ].filter(item => item.email)
  }

  if (actionType === 'email_change_current')
    return [delivery(currentEmail, event, token, tokenHashNew || tokenHash)].filter(item => item.email)

  if (actionType === 'email_change_new' || actionType === 'email_change') {
    return [delivery(
      newEmail || currentEmail,
      event,
      tokenNew || token,
      tokenHash,
    )].filter(item => item.email)
  }

  if (actionType === 'email_changed_notification')
    return [delivery(oldEmail || currentEmail, event, token, tokenHash)].filter(item => item.email)

  return [delivery(currentEmail, event, token, tokenHash)].filter(item => item.email)
}

export function authEmailPayloadFromGoTrueEvent(event: GoTrueSendEmailEvent): AuthEmailPayload {
  return authEmailDeliveriesFromGoTrueEvent(event)[0]?.payload ?? {
    email: '',
    email_action_type: '',
  }
}

export function getAuthEmailBentoEvent(emailActionType: string): string {
  const actionType = textField(emailActionType)
  if (!actionType)
    return `${AUTH_EMAIL_EVENT_PREFIX}unknown`

  return AUTH_EMAIL_EVENTS[actionType as keyof typeof AUTH_EMAIL_EVENTS]
    ?? AUTH_EMAIL_EVENTS[verifyType(actionType) as keyof typeof AUTH_EMAIL_EVENTS]
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
  const actionType = verifyType(textField(emailActionType))
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
  const confirmationUrl = buildAuthConfirmationUrl(
    supabaseUrl,
    payload.token_hash ?? '',
    payload.email_action_type,
    payload.redirect_to ?? '',
  )

  return {
    confirmation_link: siteUrl && confirmationUrl
      ? `${siteUrl}/confirm-signup?confirmation_url=${encodeURIComponent(confirmationUrl)}`
      : '',
    confirmation_url: confirmationUrl,
    email: textField(payload.email),
    factor_type: textField(payload.factor_type),
    new_email: textField(payload.new_email),
    old_email: textField(payload.old_email),
    site_url: siteUrl,
    token: textField(payload.token),
  }
}
