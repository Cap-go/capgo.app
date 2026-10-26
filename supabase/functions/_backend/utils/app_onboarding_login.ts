import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { sql } from 'drizzle-orm'
import { emitCommittedAppOnboardingHistory } from './app_onboarding_posthog.ts'
import { hasSupportedOtaTodoList, pickAppOnboardingSource } from './appOnboarding.ts'
import { tryCompletePendingAppOnboarding } from './appOnboardingCompletion.ts'
import { persistAuthorizedOnboardingMutation } from './appOnboardingMutation.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'

export function getAppOnboardingLoginSource(channel: string, event: string) {
  if (channel === 'mcp' && event === 'MCP Tool Invoked')
    return 'mcp' as const
  if ((channel === 'user-login' && event === 'User CLI login')
    || (channel === 'cli-usage' && event === 'CLI Command Invoked')) {
    return 'cli' as const
  }
  return undefined
}

export async function markAppOnboardingLoginFromTracking(
  c: Context<MiddlewareKeyVariables>,
  channel: string,
  event: string,
): Promise<void> {
  const source = getAppOnboardingLoginSource(channel, event)
  if (source)
    await markAppOnboardingLogin(c, source)
}

/**
 * Mark "Log in CLI/MCP" done on the caller's checklist apps. Called from tracking events and
 * right after an API-key app create: an agent that logged in before the app existed must not
 * leave the step pending.
 */
export async function markAppOnboardingLogin(
  c: Context<MiddlewareKeyVariables>,
  source: 'cli' | 'mcp' | 'ai',
): Promise<void> {
  const auth = c.get('auth')
  if (auth?.authType !== 'apikey')
    return

  const pool = await getPgClient(c)
  try {
    // Discover candidates without holding locks, then mutate each app in its own
    // bounded transaction. A single multi-row FOR UPDATE previously kept the
    // Hyperdrive connection idle in transaction for 6-11s across permission work.
    const candidates = await getDrizzleClient(pool, { logger: false }).execute<{ app_id: string }>(sql`
      SELECT app_id
      FROM public.apps
      WHERE onboarding ->> 'created_by_user_id' = ${auth.userId}
        AND onboarding #>> '{setup,todo_list_version}' IN ('2', '3', '4')
        AND (onboarding #>> '{setup,todo_list_version}' <> '4'
          OR onboarding #>> '{setup,ota_todo_list_version}' = '1')
    `)
    for (const app of candidates.rows) {
      const changed = await persistAuthorizedOnboardingMutation(c, app.app_id, {
        requestedSteps: ['ota.login_cli_mcp'],
        stepOverrides: { 'ota.login_cli_mcp': { permission: 'app.read', authType: 'apikey' } },
        buildPatch: ({ current, allowedSteps, at }) => {
          // A v4 Builder-only app has no OTA login milestone to update.
          if ((current.todo_list_version === 4 && !hasSupportedOtaTodoList(current))
            || !allowedSteps.has('ota.login_cli_mcp')) {
            return null
          }
          if (current.steps.login_cli_mcp?.status === 'done'
            && pickAppOnboardingSource(current.source, source) === current.source) {
            return null
          }
          return { source, steps: { login_cli_mcp: { status: 'done', at } } }
        },
        afterPersist: tryCompletePendingAppOnboarding,
      }, pool)
      if (changed)
        await emitCommittedAppOnboardingHistory(c, [changed])
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'app onboarding login tracking failed', error: serializeError(error) })
  }
  finally {
    await closeClient(c, pool)
  }
}
