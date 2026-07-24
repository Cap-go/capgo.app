export type EmailType = 'professional' | 'personal' | 'disposable'

export const PERSONAL_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.fr',
  'yahoo.co.uk',
  'outlook.com',
  'hotmail.com',
  'hotmail.fr',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'gmx.com',
  'gmx.de',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
] as const

export const DISPOSABLE_EMAIL_DOMAINS = [
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'dispostable.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmail.net',
  'throwawaymail.com',
  'yopmail.com',
] as const

const personalEmailDomainSet: ReadonlySet<string> = new Set(PERSONAL_EMAIL_DOMAINS)
const disposableEmailDomainSet: ReadonlySet<string> = new Set(DISPOSABLE_EMAIL_DOMAINS)

export function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email)
    return null

  const normalizedEmail = email.trim().toLowerCase()
  const atIndex = normalizedEmail.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === normalizedEmail.length - 1)
    return null

  return normalizedEmail.slice(atIndex + 1)
}

export function classifyEmailDomain(domain: string | null | undefined): EmailType {
  if (!domain)
    return 'professional'

  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedDomain)
    return 'professional'

  if (disposableEmailDomainSet.has(normalizedDomain))
    return 'disposable'

  if (personalEmailDomainSet.has(normalizedDomain))
    return 'personal'

  return 'professional'
}

export function classifyEmailAddress(email: string | null | undefined): EmailType {
  return classifyEmailDomain(extractEmailDomain(email))
}
