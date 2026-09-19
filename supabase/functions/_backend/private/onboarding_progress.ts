import type { Context } from 'hono'
import type { AppOnboardingPatch } from '../utils/appOnboarding.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Permission } from '../utils/rbac.ts'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { buildAppOnboardingStepPosthogEvent } from '../utils/app_onboarding_posthog.ts'
import { appendAppOnboardingStepHistory, applyAppOnboardingPatch, getAppOnboardingStepHistoryChanges, parseAppOnboarding, pickAppOnboardingSource } from '../utils/appOnboarding.ts'
import { lockAppOnboardingForWrite, retryAppOnboardingWrite } from '../utils/appOnboardingWriteLock.ts'
import { parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { trackPosthogEvent } from '../utils/posthog.ts'
import { appIdSchema } from '../utils/privateAnalyticsValidation.ts'
import { checkPermission, checkPermissionPg } from '../utils/rbac.ts'
import { readDevices, readStats } from '../utils/stats.ts'
import { supabaseWithAuth } from '../utils/supabase.ts'
import { backgroundTask } from '../utils/utils.ts'

const bodySchema = z.object({ appId: appIdSchema, N: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), initial: z.boolean().optional() })
type Observations = Partial<Record<'login_cli_mcp' | 'add_channel' | 'run_device' | 'upload_bundle' | 'test_update', boolean>>
type AuthenticatedClient = ReturnType<typeof supabaseWithAuth>

async function hasPublishedBundle(client: AuthenticatedClient, appId: string) {
  // A version/r2_path can exist before its upload. Require final manifest,
  // a registered external bundle, or positive archive metadata instead.
  const delta = await client.from('app_versions').select('id').eq('app_id', appId).eq('deleted', false).not('name', 'in', '(builtin,unknown)').neq('storage_provider', 'revert_to_builtin').or('manifest_count.gt.0,external_url.neq.').limit(1)
  if (delta.error)
    throw delta.error
  if (delta.data?.length)
    return true
  const archive = await client.from('app_versions').select('id,app_versions_meta!inner(size)').eq('app_id', appId).eq('deleted', false).not('name', 'in', '(builtin,unknown)').neq('storage_provider', 'revert_to_builtin').gt('app_versions_meta.size', 0).limit(1)
  if (archive.error)
    throw archive.error
  return !!archive.data?.length
}

async function hasAppliedBundle(c: Context<MiddlewareKeyVariables>, client: AuthenticatedClient, appId: string, createdAt: string | null) {
  const logs = await readStats(c, { app_id: appId, actions: ['set'], start_date: createdAt ?? undefined, limit: 10 }, false)
  const names = [...new Set(logs.filter(log => log.action === 'set' && log.device_id && log.version_name && !['builtin', 'unknown'].includes(log.version_name)).map(log => log.version_name!))]
  if (!names.length)
    return false
  const versions = await client.from('app_versions').select('id').eq('app_id', appId).in('name', names).neq('storage_provider', 'revert_to_builtin').limit(1)
  if (versions.error)
    throw versions.error
  return !!versions.data?.length
}

// Evidence is gathered outside the lock; merge only the observed milestones into
// the current row, so a concurrent CLI report cannot be overwritten.
export async function persistObservedProgress(c: Context<MiddlewareKeyVariables>, appId: string, observations: Observations) {
  const auth = c.get('auth')!
  const pool = getPgClient(c)
  try {
    const result = await retryAppOnboardingWrite(getDrizzleClient(pool, { logger: false }), async (tx) => {
      const row = await lockAppOnboardingForWrite(tx, appId)
      if (!row || parseAppOnboarding(row.onboarding).todo_list_version !== 3)
        return null
      const key = auth.apikey?.key ?? c.get('capgkey') ?? null
      const isApiKeyCreator = observations.login_cli_mcp === true
        && auth.authType === 'apikey'
        && (row.onboarding as { created_by_user_id?: unknown } | null)?.created_by_user_id === auth.userId
      const canMarkCliStart = isApiKeyCreator
        && await checkPermissionPg(c, 'app.read', { appId }, tx, auth.userId, key)
      const hasOtherObservations = Object.keys(observations).some(id => id !== 'login_cli_mcp')
      const canWriteObservations = hasOtherObservations
        && ((await checkPermissionPg(c, 'app.update_settings', { appId }, tx, auth.userId, key))
          || (await checkPermissionPg(c, 'org.create_app', { orgId: row.owner_org }, tx, auth.userId, key)))
      if (!canMarkCliStart && !canWriteObservations) {
        return null
      }
      const current = parseAppOnboarding(row.onboarding)
      if (current.outcome === 'skipped')
        return null
      const at = new Date().toISOString()
      const patch: AppOnboardingPatch = { steps: {}, ...(canMarkCliStart ? { source: 'cli' } : {}) }
      for (const [id, present] of Object.entries(observations) as Array<[keyof Observations, boolean]>) {
        if (id === 'login_cli_mcp' ? !canMarkCliStart : !canWriteObservations)
          continue
        if (present && current.steps[id]?.status !== 'done')
          patch.steps![id] = { status: 'done', at }
      }
      const removeChannel = canWriteObservations && observations.add_channel === false && !!current.steps.add_channel
      const sourceChanged = canMarkCliStart && pickAppOnboardingSource(current.source, 'cli') !== current.source
      if (!removeChannel && Object.keys(patch.steps!).length === 0 && !sourceChanged)
        return null
      const base = applyAppOnboardingPatch(row.onboarding, {}, () => at)
      const setup = base.setup as Record<string, unknown>
      const steps = setup.steps as Record<string, unknown>
      if (removeChannel)
        delete steps.add_channel
      const merged = applyAppOnboardingPatch(base, patch, () => at)
      const onboarding = appendAppOnboardingStepHistory(row.onboarding, merged, patch, () => at)
      const historyChanges = getAppOnboardingStepHistoryChanges(row.onboarding, onboarding, patch)
      await tx.execute(sql`UPDATE public.apps SET onboarding = ${JSON.stringify(onboarding)}::jsonb, updated_at = now() WHERE app_id = ${appId}`)
      await tx.execute(sql`SELECT public.try_complete_pending_onboarding_if_setup_done(${appId})`)
      return { onboarding, historyChanges, orgId: row.owner_org }
    })
    if (result?.historyChanges.length) {
      await backgroundTask(c, Promise.all(result.historyChanges.map(change => trackPosthogEvent(c, buildAppOnboardingStepPosthogEvent({
        appId,
        auth,
        change,
        orgId: result.orgId,
        setup: parseAppOnboarding(result.onboarding),
      })))))
    }
    return result?.onboarding
  }
  finally {
    await closeClient(c, pool)
  }
}

export const app = new Hono<MiddlewareKeyVariables>()
app.use('*', useCors)
app.post('/', middlewareAuth({ preferApiKey: true }), async (c) => {
  const parsed = bodySchema.safeParse(await parseBody(c))
  if (!parsed.success)
    throw quickError(400, 'invalid_body', 'Invalid body')
  const { appId, N, initial } = parsed.data
  if (!(await checkPermission(c, 'app.read', { appId })))
    throw quickError(403, 'app_access_denied', 'You cannot access this app')
  const client = supabaseWithAuth(c, c.get('auth')!)
  // Always load this exact app, on every N, even when no extra check is due.
  const { data: row, error } = await client.from('apps').select('onboarding, created_at').eq('app_id', appId).single()
  if (error || !row)
    throw quickError(404, 'app_not_found', 'App not found')
  const current = parseAppOnboarding(row.onboarding)
  const observations: Observations = {}
  const checkErrors: string[] = []
  if (current.todo_list_version === 3 && c.get('auth')?.authType === 'apikey')
    observations.login_cli_mcp = true
  const due = (slot: number) => initial || N % 5 === slot
  async function check(id: keyof Observations, permission: Permission, action: () => Promise<boolean>) {
    try {
      if (!(await checkPermission(c, permission, { appId })))
        return
      observations[id] = await action()
    }
    catch (error) {
      checkErrors.push(id)
      cloudlogErr({ requestId: c.get('requestId'), message: 'onboarding progress check failed', app_id: appId, step: id, error: serializeError(error) })
    }
  }
  if (due(0)) {
    await check('add_channel', 'app.read', async () => {
      const result = await client.from('channels').select('id').eq('app_id', appId).limit(1)
      if (result.error)
        throw result.error
      return !!result.data?.length
    })
  }
  const observeMilestones = current.todo_list_version === 3 && current.outcome !== 'skipped'
  if (observeMilestones && due(1) && current.steps.run_device?.status !== 'done') {
    await check('run_device', 'app.read_devices', async () => {
      return (await readDevices(c, { app_id: appId, limit: 1 }, false)).data.some(device => !!device.device_id)
    })
  }
  if (observeMilestones && due(2) && current.steps.upload_bundle?.status !== 'done')
    await check('upload_bundle', 'app.read', () => hasPublishedBundle(client, appId))
  if (observeMilestones && due(3) && current.steps.test_update?.status !== 'done')
    await check('test_update', 'app.read_logs', () => hasAppliedBundle(c, client, appId, row.created_at))
  const onboarding = current.todo_list_version === 3 && Object.keys(observations).length
    ? await persistObservedProgress(c, appId, observations) ?? row.onboarding
    : row.onboarding
  c.header('Cache-Control', 'no-store')
  return c.json({ onboarding, ...(observations.add_channel !== undefined ? { hasChannel: observations.add_channel } : {}), checkErrors })
})
