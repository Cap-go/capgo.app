import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'

export async function tryCompletePendingAppOnboarding(tx: Pick<ReturnType<typeof getDrizzleClient>, 'execute'>, { appId }: { appId: string }) {
  await tx.execute(sql`SELECT public.try_complete_pending_onboarding_if_setup_done(${appId})`)
}
