import type { Context } from 'hono'
import type { PoolClient } from 'pg'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { sql } from 'drizzle-orm'
import { buildAppCreatorEventDetails } from '../../utils/app_creator.ts'
import { appendAppOnboardingStepHistory, parseAppOnboardingPatch } from '../../utils/appOnboarding.ts'
import { deleteAppStatus } from '../../utils/appStatus.ts'
import { trackBentoEvent } from '../../utils/bento.ts'
import { createIfNotExistStoreInfo } from '../../utils/cloudflare.ts'
import { lockOnboardingApp, unlockOnboardingApp } from '../../utils/demo.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSignedImageUrl, getStorageAllowedOrigins, resolveWritableImageValue } from '../../utils/storage.ts'
import { supabaseAdmin, supabaseApikey, supabaseWithAuth } from '../../utils/supabase.ts'
import { normalizeAppStatsMode } from '../../plugin_runtime/utils/stats_mode.ts'
import { isValidAppId } from '../../utils/utils.ts'

interface UpdateApp {
  name?: string
  icon?: string
  retention?: number
  expose_metadata?: boolean
  allow_device_custom_id?: boolean
  need_onboarding?: boolean
  existing_app?: boolean
  block_provider_infra_requests?: boolean
  stats_mode?: string
  ios_store_url?: string | null
  android_store_url?: string | null
  onboarding?: unknown
}

async function persistAppOnboarding(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  patch: NonNullable<ReturnType<typeof parseAppOnboardingPatch>> | undefined,
  transactionClient?: PoolClient,
  completePendingOnboarding = false,
) {
  const pool = transactionClient ? null : getPgClient(c)
  try {
    const drizzle = getDrizzleClient(transactionClient ?? pool!)
    return await drizzle.transaction(async (tx) => {
      let app: Database['public']['Tables']['apps']['Row'] | undefined
      let completed = false
      if (completePendingOnboarding) {
        const completionResult = await tx.execute<Database['public']['Tables']['apps']['Row']>(sql`
          UPDATE public.apps
          SET need_onboarding = false
          WHERE app_id = ${appId}
            AND need_onboarding = true
          RETURNING *
        `)
        app = completionResult.rows[0] as Database['public']['Tables']['apps']['Row'] | undefined
        completed = !!app
      }

      if (!patch) {
        const current = app
          ? null
          : await tx.execute<Database['public']['Tables']['apps']['Row']>(sql`
              SELECT * FROM public.apps WHERE app_id = ${appId}
            `)
        app ??= current?.rows[0] as Database['public']['Tables']['apps']['Row'] | undefined
        return app ? { app, completed } : undefined
      }

      const currentResult = await tx.execute<{ onboarding: unknown }>(sql`
        SELECT onboarding
        FROM public.apps
        WHERE app_id = ${appId}
        FOR UPDATE
      `)
      const currentOnboarding = currentResult.rows[0]?.onboarding
      if (!currentResult.rows[0])
        return undefined

      const mergeResult = await tx.execute<{ onboarding: unknown }>(sql`
        SELECT public.merge_app_onboarding_setup(
          ${JSON.stringify(currentOnboarding)}::jsonb,
          ${JSON.stringify(patch)}::jsonb
        ) AS onboarding
      `)
      if (!mergeResult.rows[0])
        throw new Error('Cannot merge app onboarding progress')
      const onboarding = appendAppOnboardingStepHistory(currentOnboarding, mergeResult.rows[0]?.onboarding, patch)
      const result = await tx.execute<Database['public']['Tables']['apps']['Row']>(sql`
        UPDATE public.apps
        SET onboarding = ${JSON.stringify(onboarding)}::jsonb,
            updated_at = now()
        WHERE app_id = ${appId}
        RETURNING *
      `)
      const row = result.rows[0] as Database['public']['Tables']['apps']['Row'] | undefined
      if (!row)
        throw new Error('App disappeared during onboarding progress update')
      const completeResult = await tx.execute<{ completed: boolean }>(sql`
        SELECT public.try_complete_pending_onboarding_if_setup_done(${appId}) AS completed
      `)
      completed ||= completeResult.rows[0]?.completed === true
      const refreshed = await tx.execute<Database['public']['Tables']['apps']['Row']>(sql`
        SELECT * FROM public.apps WHERE app_id = ${appId}
      `)
      return {
        app: (refreshed.rows[0] ?? row) as Database['public']['Tables']['apps']['Row'],
        completed,
      }
    })
  }
  finally {
    if (pool)
      await closeClient(c, pool)
  }
}

export async function put(c: Context<MiddlewareKeyVariables>, appId: string, body: UpdateApp, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!appId) {
    throw quickError(400, 'missing_app_id', 'Missing app_id')
  }
  if (!isValidAppId(appId)) {
    throw quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })
  }

  if (body.retention && body.retention >= 63113904) {
    throw quickError(400, 'retention_to_big', 'Retention cannot be bigger than 63113903 (2 years)', { retention: body.retention })
  }
  else if (body.retention && body.retention < 0) {
    throw quickError(400, 'retention_to_small', 'Retention cannot be smaller than 0', { retention: body.retention })
  }

  if (body.stats_mode !== undefined) {
    const normalizedStatsMode = normalizeAppStatsMode(body.stats_mode)
    if (body.stats_mode !== normalizedStatsMode) {
      throw quickError(400, 'invalid_stats_mode', 'stats_mode must be all, updatesOnly, or billingOnly', { stats_mode: body.stats_mode })
    }
    body.stats_mode = normalizedStatsMode
  }

  const onboardingPatch = parseAppOnboardingPatch(body.onboarding)
  const canUpdateSettings = await checkPermission(c, 'app.update_settings', { appId })
  const auth = c.get('auth')
  const callerClient = auth ? supabaseWithAuth(c, auth) : supabaseApikey(c, apikey.key)

  // Service-role load is used when the key cannot update settings: pending
  // onboarding completion, or a valid onboarding progress patch. Authorization
  // still runs after this read and blocks unauthorized callers.
  const previousAppClient = canUpdateSettings || (body.need_onboarding !== false && !onboardingPatch)
    ? callerClient
    : supabaseAdmin(c)
  const { data: previousApp, error: previousAppError } = await previousAppClient
    .from('apps')
    .select('need_onboarding, owner_org, name, app_id, onboarding')
    .eq('app_id', appId)
    .single()

  if (previousAppError || !previousApp) {
    if (!canUpdateSettings) {
      throw quickError(401, 'cannot_access_app', 'You can\'t access this app', { app_id: appId })
    }
    throw simpleError('cannot_load_app', 'Cannot load app before update', { supabaseError: previousAppError })
  }

  const shouldSerializeOnboardingCompletion = previousApp.need_onboarding === true && body.need_onboarding === false
  const canCompleteOnboarding = !canUpdateSettings
    && shouldSerializeOnboardingCompletion
    && await checkPermission(c, 'org.create_app', { orgId: previousApp.owner_org })
  const canReportOnboarding = !!onboardingPatch
    && (canUpdateSettings || await checkPermission(c, 'org.create_app', { orgId: previousApp.owner_org }))

  if (!canUpdateSettings && !canCompleteOnboarding && !canReportOnboarding) {
    throw quickError(401, 'cannot_access_app', 'You can\'t access this app', { app_id: appId })
  }

  // Completing pending onboarding with only org.create_app must not allow arbitrary
  // settings changes. Restrict the writable fields in that case.
  // Single source of truth for settings fields. `need_onboarding` is writable on the
  // onboarding-completion path, so it is tracked separately.
  const extraSettingsValues = [
    body.name,
    body.icon,
    body.retention,
    body.expose_metadata,
    body.allow_device_custom_id,
    body.existing_app,
    body.block_provider_infra_requests,
    body.stats_mode,
    body.ios_store_url,
    body.android_store_url,
  ]
  if (!canUpdateSettings && (canCompleteOnboarding || canReportOnboarding)) {
    const disallowedFields = extraSettingsValues.some(value => value !== undefined)
    if (disallowedFields) {
      throw quickError(401, 'cannot_access_app', 'You can\'t access this app', { app_id: appId })
    }
  }

  let normalizedIcon: string | undefined
  if (body.icon === undefined) {
    normalizedIcon = undefined
  }
  else if (body.icon === '') {
    normalizedIcon = ''
  }
  else {
    normalizedIcon = resolveWritableImageValue(
      body.icon,
      { orgId: previousApp.owner_org, appId },
      getStorageAllowedOrigins(c),
    ) ?? undefined
  }
  if (body.icon !== undefined && body.icon !== '' && !normalizedIcon)
    throw simpleError('invalid_icon_path', 'Icon path must belong to this app organization')
  const onboardingLock = shouldSerializeOnboardingCompletion
    ? await lockOnboardingApp(c, appId)
    : null

  const hasSettingsPayload = [
    ...extraSettingsValues,
    body.need_onboarding,
  ].some(value => value !== undefined)

  let data: Database['public']['Tables']['apps']['Row'] | undefined
  let dbError: { message?: string } | null = null
  let completedPendingOnboarding = false

  try {
    if (!canUpdateSettings && canCompleteOnboarding) {
      // Bypass RLS for the narrow onboarding-completion path after explicit authz.
      // Reuse the advisory-lock session and one transaction for completion and history.
      try {
        if (!onboardingLock)
          throw new Error('Missing onboarding completion lock')
        const persisted = await persistAppOnboarding(c, appId, onboardingPatch ?? undefined, onboardingLock.client, true)
        data = persisted?.app
        completedPendingOnboarding = persisted?.completed ?? false
        if (!data)
          dbError = { message: 'App not found during onboarding completion' }
      }
      catch (error) {
        dbError = { message: (error as Error)?.message }
      }
    }
    else if (onboardingPatch && !hasSettingsPayload) {
      try {
        const persisted = await persistAppOnboarding(c, appId, onboardingPatch)
        if (!persisted) {
          dbError = { message: 'App not found during onboarding progress update' }
        }
        else {
          data = persisted.app
          completedPendingOnboarding = persisted.completed
        }
      }
      catch (error) {
        dbError = { message: (error as Error)?.message }
      }
    }
    else {
      const updateResult = await callerClient
        .from('apps')
        .update({
          name: body.name,
          icon_url: normalizedIcon ?? body.icon,
          retention: body.retention,
          expose_metadata: body.expose_metadata,
          allow_device_custom_id: body.allow_device_custom_id,
          need_onboarding: body.need_onboarding,
          existing_app: body.existing_app,
          block_provider_infra_requests: body.block_provider_infra_requests,
          stats_mode: body.stats_mode,
          ios_store_url: body.ios_store_url,
          android_store_url: body.android_store_url,
        })
        .eq('app_id', appId)
        .select()
        .single()
      data = updateResult.data ?? undefined
      dbError = updateResult.error
      if (data)
        completedPendingOnboarding = previousApp.need_onboarding === true && data.need_onboarding === false
      if (data && onboardingPatch) {
        const persisted = await persistAppOnboarding(c, appId, onboardingPatch)
        if (persisted) {
          data = persisted.app
          completedPendingOnboarding = completedPendingOnboarding || persisted.completed
        }
      }
    }
  }
  finally {
    if (onboardingLock) {
      await unlockOnboardingApp(c, onboardingLock, appId)
    }
  }

  if (dbError || !data) {
    throw simpleError('cannot_update_app', 'Cannot update app', { supabaseError: dbError })
  }
  try {
    await deleteAppStatus(c, appId)
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'Failed to delete app status cache after app update', error, app_id: appId })
  }

  if (data.icon_url) {
    const signedIcon = await createSignedImageUrl(c, data.icon_url, {
      orgId: data.owner_org,
      appId: data.app_id,
    })
    data.icon_url = signedIcon ?? ''
  }

  if (completedPendingOnboarding) {
    const { data: orgData, error: orgError } = await supabaseAdmin(c)
      .from('orgs')
      .select('management_email, name')
      .eq('id', data.owner_org)
      .single()

    if (orgError || !orgData) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot load organization for onboarding completion side effects', error: orgError, app_id: appId })
    }
    else {
      const creatorDetails = buildAppCreatorEventDetails(data.onboarding)
      await trackBentoEvent(c, orgData.management_email, {
        org_id: data.owner_org,
        org_name: orgData.name,
        app_name: data.name,
        ...creatorDetails,
      }, 'app:created')
    }

    await createIfNotExistStoreInfo(c, {
      app_id: data.app_id,
      updates: 1,
      onprem: true,
      capacitor: true,
      capgo: true,
    })
  }

  return c.json(data)
}
