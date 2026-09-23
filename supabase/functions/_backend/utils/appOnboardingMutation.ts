import type { Context } from 'hono'
import type { AppOnboardingPatch, AppOnboardingState, AppOnboardingStepHistoryChange } from './appOnboarding.ts'
import type { AuthInfo, MiddlewareKeyVariables } from './hono.ts'
import type { Permission } from './rbac.ts'
import { sql } from 'drizzle-orm'
import { appendAppOnboardingStepHistory, applyAppOnboardingPatch, getAppOnboardingStepHistoryChanges, parseAppOnboarding } from './appOnboarding.ts'
import { lockAppOnboardingForWrite, retryAppOnboardingWrite } from './appOnboardingWriteLock.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'
import { checkPermissionPg } from './rbac.ts'

type WriteTransaction = Pick<ReturnType<typeof getDrizzleClient>, 'execute'>
type LogicalStepId = `${string}.${string}`

export interface AppOnboardingMutationResult {
  appId: string
  orgId: string
  onboarding: Record<string, unknown>
  historyChanges: AppOnboardingStepHistoryChange[]
}

interface AuthorizedOnboardingMutation {
  requestedSteps: readonly LogicalStepId[]
  stepOverrides?: Partial<Record<LogicalStepId, { permission: Permission, authType: AuthInfo['authType'] }>>
  // This trusted adapter builds a patch only for allowedSteps; logical step IDs
  // and their stored representation belong to the caller, not authorization.
  buildPatch: (input: { current: AppOnboardingState, currentValue: unknown, allowedSteps: ReadonlySet<LogicalStepId>, at: string }) => AppOnboardingPatch | null
  afterPersist?: (tx: WriteTransaction, result: AppOnboardingMutationResult) => Promise<unknown>
}

// The caller must already hold the row lock for the supplied snapshot. Results
// from this variant are committed only when the caller's outer transaction ends.
export async function persistLockedAuthorizedOnboardingMutation(
  c: Context<MiddlewareKeyVariables>,
  tx: WriteTransaction,
  appId: string,
  row: { onboarding: unknown, owner_org: string },
  mutation: AuthorizedOnboardingMutation,
): Promise<AppOnboardingMutationResult | null> {
  const auth = c.get('auth')!
  const key = auth.apikey?.key ?? c.get('capgkey') ?? null
  const canWrite = await checkPermissionPg(c, 'app.update_settings', { appId }, tx, auth.userId, key)
    || await checkPermissionPg(c, 'org.create_app', { orgId: row.owner_org }, tx, auth.userId, key)
  const allowedSteps = new Set<LogicalStepId>()
  for (const stepId of new Set(mutation.requestedSteps)) {
    const override = mutation.stepOverrides?.[stepId]
    if (canWrite || (override?.authType === auth.authType
      && await checkPermissionPg(c, override.permission, { appId }, tx, auth.userId, key))) {
      allowedSteps.add(stepId)
    }
  }
  if (!allowedSteps.size)
    return null
  const at = new Date().toISOString()
  const patch = mutation.buildPatch({ current: parseAppOnboarding(row.onboarding), currentValue: row.onboarding, allowedSteps, at })
  if (!patch)
    return null
  const merged = applyAppOnboardingPatch(row.onboarding, patch, () => at)
  const onboarding = appendAppOnboardingStepHistory(row.onboarding, merged, patch, () => at)
  const result = { appId, orgId: row.owner_org, onboarding, historyChanges: getAppOnboardingStepHistoryChanges(row.onboarding, onboarding, patch) }
  await tx.execute(sql`UPDATE public.apps SET onboarding = ${JSON.stringify(onboarding)}::jsonb, updated_at = now() WHERE app_id = ${appId}`)
  await mutation.afterPersist?.(tx, result)
  return result
}

export async function persistAuthorizedOnboardingMutation(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  mutation: AuthorizedOnboardingMutation,
  client?: Parameters<typeof getDrizzleClient>[0],
): Promise<AppOnboardingMutationResult | null> {
  const pool = client ? null : getPgClient(c)
  try {
    return await retryAppOnboardingWrite(getDrizzleClient(client ?? pool!, { logger: false }), async (tx) => {
      const row = await lockAppOnboardingForWrite(tx, appId)
      return row ? persistLockedAuthorizedOnboardingMutation(c, tx, appId, row, mutation) : null
    })
  }
  finally {
    if (pool)
      await closeClient(c, pool)
  }
}
