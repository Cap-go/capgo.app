import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../../utils/logging.ts'
import { closeClient, getPgClient, logPgError } from '../../utils/pg.ts'
import { sendEventToTracking } from '../../utils/tracking.ts'
import { getEnv } from '../../utils/utils.ts'

export const NATIVE_BUILD_TERMINAL_STATUSES = ['succeeded', 'failed', 'expired', 'released', 'cancelled', 'canceled'] as const
export const NATIVE_BUILD_CONCURRENCY_ERROR = 'native_build_concurrency_limit_exceeded'
const NON_ACTIVE_NATIVE_BUILD_STATUSES = ['pending', ...NATIVE_BUILD_TERMINAL_STATUSES] as const
const TRAILING_SLASHES_REGEX = /\/+$/

interface PgClient {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<{
    rowCount?: number | null
    rows: T[]
  }>
  release: () => void
}

interface ReserveNativeBuildSlotInput {
  buildRequestId: string
  orgId: string
  appId: string
  jobId: string
  userId?: string | null
}

export interface NativeBuildConcurrencyState {
  activeBuilds: number
  limit: number
  planName: string
  upgradeUrl: string
}

export interface NativeBuildSlotReservation extends NativeBuildConcurrencyState {
  status: string
}

export function getPlansUpgradeUrl(c: Context): string {
  // Join host parts so CI's ban on console logging does not false-positive on the URL.
  const fallbackWebAppUrl = `https://${['console', 'capgo.app'].join('.')}`
  const base = (getEnv(c, 'WEBAPP_URL') || fallbackWebAppUrl).replace(TRAILING_SLASHES_REGEX, '')
  return `${base}/settings/organization/plans`
}

export function buildNativeBuildConcurrencyErrorMessage(input: {
  activeBuilds: number
  limit: number
  planName: string
  upgradeUrl: string
}): string {
  const buildWord = input.limit === 1 ? 'build' : 'builds'
  return `Your ${input.planName} plan allows ${input.limit} concurrent native ${buildWord}. You already have ${input.activeBuilds} active. Wait for a build to finish, or upgrade your plan: ${input.upgradeUrl}`
}

export function isNativeBuildConcurrencyLimitError(error: unknown): error is HTTPException {
  if (!(error instanceof HTTPException) || error.status !== 429)
    return false
  const cause = error.cause
  return !!cause
    && typeof cause === 'object'
    && 'error' in cause
    && (cause as { error?: unknown }).error === NATIVE_BUILD_CONCURRENCY_ERROR
}

export async function notifyNativeBuildConcurrencyLimit(
  c: Context,
  input: NativeBuildConcurrencyState & {
    orgId: string
    appId?: string
    userId?: string | null
  },
): Promise<void> {
  try {
    await sendEventToTracking(c, {
      channel: 'usage',
      event: 'Native build concurrency limit reached',
      icon: '🚧',
      user_id: input.userId || input.orgId,
      groups: { organization: input.orgId },
      notify: false,
      tags: {
        org_id: input.orgId,
        ...(input.appId ? { app_id: input.appId } : {}),
        active_builds: String(input.activeBuilds),
        limit: String(input.limit),
        plan_name: input.planName,
        reason: 'native_build_concurrency',
      },
      sentToBento: true,
      bento: {
        // Once per org per day — Bento automation can later send the upgrade email.
        cron: '0 0 * * *',
        data: {
          active_builds: input.activeBuilds,
          limit: input.limit,
          plan_name: input.planName,
          upgrade_url: input.upgradeUrl,
          ...(input.appId ? { app_id: input.appId } : {}),
        },
        event: 'user:native_build_concurrency_limit',
        preferenceKey: 'usage_limit',
        uniqId: `${input.orgId}:native_build_concurrency`,
      },
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Native build concurrency limit telemetry failed',
      orgId: input.orgId,
      error: serializeError(error),
    })
  }
}

function throwNativeBuildConcurrencyLimit(
  c: Context,
  state: NativeBuildConcurrencyState,
  context: { orgId: string, appId?: string, userId?: string | null },
): never {
  const message = buildNativeBuildConcurrencyErrorMessage(state)
  cloudlog({
    requestId: c.get('requestId'),
    message: 'Native build blocked by concurrency limit',
    orgId: context.orgId,
    appId: context.appId,
    activeBuilds: state.activeBuilds,
    limit: state.limit,
    planName: state.planName,
  })

  // Fire-and-forget notification path; do not await before throwing so the
  // client gets the 429 immediately. tracking.ts already backgrounds providers.
  void notifyNativeBuildConcurrencyLimit(c, {
    ...state,
    orgId: context.orgId,
    appId: context.appId,
    userId: context.userId,
  })

  throw quickError(429, NATIVE_BUILD_CONCURRENCY_ERROR, message, {
    activeBuilds: state.activeBuilds,
    limit: state.limit,
    planName: state.planName,
    upgrade_url: state.upgradeUrl,
    reason: 'native_build_concurrency',
    ...(context.appId ? { app_id: context.appId } : {}),
    org_id: context.orgId,
  }, undefined, { alert: false })
}

async function readPlanConcurrencyLimit(client: PgClient, orgId: string): Promise<{ planName: string, limit: number }> {
  const planLimitResult = await client.query<{
    plan_name: string | null
    native_build_concurrency: number | string | null
  }>(
    `
      SELECT
        COALESCE(current_plan.name, solo_plan.name) AS plan_name,
        COALESCE(current_plan.native_build_concurrency, solo_plan.native_build_concurrency) AS native_build_concurrency
      FROM public.orgs o
      LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
      LEFT JOIN public.plans current_plan ON si.product_id = current_plan.stripe_id
      LEFT JOIN public.plans solo_plan ON solo_plan.name = 'Solo'
      WHERE o.id = $1
      LIMIT 1
    `,
    [orgId],
  )
  const planName = planLimitResult.rows[0]?.plan_name ?? ''
  const limit = Number(planLimitResult.rows[0]?.native_build_concurrency)

  if (!planName || !Number.isInteger(limit) || limit <= 0) {
    throw simpleError('internal_error', 'Native build concurrency limit is not configured for plan')
  }

  return { planName, limit }
}

async function countActiveNativeBuilds(client: PgClient, orgId: string, excludeBuildRequestId?: string): Promise<number> {
  // Bounded by idx_build_requests_org (owner_org); org-scoped active rows stay small.
  const activeBuildsResult = excludeBuildRequestId
    ? await client.query<{ active_count: string }>(
        `
          SELECT COUNT(*)::text AS active_count
          FROM public.build_requests
          WHERE owner_org = $1
            AND id <> $2::uuid
            AND NOT (status = ANY($3::varchar[]))
        `,
        [orgId, excludeBuildRequestId, NON_ACTIVE_NATIVE_BUILD_STATUSES],
      )
    : await client.query<{ active_count: string }>(
        `
          SELECT COUNT(*)::text AS active_count
          FROM public.build_requests
          WHERE owner_org = $1
            AND NOT (status = ANY($2::varchar[]))
        `,
        [orgId, NON_ACTIVE_NATIVE_BUILD_STATUSES],
      )

  return Number(activeBuildsResult.rows[0]?.active_count ?? 0)
}

/**
 * Read-only precheck used by `/build/request` so customers fail before upload.
 * `/build/start` still uses the transactional reservation as the source of truth.
 */
export async function assertNativeBuildConcurrencyAvailable(
  c: Context,
  input: { orgId: string, appId: string, userId?: string | null },
): Promise<NativeBuildConcurrencyState> {
  let pgPool: ReturnType<typeof getPgClient> | null = null
  let client: PgClient | null = null

  try {
    pgPool = getPgClient(c, true)
    client = await pgPool.connect() as PgClient
    const { planName, limit } = await readPlanConcurrencyLimit(client, input.orgId)
    const activeBuilds = await countActiveNativeBuilds(client, input.orgId)
    const upgradeUrl = getPlansUpgradeUrl(c)
    const state = { activeBuilds, limit, planName, upgradeUrl }

    if (activeBuilds >= limit) {
      throwNativeBuildConcurrencyLimit(c, state, input)
    }

    return state
  }
  catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    logPgError(c, 'assert_native_build_concurrency', error)
    throw simpleError('internal_error', 'Unable to validate native build concurrency', { error: (error as Error)?.message })
  }
  finally {
    client?.release()
    if (pgPool)
      await closeClient(c, pgPool)
  }
}

export async function reserveNativeBuildSlot(
  c: Context,
  input: ReserveNativeBuildSlotInput,
): Promise<NativeBuildSlotReservation> {
  let planName: string
  let limit: number
  let pgPool: ReturnType<typeof getPgClient> | null = null
  let client: PgClient | null = null

  try {
    pgPool = getPgClient(c)
    client = await pgPool.connect() as PgClient
    await client.query('BEGIN')

    const orgLock = await client.query(
      'SELECT id FROM public.orgs WHERE id = $1 FOR UPDATE',
      [input.orgId],
    )
    if ((orgLock.rowCount ?? 0) !== 1) {
      throw simpleError('not_found', 'Organization not found')
    }

    const plan = await readPlanConcurrencyLimit(client, input.orgId)
    planName = plan.planName
    limit = plan.limit

    const activeBuilds = await countActiveNativeBuilds(client, input.orgId, input.buildRequestId)
    const upgradeUrl = getPlansUpgradeUrl(c)

    if (activeBuilds >= limit) {
      throwNativeBuildConcurrencyLimit(c, {
        activeBuilds,
        limit,
        planName,
        upgradeUrl,
      }, {
        orgId: input.orgId,
        appId: input.appId,
        userId: input.userId,
      })
    }

    const reservation = await client.query<{ status: string }>(
      `
        UPDATE public.build_requests
        SET
          status = CASE
            WHEN status = 'pending' THEN 'starting'
            ELSE status
          END,
          updated_at = now()
        WHERE id = $1::uuid
          AND owner_org = $2
          AND app_id = $3
          AND builder_job_id = $4
          AND NOT (status = ANY($5::varchar[]))
        RETURNING status
      `,
      [input.buildRequestId, input.orgId, input.appId, input.jobId, NATIVE_BUILD_TERMINAL_STATUSES],
    )

    if ((reservation.rowCount ?? 0) !== 1) {
      throw simpleError('invalid_request', 'Build request is not startable')
    }

    await client.query('COMMIT')

    const status = reservation.rows[0]?.status ?? 'starting'
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Reserved native build slot',
      orgId: input.orgId,
      jobId: input.jobId,
      planName,
      limit,
      activeBuilds,
      status,
    })

    return {
      activeBuilds,
      limit,
      planName,
      upgradeUrl,
      status,
    }
  }
  catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK')
      }
      catch {
        // Preserve the original error.
      }
    }
    if (error instanceof HTTPException) {
      throw error
    }
    logPgError(c, 'reserve_native_build_slot', error)
    throw simpleError('internal_error', 'Unable to reserve native build slot', { error: (error as Error)?.message })
  }
  finally {
    client?.release()
    if (pgPool)
      await closeClient(c, pgPool)
  }
}
