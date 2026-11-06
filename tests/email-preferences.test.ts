import type { EmailPreferences } from '../supabase/functions/_backend/utils/org_email_notifications.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { APP_NAME, BASE_URL, getSupabaseClient, ORG_ID_EMAIL_PREFS, resetAndSeedAppData, resetAppData, STRIPE_CUSTOMER_ID_EMAIL_PREFS, USER_EMAIL_EMAIL_PREFS, USER_ID_EMAIL_PREFS, warmEdgeEndpoint } from './test-utils.ts'

const id = randomUUID()
const APPNAME_PREFS = `${APP_NAME}.ep.${id}`

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

const defaultEmailPreferences: EmailPreferences = {
  usage_limit: true,
  credit_usage: true,
  onboarding: true,
  weekly_stats: true,
  monthly_stats: true,
  deploy_stats_24h: true,
  bundle_created: true,
  bundle_deployed: true,
  device_error: true,
  channel_self_rejected: true,
}

function isBentoConfiguredForTests() {
  const publishableKey = (process.env.BENTO_PUBLISHABLE_KEY || '').trim()
  const secretKey = (process.env.BENTO_SECRET_KEY || '').trim()
  const siteUuid = (process.env.BENTO_SITE_UUID || '').trim()

  if (!publishableKey || !secretKey || !siteUuid)
    return false

  const placeholders = new Set(['test', 'TEST', 'placeholder', 'changeme'])
  return !placeholders.has(publishableKey) && !placeholders.has(secretKey) && !placeholders.has(siteUuid)
}

async function resetEmailPreferences() {
  const supabase = getSupabaseClient()
  const { error } = await supabase.from('users').update({
    email_preferences: defaultEmailPreferences,
  } as any).eq('id', USER_ID_EMAIL_PREFS)

  if (error)
    throw new Error(`resetEmailPreferences failed: ${error.message} (${error.code ?? 'unknown_code'})`)
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME_PREFS, {
    orgId: ORG_ID_EMAIL_PREFS,
    userId: USER_ID_EMAIL_PREFS,
    stripeCustomerId: STRIPE_CUSTOMER_ID_EMAIL_PREFS,
  })

  // Warm cron_email so the first preference assertion does not race a cold Deno isolate (502).
  await warmEdgeEndpoint(`${BASE_URL}/triggers/cron_email`, {
    method: 'POST',
    headers: triggerHeaders,
    body: JSON.stringify({
      email: USER_EMAIL_EMAIL_PREFS,
      appId: APPNAME_PREFS,
      type: 'monthly_create_stats',
    }),
  })
})

beforeEach(async () => {
  await resetEmailPreferences()
})

afterEach(async () => {
  await resetEmailPreferences()
})

afterAll(async () => {
  await resetAppData(APPNAME_PREFS)
  await resetEmailPreferences()
})

async function setEmailPreference(key: keyof EmailPreferences, value: boolean) {
  const { error } = await getSupabaseClient()
    .from('users')
    .update({ email_preferences: { ...defaultEmailPreferences, [key]: value } } as any)
    .eq('id', USER_ID_EMAIL_PREFS)
  if (error)
    throw new Error(`setEmailPreference failed: ${error.message}`)
}

async function postCronEmail(body: Record<string, unknown>): Promise<Response> {
  const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
    method: 'POST',
    headers: triggerHeaders,
    body: JSON.stringify(body),
  })
  if (response.status !== 200) {
    const text = await response.clone().text().catch(() => '<unreadable body>')
    console.error(`[email-preferences] cron_email non-200 status=${response.status} body=${text.slice(0, 800)}`)
  }
  return response
}

const cronCases = [
  { preference: 'weekly_stats', body: { type: 'weekly_install_stats' } },
  { preference: 'monthly_stats', body: { type: 'monthly_create_stats' } },
  // Preference check happens before the (non-existent) version lookup.
  { preference: 'deploy_stats_24h', body: { type: 'deploy_install_stats', versionId: 999999 } },
] as const

describe('[POST] /triggers/cron_email - Email Preference Filtering', () => {
  it.each(cronCases)('skips $body.type email when $preference preference is disabled', async ({ preference, body }) => {
    if (!isBentoConfiguredForTests()) {
      console.warn('Skipping test: Bento is not configured, cron_email does not exercise org email preference fan-out in CI')
      return
    }

    await setEmailPreference(preference, false)
    const response = await postCronEmail({ email: USER_EMAIL_EMAIL_PREFS, appId: APPNAME_PREFS, ...body })

    expect(response.status).toBe(200)
    const data = await response.json() as { status: string }
    expect(data.status).toBe('Email preference disabled')
  })

  it.each(cronCases.slice(0, 2))('allows $body.type email when $preference preference is enabled', async ({ preference, body }) => {
    await setEmailPreference(preference, true)
    const response = await postCronEmail({ email: USER_EMAIL_EMAIL_PREFS, appId: APPNAME_PREFS, ...body })

    expect(response.status).toBe(200)
    const data = await response.json() as { status?: string }
    // When enabled, it either sends the email or returns "No updates this week", never "Email preference disabled".
    expect(data.status).not.toBe('Email preference disabled')
  })
})
