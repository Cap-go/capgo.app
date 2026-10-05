import type { AuthEmailTemplateDetails } from '../../../supabase/functions/_backend/utils/auth_email.ts'
import deleteAccountVerification from './delete_account_verification.html'
import deleteAccountVerificationText from './delete_account_verification.txt'
import emailChange from './email_change.html'
import emailChangeText from './email_change.txt'
import emailChangedNotification from './email_changed_notification.html'
import emailChangedNotificationText from './email_changed_notification.txt'
import invite from './invite.html'
import inviteText from './invite.txt'
import magiclink from './magiclink.html'
import magiclinkText from './magiclink.txt'
import mfaEmailVerification from './mfa_email_verification.html'
import mfaEmailVerificationText from './mfa_email_verification.txt'
import mfaFactorEnrolledNotification from './mfa_factor_enrolled_notification.html'
import mfaFactorEnrolledNotificationText from './mfa_factor_enrolled_notification.txt'
import mfaFactorUnenrolledNotification from './mfa_factor_unenrolled_notification.html'
import mfaFactorUnenrolledNotificationText from './mfa_factor_unenrolled_notification.txt'
import passwordChangedNotification from './password_changed_notification.html'
import passwordChangedNotificationText from './password_changed_notification.txt'
import reauthentication from './reauthentication.html'
import reauthenticationText from './reauthentication.txt'
import recovery from './recovery.html'
import recoveryText from './recovery.txt'
import signup from './signup.html'
import signupText from './signup.txt'

const templates = {
  delete_account_verification: { subject: 'Your code to continue account deletion', html: deleteAccountVerification, text: deleteAccountVerificationText },
  email_change: { subject: 'Confirm your Capgo.app email change', html: emailChange, text: emailChangeText },
  email_changed_notification: { subject: 'Your Capgo.app email was changed', html: emailChangedNotification, text: emailChangedNotificationText },
  invite: { subject: 'You\'re invited to Capgo.app', html: invite, text: inviteText },
  magiclink: { subject: 'Your Capgo.app sign-in link', html: magiclink, text: magiclinkText },
  mfa_email_verification: { subject: 'Your code to continue 2FA setup', html: mfaEmailVerification, text: mfaEmailVerificationText },
  mfa_factor_enrolled_notification: { subject: 'MFA added to your Capgo.app account', html: mfaFactorEnrolledNotification, text: mfaFactorEnrolledNotificationText },
  mfa_factor_unenrolled_notification: { subject: 'MFA removed from your Capgo.app account', html: mfaFactorUnenrolledNotification, text: mfaFactorUnenrolledNotificationText },
  password_changed_notification: { subject: 'Your Capgo.app password was changed', html: passwordChangedNotification, text: passwordChangedNotificationText },
  reauthentication: { subject: 'Your Capgo.app confirmation code', html: reauthentication, text: reauthenticationText },
  recovery: { subject: 'Reset your Capgo.app password', html: recovery, text: recoveryText },
  signup: { subject: 'Confirm your Capgo.app email', html: signup, text: signupText },
} as const

type AuthEmailTemplate = keyof typeof templates
type PurposeSpecificAuthEmailTemplate = 'delete_account_verification' | 'mfa_email_verification'
export type AuthEmailAction = Exclude<AuthEmailTemplate, PurposeSpecificAuthEmailTemplate>

export function isAuthEmailAction(action: string): action is AuthEmailAction {
  return action !== 'delete_account_verification'
    && action !== 'mfa_email_verification'
    && Object.hasOwn(templates, action)
}

export function selectAuthEmailTemplate(action: AuthEmailAction, redirectTo: string, siteUrl: string): AuthEmailTemplate {
  if (action !== 'magiclink')
    return action

  try {
    const redirect = new URL(redirectTo)
    const site = new URL(siteUrl)
    if (redirect.origin === site.origin && redirect.pathname === '/') {
      const reason = redirect.searchParams.get('reason')
      if (reason === 'delete_account')
        return 'delete_account_verification'
      if (reason === 'setup_2fa')
        return 'mfa_email_verification'
    }
  }
  catch {
    // Invalid or missing redirect URLs use the normal sign-in template.
  }

  return action
}

function render(source: string, details: AuthEmailTemplateDetails, escape: (value: string) => string): string {
  return source.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: keyof AuthEmailTemplateDetails) => {
    const value = details[key]
    if (!value)
      throw new Error(`Missing auth email template value: ${key}`)
    return escape(value)
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[char] ?? char)
}

export function renderAuthEmail(action: AuthEmailTemplate, details: AuthEmailTemplateDetails) {
  const template = templates[action]
  return {
    subject: template.subject,
    html: render(template.html, details, escapeHtml),
    text: render(template.text, details, value => value),
  }
}
