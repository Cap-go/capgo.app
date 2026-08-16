import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { applyAppOnboardingPatch, isAppOnboardingSource } from '../../utils/appOnboarding.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient, logPgError } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSignedImageUrl, getStorageAllowedOrigins, resolveWritableImageValue } from '../../utils/storage.ts'
import { isValidAppId } from '../../utils/utils.ts'

export interface CreateApp {
  app_id: string
  name: string
  owner_org: string
  icon?: string
  need_onboarding?: boolean
  created_from_onboarding?: boolean
  existing_app?: boolean
  ios_store_url?: string
  android_store_url?: string
  onboarding?: {
    source?: string
  }
}

export async function post(c: Context<MiddlewareKeyVariables>, body: CreateApp): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  if (!body.name) {
    throw simpleError('missing_name', 'Missing name', { body })
  }
  if (!body.owner_org) {
    throw quickError(400, 'missing_owner_org', 'Missing owner_org', { body })
  }

  // Check if the user is allowed to create an app in this organization (auth context set by middlewareKey)
  if (!(await checkPermission(c, 'org.create_app', { orgId: body.owner_org }))) {
    throw quickError(403, 'cannot_access_organization', 'You can\'t access this organization', { org_id: body.owner_org })
  }

  let normalizedIcon: string | null = null
  if (body.icon) {
    normalizedIcon = resolveWritableImageValue(
      body.icon,
      { orgId: body.owner_org, appId: body.app_id },
      getStorageAllowedOrigins(c),
    )
  }
  if (body.icon && !normalizedIcon)
    throw simpleError('invalid_icon_path', 'Icon path must belong to this app organization')
  const dataInsert = {
    owner_org: body.owner_org,
    app_id: body.app_id,
    icon_url: normalizedIcon ?? '',
    name: body.name,
    retention: 2592000,
    default_upload_channel: 'dev',
    need_onboarding: body.need_onboarding ?? false,
    // Keep CLI init metrics independent from pending web-onboarding apps.
    created_from_onboarding: body.created_from_onboarding ?? body.need_onboarding ?? false,
    existing_app: body.existing_app ?? false,
    ios_store_url: body.ios_store_url ?? null,
    android_store_url: body.android_store_url ?? null,
    onboarding: applyAppOnboardingPatch({}, {
      source: isAppOnboardingSource(body.onboarding?.source) ? body.onboarding.source : 'manual',
    }),
  }
  let pgClient
  let data: Database['public']['Tables']['apps']['Row'] | undefined
  try {
    pgClient = getPgClient(c)
    const result = await pgClient.query(
      `INSERT INTO public.apps (
         owner_org,
         app_id,
         icon_url,
         name,
         retention,
         default_upload_channel,
         need_onboarding,
         created_from_onboarding,
         existing_app,
         ios_store_url,
         android_store_url,
         onboarding
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING *`,
      [
        dataInsert.owner_org,
        dataInsert.app_id,
        dataInsert.icon_url,
        dataInsert.name,
        dataInsert.retention,
        dataInsert.default_upload_channel,
        dataInsert.need_onboarding,
        dataInsert.created_from_onboarding,
        dataInsert.existing_app,
        dataInsert.ios_store_url,
        dataInsert.android_store_url,
        JSON.stringify(dataInsert.onboarding),
      ],
    )
    data = result.rows[0]
  }
  catch (error) {
    const pgError = error as { code?: string, constraint?: string, detail?: string, message?: string }
    logPgError(c, 'create_app', error)
    if (pgError.code === '23505') {
      // Intentionally expose duplicate app_id conflicts for this user-facing path.
      // The onboarding UI uses the 409 to suggest alternatives immediately, and
      // the oracle risk is acceptable here because app IDs are public identifiers
      // and the caller already needs organization write access to reach this code.
      throw quickError(409, 'app_id_already_exists', 'App ID already exists', {
        app_id: body.app_id,
        constraint: pgError.constraint,
        detail: pgError.detail,
      })
    }
    throw simpleError('cannot_create_app', 'Cannot create app', { error: (error as Error)?.message })
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }

  if (!data) {
    throw simpleError('cannot_read_app', 'Cannot read created app')
  }

  if (data.icon_url) {
    const signedIcon = await createSignedImageUrl(c, data.icon_url, {
      orgId: data.owner_org,
      appId: data.app_id,
    })
    data.icon_url = signedIcon ?? ''
  }

  return c.json(data)
}
