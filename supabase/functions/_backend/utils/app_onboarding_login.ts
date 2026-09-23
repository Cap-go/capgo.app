import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { sql } from 'drizzle-orm'
import { emitCommittedAppOnboardingHistory } from './app_onboarding_posthog.ts'
import { hasSupportedOtaTodoList, pickAppOnboardingSource } from './appOnboarding.ts'
import { tryCompletePendingAppOnboarding } from './appOnboardingCompletion.ts'
import { persistLockedAuthorizedOnboardingMutation } from './appOnboardingMutation.ts'
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
  const auth = c.get('auth')
  const source = getAppOnboardingLoginSource(channel, event)
  if (!source || auth?.authType !== 'apikey')
    return

  const pool = await getPgClient(c)
  try {
    const committed = await getDrizzleClient(pool).transaction(async (tx) => {
      const result = await tx.execute<{ app_id: string, onboarding: unknown, owner_org: string }>(sql`
        SELECT app_id, onboarding, owner_org
        FROM public.apps
        WHERE onboarding ->> 'created_by_user_id' = ${auth.userId}
          AND onboarding #>> '{setup,todo_list_version}' IN ('2', '3', '4')
          AND (onboarding #>> '{setup,todo_list_version}' <> '4'
            OR onboarding #>> '{setup,ota_todo_list_version}' = '1')
        FOR UPDATE
      `)
      const changes = []
      for (const app of result.rows) {
        const changed = await persistLockedAuthorizedOnboardingMutation(c, tx, app.app_id, app, {
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
        })
        if (changed)
          changes.push(changed)
      }
      return changes
    })

    await emitCommittedAppOnboardingHistory(c, committed)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'app onboarding login tracking failed', error: serializeError(error) })
  }
  finally {
    await closeClient(c, pool)
  }
}
