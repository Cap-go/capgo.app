import type { Context } from 'hono'
import type { AppOnboardingPatch, AppOnboardingState, AppOnboardingStepId } from '../utils/appOnboarding.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { RlsPrincipal } from '../utils/pg_rls.ts'
import type { Permission } from '../utils/rbac.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { emitCommittedAppOnboardingHistory } from '../utils/app_onboarding_posthog.ts'
import { getAppOnboardingStepIds, hasSupportedOtaTodoList, inferredAddCodeStep, parseAppOnboarding, pickAppOnboardingSource, shouldInferAddCode } from '../utils/appOnboarding.ts'
import { tryCompletePendingAppOnboarding } from '../utils/appOnboardingCompletion.ts'
import { persistAuthorizedOnboardingMutation } from '../utils/appOnboardingMutation.ts'
import { parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlogErr, serializeError } from '../utils/logging.ts'
import { isActiveBuilderChecklistSetup } from '../utils/builder_onboarding_checklist.ts'
import { BUILDER_STEP_IDS, isOpenOnboardingStepStatus } from '../utils/onboardingMissedSteps.ts'
import { appIdSchema } from '../utils/privateAnalyticsValidation.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { authPrincipal, queryJson, queryJsonOne, withRlsContext, withRlsTransaction } from '../utils/pg_rls.ts'
import { checkPermission } from '../utils/rbac.ts'
import { readDevices, readStats } from '../utils/stats.ts'

const bodySchema = z.object({ appId: appIdSchema, N: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), initial: z.boolean().optional(), includeBilling: z.boolean().optional() })
const skipStepBodySchema = z.object({
  appId: appIdSchema,
  step: z.string().regex(/^(?:ota\.[a-z_]+|builder\.(?:ios|android)\.[a-z_]+)$/),
  // Asked on every explicit skip so the team can review why steps get skipped.
  reason: z.string().trim().min(3).max(500),
})
type Observations = Partial<Record<'login_cli_mcp' | 'add_channel' | 'run_device' | 'upload_bundle' | 'test_update', boolean>>
// Runs one statement as the caller, like a supabase-js call made with supabaseWithAuth.
interface CallerDb { pg: PgClient, principal: RlsPrincipal }
type BillingSummary = { status: 'available', orgId: string, orgCreatedAt: string | null, trialEndsAt: string | null, hasPaid: boolean, isPaying: boolean, hasCredits: boolean } | { status: 'unavailable' }

async function readBilling(c: Context<MiddlewareKeyVariables>, principal: RlsPrincipal, orgId: string): Promise<BillingSummary> {
  try {
    if (!(await checkPermission(c, 'org.read_billing', { orgId })))
      return { status: 'unavailable' }
    // Use the caller's RLS context and the existing org/customer foreign key.
    // No Stripe call or credit-ledger aggregation is needed for CLI notices.
    // Own connection: this runs concurrently with the progress checks.
    const data = await withRlsContext(c, principal, client => queryJsonOne<{ created_at: string | null, has_usage_credits: boolean | null, stripe_info: { status: string | null, trial_at: string | null, paid_at: string | null } | null }>(
      client,
      `SELECT o.created_at, o.has_usage_credits,
        (SELECT pg_catalog.to_json(s) FROM (SELECT si.status, si.trial_at, si.paid_at FROM public.stripe_info si WHERE si.customer_id = o.customer_id) s) AS stripe_info
      FROM public.orgs o WHERE o.id = $1`,
      [orgId],
    ))
    if (!data?.stripe_info)
      return { status: 'unavailable' }
    return {
      status: 'available',
      orgId,
      // Lets the CLI detect zero-length (direct-offer) trials: trialEndsAt ~= orgCreatedAt.
      orgCreatedAt: data.created_at,
      trialEndsAt: data.stripe_info.trial_at,
      // Ever paid (stripe_info.paid_at set): a churned org is not a never-paid direct-offer org.
      hasPaid: !!data.stripe_info.paid_at,
      // Match is_paying_org and has_usage_credits_org without extra RPCs.
      isPaying: data.stripe_info.status === 'succeeded',
      hasCredits: data.has_usage_credits ?? false,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'onboarding billing check failed', error: serializeError(error) })
    return { status: 'unavailable' }
  }
}

async function hasRow(db: CallerDb, text: string, values: unknown[]) {
  return withRlsTransaction(db.pg, db.principal, async client => (await client.query(text, values)).rows.length > 0)
}

async function hasPublishedBundle(db: CallerDb, appId: string) {
  // A version/r2_path can exist before its upload. Require final manifest,
  // a registered external bundle, or positive archive metadata instead.
  const published = `SELECT v.id FROM public.app_versions v
    WHERE v.app_id = $1 AND v.deleted = false AND NOT (v.name IN ('builtin', 'unknown')) AND v.storage_provider <> 'revert_to_builtin'`
  if (await hasRow(db, `${published} AND (v.manifest_count > 0 OR v.external_url <> '') LIMIT 1`, [appId]))
    return true
  return hasRow(db, `${published} AND EXISTS (SELECT 1 FROM public.app_versions_meta m WHERE m.id = v.id AND m.size > 0) LIMIT 1`, [appId])
}

async function hasAppliedBundle(c: Context<MiddlewareKeyVariables>, db: CallerDb, appId: string, createdAt: string | null) {
  const logs = await readStats(c, { app_id: appId, actions: ['set'], start_date: createdAt ?? undefined, limit: 10 }, false)
  const names = [...new Set(logs.filter(log => log.action === 'set' && log.device_id && log.version_name && !['builtin', 'unknown'].includes(log.version_name)).map(log => log.version_name!))]
  if (!names.length)
    return false
  return hasRow(db, `SELECT id FROM public.app_versions WHERE app_id = $1 AND name = ANY($2::text[]) AND storage_provider <> 'revert_to_builtin' LIMIT 1`, [appId, names])
}

// Evidence is gathered outside the lock; merge only the observed milestones into
// the current row, so a concurrent CLI report cannot be overwritten.
function observedProgressPatch(current: AppOnboardingState, observations: Observations, allowedSteps: ReadonlySet<string>, at?: string): AppOnboardingPatch | null {
  if (!hasSupportedOtaTodoList(current) || current.outcome === 'skipped')
    return null
  const canMarkCliStart = observations.login_cli_mcp === true && allowedSteps.has('ota.login_cli_mcp')
  const patch: AppOnboardingPatch = { steps: {}, ...(canMarkCliStart ? { source: 'cli' } : {}) }
  for (const [id, present] of Object.entries(observations) as Array<[keyof Observations, boolean]>) {
    if (allowedSteps.has(`ota.${id}`) && present && current.steps[id]?.status !== 'done')
      patch.steps![id] = { status: 'done', at }
  }
  // Match the todo refresh cron right away, so a read never shows a delivered
  // update next to a pending app-ready step.
  if (allowedSteps.has('ota.add_code') && shouldInferAddCode(current, observations.test_update === true))
    patch.steps!.add_code = inferredAddCodeStep(at)
  if (allowedSteps.has('ota.add_channel') && observations.add_channel === false && current.steps.add_channel?.status === 'done')
    patch.steps!.add_channel = { status: 'pending' }
  const sourceChanged = canMarkCliStart && pickAppOnboardingSource(current.source, 'cli') !== current.source
  return Object.keys(patch.steps!).length || sourceChanged ? patch : null
}

export async function persistObservedProgress(c: Context<MiddlewareKeyVariables>, appId: string, observations: Observations) {
  const result = await persistAuthorizedOnboardingMutation(c, appId, {
    // add_code is never observed directly; observedProgressPatch infers it.
    requestedSteps: [...Object.keys(observations), 'add_code'].map(id => `ota.${id}` as const),
    stepOverrides: { 'ota.login_cli_mcp': { permission: 'app.read', authType: 'apikey' } },
    buildPatch: ({ current, allowedSteps, at }) => observedProgressPatch(current, observations, allowedSteps, at),
    afterPersist: tryCompletePendingAppOnboarding,
  })
  if (result)
    await emitCommittedAppOnboardingHistory(c, [result])
  return result?.onboarding
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBuilderStatuses(currentValue: unknown, platform: keyof typeof BUILDER_STEP_IDS) {
  const setup = isRecord(currentValue) && isRecord(currentValue.setup) ? currentValue.setup : {}
  if (!isActiveBuilderChecklistSetup(setup))
    return null
  const builder = isRecord(setup.steps) && isRecord(setup.steps.builder) ? setup.steps.builder : null
  const steps = builder && isRecord(builder[platform]) ? builder[platform] : null
  if (!steps)
    return null
  return BUILDER_STEP_IDS[platform].map(id => ({ id: id as string, exists: isRecord(steps[id]), status: isRecord(steps[id]) ? String(steps[id].status) : 'pending' }))
}

// Any open checklist step can be skipped with a reason. Builder patches only
// update stored step records, so a step with no record still cannot be skipped.
function skipStepPatch(currentValue: unknown, current: AppOnboardingState, step: string, at: string): AppOnboardingPatch | null {
  if (current.outcome === 'skipped')
    return null
  const [path, first, second] = step.split('.')
  if (path === 'ota') {
    if (!hasSupportedOtaTodoList(current))
      return null
    const ids = getAppOnboardingStepIds(current.todo_list_version, current.ota_todo_list_version)
    if (!ids.includes(first as AppOnboardingStepId))
      return null
    if (!isOpenOnboardingStepStatus(current.steps[first as AppOnboardingStepId]?.status))
      return null
    return { steps: { [first!]: { status: 'skipped', at } } }
  }
  const platform = first as keyof typeof BUILDER_STEP_IDS
  const statuses = readBuilderStatuses(currentValue, platform)
  const row = statuses?.find(status => status.id === second)
  // A step without a stored record cannot be patched, so do not report success.
  if (!row?.exists || !isOpenOnboardingStepStatus(row.status))
    return null
  const builderSteps: NonNullable<AppOnboardingPatch['builderSteps']> = {}
  builderSteps[`builder.${platform}.${second}`] = { status: 'skipped', at }
  return { builderSteps }
}

// Same rule as persistAuthorizedOnboardingMutation: settings update or app creation in the org.
async function canWriteOnboarding(c: Context<MiddlewareKeyVariables>, appId: string) {
  if (await checkPermission(c, 'app.update_settings', { appId }))
    return true
  let data: { owner_org: string } | undefined
  try {
    data = await withRlsContext(c, authPrincipal(c, c.get('auth')!), async client => (await client.query<{ owner_org: string }>('SELECT owner_org FROM public.apps WHERE app_id = $1', [appId])).rows[0])
  }
  catch {}
  return !!data && checkPermission(c, 'org.create_app', { orgId: data.owner_org })
}

export const app = new Hono<MiddlewareKeyVariables>()
app.use('*', useCors)
app.post('/', middlewareAuth({ preferApiKey: true }), async (c) => {
  const parsed = bodySchema.safeParse(await parseBody(c))
  if (!parsed.success)
    throw quickError(400, 'invalid_body', 'Invalid body')
  const { appId, N, initial, includeBilling } = parsed.data
  if (!(await checkPermission(c, 'app.read', { appId })))
    throw quickError(403, 'app_access_denied', 'You cannot access this app')
  const principal = authPrincipal(c, c.get('auth')!)
  const pg = await getPgClient(c)
  try {
    return await readProgress(c, { pg, principal }, appId, N, initial, includeBilling)
  }
  finally {
    closeClient(c, pg)
  }
})

async function readProgress(c: Context<MiddlewareKeyVariables>, db: CallerDb, appId: string, N: number, initial: boolean | undefined, includeBilling: boolean | undefined) {
  // Always load this exact app, on every N, even when no extra check is due.
  let rows: { onboarding: unknown, created_at: string | null, owner_org: string }[] = []
  try {
    rows = await withRlsTransaction(db.pg, db.principal, client => queryJson<{ onboarding: unknown, created_at: string | null, owner_org: string }>(
      client,
      'SELECT onboarding, created_at, owner_org FROM public.apps WHERE app_id = $1 LIMIT 2',
      [appId],
    ))
  }
  catch {}
  const row = rows.length === 1 ? rows[0] : null
  if (!row)
    throw quickError(404, 'app_not_found', 'App not found')
  // Start optional billing immediately; it shares neither the observations nor
  // the onboarding write transaction and must not delay progress persistence.
  const billing = includeBilling ? readBilling(c, db.principal, row.owner_org) : undefined
  const current = parseAppOnboarding(row.onboarding)
  const observations: Observations = {}
  const checkErrors: string[] = []
  if (hasSupportedOtaTodoList(current) && c.get('auth')?.authType === 'apikey')
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
      return hasRow(db, 'SELECT id FROM public.channels WHERE app_id = $1 LIMIT 1', [appId])
    })
  }
  const observeMilestones = hasSupportedOtaTodoList(current) && current.outcome !== 'skipped'
  if (observeMilestones && due(1) && current.steps.run_device?.status !== 'done') {
    await check('run_device', 'app.read_devices', async () => {
      return (await readDevices(c, { app_id: appId, limit: 1 }, false)).data.some(device => !!device.device_id)
    })
  }
  if (observeMilestones && due(2) && current.steps.upload_bundle?.status !== 'done')
    await check('upload_bundle', 'app.read', () => hasPublishedBundle(db, appId))
  if (observeMilestones && due(3) && current.steps.test_update?.status !== 'done')
    await check('test_update', 'app.read_logs', () => hasAppliedBundle(c, db, appId, row.created_at))
  // Conservatively assume all observed steps are writable for this no-op test.
  // Real changes still recheck permissions and rebuild against the locked row.
  const observedSteps = new Set(Object.keys(observations).map(id => `ota.${id}`))
  // Inference repeats on every read, so check write access first: read-only
  // pollers must not take the org lock every 2s for a write they cannot make.
  if (shouldInferAddCode(current, observations.test_update === true) && await canWriteOnboarding(c, appId))
    observedSteps.add('ota.add_code')
  const onboarding = observedProgressPatch(current, observations, observedSteps)
    ? await persistObservedProgress(c, appId, observations) ?? row.onboarding
    : row.onboarding
  c.header('Cache-Control', 'no-store')
  return c.json({ onboarding, ...(observations.add_channel !== undefined ? { hasChannel: observations.add_channel } : {}), checkErrors, ...(billing ? { billing: await billing } : {}) })
}

app.post('/skip_step', middlewareAuth({ preferApiKey: true }), async (c) => {
  const parsed = skipStepBodySchema.safeParse(await parseBody(c))
  if (!parsed.success)
    throw quickError(400, 'invalid_body', 'Invalid body')
  const { appId, step, reason } = parsed.data
  if (!(await checkPermission(c, 'app.read', { appId })))
    throw quickError(403, 'app_access_denied', 'You cannot access this app')
  // Fail fast with 403 for read-only callers; the locked write rechecks this.
  if (!(await canWriteOnboarding(c, appId)))
    throw quickError(403, 'app_access_denied', 'You cannot update this app onboarding')
  const result = await persistAuthorizedOnboardingMutation(c, appId, {
    requestedSteps: [step as `${string}.${string}`],
    buildPatch: ({ current, currentValue, allowedSteps, at }) => allowedSteps.has(step as `${string}.${string}`)
      ? skipStepPatch(currentValue, current, step, at)
      : null,
    afterPersist: tryCompletePendingAppOnboarding,
  })
  if (!result)
    throw quickError(409, 'step_not_skippable', 'This onboarding step cannot be skipped')
  await emitCommittedAppOnboardingHistory(c, [result], { skipReason: reason })
  c.header('Cache-Control', 'no-store')
  return c.json({ onboarding: result.onboarding })
})
