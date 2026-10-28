import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { PgQueryClient } from '../../utils/pg.ts'
import { z } from 'zod'
import { getBodyOrQuery, honoFactory, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { checkoutPgClient, closeClient, getPgClient, releasePgClient } from '../../utils/pg.ts'
import { queryJsonOne } from '../../utils/pg_rls.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { emailPreferencesPatchSchema, USER_SETTINGS_EMAIL_PREFERENCE_KEYS } from '../../utils/settings_email_preferences.ts'
import { createSignedImageUrl } from '../../utils/storage.ts'

/**
 * Account settings of the caller (Settings > Account).
 *
 * Email, password, two-factor authentication and account deletion are intentionally not exposed:
 * they require an interactive, re-authenticated session, and an API key must never be able to take
 * over or delete the account that owns it.
 */
const PROFILE_COLUMNS = 'id, email, first_name, last_name, country, discord_username, format_locale, enable_notifications, opt_for_newsletters, email_preferences, image_url, created_at'

const updateBodySchema = z.object({
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().min(1).max(100).optional(),
  country: z.string().trim().max(100).nullable().optional(),
  discord_username: z.string().trim().max(100).nullable().optional(),
  format_locale: z.string().trim().max(35).nullable().optional(),
  enable_notifications: z.boolean().optional(),
  opt_for_newsletters: z.boolean().optional(),
  email_preferences: emailPreferencesPatchSchema(USER_SETTINGS_EMAIL_PREFERENCE_KEYS).optional(),
}).strict()

type ProfileRow = Record<string, unknown> & { id: string, image_url: string | null }

// Column names come from this fixed list only, never from the request.
const UPDATABLE_COLUMNS = ['first_name', 'last_name', 'country', 'discord_username', 'format_locale', 'enable_notifications', 'opt_for_newsletters'] as const

function getCallerId(c: Context<MiddlewareKeyVariables>) {
  const userId = c.get('auth')?.userId
  if (!userId)
    throw quickError(401, 'not_authorized', 'Not authorized')
  return userId
}

async function loadProfile(c: Context<MiddlewareKeyVariables>, userId: string) {
  const pgPool = await getPgClient(c)
  let data: ProfileRow | null = null
  let error: unknown = null
  try {
    data = await queryJsonOne<ProfileRow>(pgPool, `SELECT ${PROFILE_COLUMNS} FROM public.users WHERE id = $1`, [userId])
  }
  catch (lookupError) {
    error = lookupError
  }
  finally {
    closeClient(c, pgPool)
  }
  if (error || !data)
    throw quickError(404, 'user_not_found', 'User not found', { error })
  return data
}

async function withSignedImage(c: Context<MiddlewareKeyVariables>, profile: ProfileRow) {
  return { ...profile, image_url: await createSignedImageUrl(c, profile.image_url, { userId: profile.id }) ?? '' }
}

export const app = honoFactory.createApp()

app.use('*', useCors)

app.get('/', middlewareAuth({ preferApiKey: true }), async (c) => {
  const userId = getCallerId(c)
  return c.json(await withSignedImage(c, await loadProfile(c, userId)))
})

app.put('/', middlewareAuth({ preferApiKey: true }), async (c) => {
  const userId = getCallerId(c)
  const parsed = safeParseSchema(updateBodySchema, await getBodyOrQuery<unknown>(c))
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  const { email_preferences: emailPreferencesPatch, ...fields } = parsed.data

  const params: unknown[] = []
  const assignments: string[] = []
  for (const column of UPDATABLE_COLUMNS) {
    if (fields[column] === undefined)
      continue
    params.push(fields[column])
    assignments.push(`${column} = $${params.length}`)
  }
  if (emailPreferencesPatch) {
    // Merge in SQL so concurrent patches of different keys cannot overwrite each other.
    params.push(JSON.stringify(emailPreferencesPatch))
    assignments.push(`email_preferences = COALESCE(email_preferences, '{}'::jsonb) || $${params.length}::jsonb`)
  }
  if (assignments.length === 0)
    throw simpleError('invalid_body', 'Nothing to update')
  params.push(userId)

  // Service role write strictly pinned to the authenticated caller's own row.
  const pgPool = await getPgClient(c)
  let client: PgQueryClient | null = null
  let data: ProfileRow | undefined
  try {
    client = await checkoutPgClient(pgPool)
    const result = await client.query<ProfileRow>(
      `UPDATE public.users SET ${assignments.join(', ')} WHERE id = $${params.length}::uuid RETURNING ${PROFILE_COLUMNS}`,
      params,
    )
    data = result.rows[0]
  }
  catch (error) {
    throw simpleError('cannot_update_user', 'Cannot update user', { error: error instanceof Error ? error.message : String(error) })
  }
  finally {
    releasePgClient(pgPool, client)
    await closeClient(c, pgPool)
  }
  if (!data)
    throw quickError(404, 'user_not_found', 'User not found')
  return c.json(await withSignedImage(c, data))
})
