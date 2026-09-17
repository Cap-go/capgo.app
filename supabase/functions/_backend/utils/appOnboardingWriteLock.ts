import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'

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
  const current = (await tx.execute<{ onboarding: unknown, owner_org: string }>(sql`
    SELECT onboarding, owner_org FROM public.apps WHERE app_id = ${appId} FOR UPDATE
  `)).rows[0]
  // A concurrent organization transfer must be retried under its new lock.
  return current?.owner_org === scope.owner_org ? current : null
}
