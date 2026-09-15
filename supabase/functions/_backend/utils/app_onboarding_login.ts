import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { sql } from 'drizzle-orm'
import { buildAppOnboardingStepPosthogEvent } from './app_onboarding_posthog.ts'
import { appendAppOnboardingStepHistory, applyAppOnboardingPatch, getAppOnboardingStepHistoryChanges, parseAppOnboarding, pickAppOnboardingSource } from './appOnboarding.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'
import { trackPosthogEvent } from './posthog.ts'
import { backgroundTask } from './utils.ts'

export function getAppOnboardingLoginSource(channel: string, event: string) {
  if (channel === 'mcp' && event === 'MCP Tool Invoked')
    return 'mcp' as const
  if ((channel === 'user-login' && event === 'User CLI login')
    || (channel === 'cli-usage' && event === 'CLI Command Invoked'))
    return 'cli' as const
  return undefined
}

export async function markAppOnboardingLoginFromTracking(
  c: Context<MiddlewareKeyVariables>,
  channel: string,
  event: string,
): Promise<void> {
  const auth = c.get('auth')
  const source = getAppOnboardingLoginSource(channel, event)
  if (!source || auth?.authType !== 'apikey')
    return

  const pool = getPgClient(c)
  try {
    const committed = await getDrizzleClient(pool).transaction(async (tx) => {
      const result = await tx.execute<{ app_id: string, onboarding: unknown, owner_org: string }>(sql`
        SELECT app_id, onboarding, owner_org
        FROM public.apps
        WHERE onboarding ->> 'created_by_user_id' = ${auth.userId}
          AND onboarding #>> '{setup,todo_list_version}' = '2'
        FOR UPDATE
      `)
      const changes = []
      for (const app of result.rows) {
        const current = parseAppOnboarding(app.onboarding)
        if (current.steps.login_cli_mcp?.status === 'done'
          && pickAppOnboardingSource(current.source, source) === current.source)
          continue

        const at = new Date().toISOString()
        const patch = { source, steps: { login_cli_mcp: { status: 'done' as const, at } } }
        const merged = applyAppOnboardingPatch(app.onboarding, patch, () => at)
        const onboarding = appendAppOnboardingStepHistory(app.onboarding, merged, patch, () => at)
        const historyChanges = getAppOnboardingStepHistoryChanges(app.onboarding, onboarding, patch)
        await tx.execute(sql`
          UPDATE public.apps
          SET onboarding = ${JSON.stringify(onboarding)}::jsonb, updated_at = now()
          WHERE app_id = ${app.app_id}
        `)
        await tx.execute(sql`SELECT public.try_complete_pending_onboarding_if_setup_done(${app.app_id})`)
        changes.push(...historyChanges.map(change => ({ app, change, setup: parseAppOnboarding(onboarding) })))
      }
      return changes
    })

    if (committed.length > 0) {
      await backgroundTask(c, Promise.all(committed.map(({ app, change, setup }) => trackPosthogEvent(c, buildAppOnboardingStepPosthogEvent({
        appId: app.app_id,
        auth,
        change,
        orgId: app.owner_org,
        setup,
      })))))
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'app onboarding login tracking failed', error: serializeError(error) })
  }
  finally {
    await closeClient(c, pool)
  }
}
