import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { deleteAppStatus } from '../../utils/appStatus.ts'
import { trackBentoEvent } from '../../utils/bento.ts'
import { createIfNotExistStoreInfo } from '../../utils/cloudflare.ts'
import { lockOnboardingApp, unlockOnboardingApp } from '../../utils/demo.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSignedImageUrl, normalizeImagePath } from '../../utils/storage.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
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
  ios_store_url?: string | null
  android_store_url?: string | null
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

  const canUpdateSettings = await checkPermission(c, 'app.update_settings', { appId })

  // Service-role load is only for the pending-onboarding completion path so keys
  // with org.create_app can finish apps they cannot yet read via RLS.
  const previousAppClient = canUpdateSettings || body.need_onboarding !== false
    ? supabaseApikey(c, apikey.key)
    : supabaseAdmin(c)
  const { data: previousApp, error: previousAppError } = await previousAppClient
    .from('apps')
    .select('need_onboarding, owner_org, name, app_id')
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

  if (!canUpdateSettings && !canCompleteOnboarding) {
    throw quickError(401, 'cannot_access_app', 'You can\'t access this app', { app_id: appId })
  }

  // Completing pending onboarding with only org.create_app must not allow arbitrary
  // settings changes. Restrict the writable fields in that case.
  if (canCompleteOnboarding) {
    const disallowedFields = [
      body.name,
      body.icon,
      body.retention,
      body.expose_metadata,
      body.allow_device_custom_id,
      body.existing_app,
      body.block_provider_infra_requests,
      body.ios_store_url,
      body.android_store_url,
    ].some(value => value !== undefined)
    if (disallowedFields) {
      throw quickError(401, 'cannot_access_app', 'You can\'t access this app', { app_id: appId })
    }
  }

  const normalizedIcon = normalizeImagePath(body.icon)
  const onboardingLock = shouldSerializeOnboardingCompletion
    ? await lockOnboardingApp(c, appId)
    : null

  let data: Record<string, any> | undefined
  let dbError: { message?: string } | null = null
  let completedPendingOnboarding = false

  try {
    if (!canUpdateSettings && canCompleteOnboarding) {
      // Bypass RLS for the narrow onboarding-completion path after explicit authz.
      // Reuse the advisory-lock session so the update is serialized with the lock.
      const pgClient = onboardingLock ?? getPgClient(c)
      try {
        const result = await pgClient.query(
          `UPDATE public.apps
           SET need_onboarding = false
           WHERE app_id = $1
             AND need_onboarding = true
           RETURNING *`,
          [appId],
        )
        data = result.rows[0]
        if (data) {
          completedPendingOnboarding = true
        }
        else {
          // Already completed under the lock; return current row without re-firing side effects.
          const current = await pgClient.query(
            `SELECT * FROM public.apps WHERE app_id = $1`,
            [appId],
          )
          data = current.rows[0]
          if (!data)
            dbError = { message: 'App not found during onboarding completion' }
        }
      }
      catch (error) {
        dbError = { message: (error as Error)?.message }
      }
      finally {
        // Only close a client we opened here; unlockOnboardingApp owns the lock session.
        if (!onboardingLock)
          await closeClient(c, pgClient)
      }
    }
    else {
      const updateResult = await supabaseApikey(c, apikey.key)
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
    const signedIcon = await createSignedImageUrl(c, data.icon_url)
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
      await trackBentoEvent(c, orgData.management_email, {
        org_id: data.owner_org,
        org_name: orgData.name,
        app_name: data.name,
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
