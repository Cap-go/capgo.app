import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { isBentoConfigured, syncBentoSubscriberTags } from './bento.ts'
import { cloudlog } from './logging.ts'
import { getOrgAdminMemberEmailsForTags } from './org_email_notifications.ts'
import { getDrizzleClient, getPgClient } from './pg.ts'
import * as schema from './postgres_schema.ts'
import { getEnv } from './utils.ts'

export const ORG_ONBOARDING_INTENTS = ['unknown', 'ota', 'builder', 'both', 'exploring'] as const
export type OrgOnboardingIntent = typeof ORG_ONBOARDING_INTENTS[number]

const TRAILING_SLASHES_REGEX = /\/+$/

export function parseOrgOnboardingIntent(onboarding: unknown): OrgOnboardingIntent {
  if (!onboarding || typeof onboarding !== 'object' || !('intent' in onboarding))
    return 'unknown'

  const intent = (onboarding as { intent?: unknown }).intent
  if (typeof intent === 'string' && (ORG_ONBOARDING_INTENTS as readonly string[]).includes(intent))
    return intent as OrgOnboardingIntent

  return 'unknown'
}

export function buildOnboardingIntentBentoTags(intent: OrgOnboardingIntent): { segments: string[], deleteSegments: string[] } {
  const activeTag = `onboarding_intent:${intent}`

  return {
    segments: [activeTag],
    deleteSegments: ORG_ONBOARDING_INTENTS
      .filter(value => value !== intent)
      .map(value => `onboarding_intent:${value}`),
  }
}

export function buildOnboardingIntentBentoEventData(
  c: Context,
  intent: OrgOnboardingIntent,
  org: { id: string, name: string, website?: string | null },
): Record<string, string | null> {
  const baseUrl = (getEnv(c, 'WEBAPP_URL') || '').replace(TRAILING_SLASHES_REGEX, '')
  const onboardingUrlOta = baseUrl ? `${baseUrl}/app/new` : null
  const onboardingUrlBuilder = baseUrl ? `${baseUrl}/apps` : null

  let onboardingUrl: string | null = onboardingUrlOta
  if (intent === 'builder')
    onboardingUrl = onboardingUrlBuilder
  else if (intent === 'exploring' || intent === 'unknown')
    onboardingUrl = baseUrl ? `${baseUrl}/apps` : null

  return {
    org_id: org.id,
    org_name: org.name,
    org_website: org.website ?? null,
    onboarding_intent: intent,
    onboarding_url: onboardingUrl,
    onboarding_url_ota: onboardingUrlOta,
    onboarding_url_builder: onboardingUrlBuilder,
  }
}

async function lookupUserEmail(
  c: Context,
  drizzle: ReturnType<typeof getDrizzleClient>,
  userId: string,
): Promise<string | null> {
  try {
    const users = await drizzle
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)

    return users[0]?.email ?? null
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'lookupUserEmail failed', userId, error })
    return null
  }
}

export async function syncOrgOnboardingIntentBentoTags(
  c: Context,
  intent: OrgOnboardingIntent,
  emails: Array<string | null | undefined>,
) {
  if (!isBentoConfigured(c))
    return

  const tags = buildOnboardingIntentBentoTags(intent)
  const uniqueEmails = Array.from(new Set(
    emails
      .map(email => email?.trim().toLowerCase())
      .filter((email): email is string => Boolean(email)),
  ))

  if (uniqueEmails.length === 0)
    return

  await syncBentoSubscriberTags(c, uniqueEmails.map(email => ({
    email,
    segments: tags.segments,
    deleteSegments: tags.deleteSegments,
  })))

  cloudlog({
    requestId: c.get('requestId'),
    message: 'syncOrgOnboardingIntentBentoTags',
    intent,
    recipientCount: uniqueEmails.length,
  })
}

export async function syncOrgOnboardingIntentForOrg(
  c: Context,
  org: { id: string, management_email?: string | null, created_by?: string | null, onboarding?: unknown },
) {
  const intent = parseOrgOnboardingIntent(org.onboarding)
  const pgClient = getPgClient(c, true)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    const { emails: adminEmails } = await getOrgAdminMemberEmailsForTags(c, org.id, drizzleClient)
    const emailSet = new Set(adminEmails.map(email => email.trim().toLowerCase()))

    if (org.management_email) {
      const managementEmail = org.management_email.trim().toLowerCase()
      if (managementEmail)
        emailSet.add(managementEmail)
    }

    if (org.created_by) {
      const creatorEmail = await lookupUserEmail(c, drizzleClient, org.created_by)
      if (creatorEmail)
        emailSet.add(creatorEmail.trim().toLowerCase())
    }

    await syncOrgOnboardingIntentBentoTags(c, intent, Array.from(emailSet))
  }
  finally {
    await pgClient.end()
  }
}

export const orgOnboardingIntentTestUtils = {
  lookupUserEmail,
}
