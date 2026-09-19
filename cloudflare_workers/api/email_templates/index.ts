import type { AuthEmailTemplateDetails } from '../../../supabase/functions/_backend/utils/auth_email.ts'
import emailChange from './email_change.html'
import emailChangedNotification from './email_changed_notification.html'
import invite from './invite.html'
import magiclink from './magiclink.html'
import mfaFactorEnrolledNotification from './mfa_factor_enrolled_notification.html'
import mfaFactorUnenrolledNotification from './mfa_factor_unenrolled_notification.html'
import passwordChangedNotification from './password_changed_notification.html'
import reauthentication from './reauthentication.html'
import recovery from './recovery.html'
import signup from './signup.html'

const templates = {
  email_change: { subject: 'Confirm your Capgo.app email change', html: emailChange },
  email_changed_notification: { subject: 'Your Capgo.app email was changed', html: emailChangedNotification },
  invite: { subject: 'You\'re invited to Capgo.app', html: invite },
  magiclink: { subject: 'Your Capgo.app sign-in link', html: magiclink },
  mfa_factor_enrolled_notification: { subject: 'MFA added to your Capgo.app account', html: mfaFactorEnrolledNotification },
  mfa_factor_unenrolled_notification: { subject: 'MFA removed from your Capgo.app account', html: mfaFactorUnenrolledNotification },
  password_changed_notification: { subject: 'Your Capgo.app password was changed', html: passwordChangedNotification },
  reauthentication: { subject: 'Your Capgo.app confirmation code', html: reauthentication },
  recovery: { subject: 'Reset your Capgo.app password', html: recovery },
  signup: { subject: 'Confirm your Capgo.app email', html: signup },
} as const

export type AuthEmailAction = keyof typeof templates

export function isAuthEmailAction(action: string): action is AuthEmailAction {
  return Object.hasOwn(templates, action)
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

function htmlToTextTemplate(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const text = label.replace(/<[^>]*>/g, '').trim()
      return text === href ? href : `${text} (${href})`
    })
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function renderAuthEmail(action: AuthEmailAction, details: AuthEmailTemplateDetails) {
  const template = templates[action]
  return {
    subject: template.subject,
    html: render(template.html, details, escapeHtml),
    text: render(htmlToTextTemplate(template.html), details, value => value),
  }
}
