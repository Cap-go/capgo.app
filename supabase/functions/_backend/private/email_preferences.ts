import type { EmailPreferenceKey, EmailPreferences } from '../utils/org_email_notifications.ts'
import { z } from 'zod'
import { unsubscribeBento } from '../utils/bento.ts'
import { CacheHelper } from '../utils/cache.ts'
import { BRES, createHono, parseBody, simpleRateLimit, useCors } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { syncUserPreferenceTags } from '../utils/user_preferences.ts'
import { version } from '../utils/version.ts'

/** Preference keys users can manage from the public email footer form. */
export const PUBLIC_EMAIL_PREFERENCE_KEYS = [
  'usage_limit',
  'credit_usage',
  'onboarding',
  'builder_onboarding',
  'weekly_stats',
  'monthly_stats',
  'billing_period_stats',
  'deploy_stats_24h',
  'bundle_created',
  'bundle_deployed',
  'device_error',
  'channel_self_rejected',
  'bundle_incompatible',
] as const satisfies readonly EmailPreferenceKey[]

type PublicEmailPreferenceKey = typeof PUBLIC_EMAIL_PREFERENCE_KEYS[number]

const preferenceValueSchema = z.record(z.string(), z.boolean())

const bodySchema = z.object({
  email: z.string().trim().email().max(320),
  preferences: preferenceValueSchema.optional(),
  enable_notifications: z.boolean().optional(),
  opt_for_newsletters: z.boolean().optional(),
  unsubscribe_all: z.boolean().optional(),
})

const RATE_LIMIT_PATH = '/rate-limit/email-preferences'
const RATE_LIMIT_TTL_SECONDS = 60 * 15
const RATE_LIMIT_MAX = 30

export const app = createHono('', version)

app.use('/', useCors)

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

/** Escape `%` / `_` so PostgREST `ilike` cannot be used as a wildcard probe. */
export function escapeIlikeExact(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Public footer form is opt-out only: keep allowlisted keys set to `false`.
 * Never re-enable preferences from this unauthenticated path.
 */
export function sanitizeOptOutPreferences(input: Record<string, boolean> | undefined): Partial<EmailPreferences> {
  if (!input)
    return {}
  const allowed = new Set<string>(PUBLIC_EMAIL_PREFERENCE_KEYS)
  const out: Partial<EmailPreferences> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key) || value !== false)
      continue
    out[key as PublicEmailPreferenceKey] = false
  }
  return out
}

function allPreferencesDisabled(): EmailPreferences {
  const prefs: EmailPreferences = {}
  for (const key of PUBLIC_EMAIL_PREFERENCE_KEYS)
    prefs[key] = false
  prefs.cli_realtime_feed = false
  prefs.daily_fail_ratio = false
  return prefs
}

async function isEmailPreferencesRateLimited(c: Parameters<typeof getClientIP>[0]): Promise<boolean> {
  const ip = getClientIP(c)
  if (ip === 'unknown')
    return false

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(RATE_LIMIT_PATH, { ip })
  const data = await cacheHelper.matchJson<{ count: number }>(cacheKey)
  const count = (data?.count ?? 0) + 1
  await cacheHelper.putJson(cacheKey, { count }, RATE_LIMIT_TTL_SECONDS)
  return count > RATE_LIMIT_MAX
}

/**
 * Public email-footer preference save.
 * Always returns the same success payload whether or not the email belongs to a Capgo user.
 * Never loads or returns existing preferences (existence oracle safe).
 * Opt-out only: cannot re-enable prefs without an authenticated Capgo session.
 */
app.post('/', async (c) => {
  if (await isEmailPreferencesRateLimited(c))
    return simpleRateLimit({ reason: 'email_preferences_rate_limit' })

  const raw = await parseBody<Record<string, unknown>>(c)
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    // Validation errors are allowed — they do not reveal whether an account exists.
    return c.json({ error: 'invalid_payload', status: 'Error', message: 'Invalid email preferences payload' }, 400)
  }

  const email = normalizeEmail(parsed.data.email)
  const unsubscribeAll = parsed.data.unsubscribe_all === true
  const preferenceOptOuts = sanitizeOptOutPreferences(parsed.data.preferences)

  try {
    const admin = supabaseAdmin(c)
    const { data: user, error } = await admin
      .from('users')
      .select('id, email, enable_notifications, opt_for_newsletters, email_preferences')
      .ilike('email', escapeIlikeExact(email))
      .maybeSingle()

    if (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'email_preferences lookup failed',
        error: serializeError(error),
      })
    }
    else if (user) {
      const previous = {
        ...user,
        email_preferences: (user.email_preferences ?? {}) as EmailPreferences,
      }
      const nextPrefs: EmailPreferences = unsubscribeAll
        ? allPreferencesDisabled()
        : {
            ...previous.email_preferences,
            ...preferenceOptOuts,
          }

      const update = {
        email_preferences: nextPrefs,
        // Opt-out only for general flags too — never force them back on.
        enable_notifications: unsubscribeAll || parsed.data.enable_notifications === false
          ? false
          : previous.enable_notifications,
        opt_for_newsletters: unsubscribeAll || parsed.data.opt_for_newsletters === false
          ? false
          : previous.opt_for_newsletters,
      }

      const { data: updated, error: updateError } = await admin
        .from('users')
        .update(update)
        .eq('id', user.id)
        .select('id, email, enable_notifications, opt_for_newsletters, email_preferences')
        .maybeSingle()

      if (updateError) {
        cloudlogErr({
          requestId: c.get('requestId'),
          message: 'email_preferences update failed',
          error: serializeError(updateError),
        })
      }
      else {
        await syncUserPreferenceTags(c, email, updated ?? { ...user, ...update }, previous, email)
      }
    }

    if (unsubscribeAll) {
      // Always attempt Bento unsubscribe, even when Capgo user lookup failed.
      const unsubscribed = await unsubscribeBento(c, email)
      if (unsubscribed === false) {
        cloudlogErr({
          requestId: c.get('requestId'),
          message: 'email_preferences bento unsubscribe failed',
        })
      }
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'email_preferences_saved',
      unsubscribeAll,
      preferenceKeys: Object.keys(preferenceOptOuts),
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'email_preferences unexpected error',
      error: serializeError(error),
    })
  }

  return c.json(BRES)
})
