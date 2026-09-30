import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { quickError } from './hono.ts'

type Transaction = Parameters<Parameters<ReturnType<typeof getDrizzleClient>['transaction']>[0]>[0]
class AppOnboardingScopeChanged extends Error {}

// Retry only after the transaction rolls back, releasing the old org and app
// locks. Taking a second org lock while holding the app row can deadlock.
export async function retryAppOnboardingWrite<T>(
  database: Pick<ReturnType<typeof getDrizzleClient>, 'transaction'>,
  operation: (tx: Transaction) => Promise<T>,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await database.transaction(operation)
    }
    catch (error) {
      if (!(error instanceof AppOnboardingScopeChanged))
        throw error
      if (attempt === 2)
        throw quickError(409, 'app_scope_changed', 'The app changed organizations during setup. Please try again.')
    }
  }
  throw new Error('Onboarding retry limit exhausted')
}

// Match membership/role revocation's org -> app lock order. Both reads are
// exact app_id primary-key lookups; the org advisory lock lasts until commit.
export async function lockAppOnboardingForWrite(
  tx: Pick<ReturnType<typeof getDrizzleClient>, 'execute'>,
  appId: string,
) {
  const scope = (await tx.execute<{ owner_org: string }>(sql`
    SELECT owner_org FROM public.apps WHERE app_id = ${appId}
  `)).rows[0]
  if (!scope)
    return null
  await tx.execute(sql`SELECT public.lock_rbac_orgs(${scope.owner_org}::uuid)`)
  const current = (await tx.execute<{ onboarding: unknown, owner_org: string, need_onboarding: boolean }>(sql`
    SELECT onboarding, owner_org, need_onboarding FROM public.apps WHERE app_id = ${appId} FOR UPDATE
  `)).rows[0]
  // A concurrent organization transfer must be retried under its new lock.
  if (current && current.owner_org !== scope.owner_org)
    throw new AppOnboardingScopeChanged()
  return current ?? null
}
