import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { sql } from 'drizzle-orm'
import { getAppOnboardingLoginSource } from './app_onboarding_login.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'

/**
 * AI onboarding: the console shows live agent progress. The first CLI login or command
 * with an API key marks the agent as connected; the first Capgo MCP tool call marks MCP
 * as installed.
 *
 * Published CLIs already send these events, so no CLI release is needed. The update only
 * matches users in AI setup mode who are not marked yet, so it is a no-op for everyone else.
 */
/** Name of the API key the console creates for the AI onboarding prompt. */
export const AI_ONBOARDING_API_KEY_NAME = 'ai-onboarding'

export async function markAiOnboardingAgentConnected(
  c: Context<MiddlewareKeyVariables>,
  channel: string,
  event: string,
): Promise<void> {
  const auth = c.get('auth')
  // Any MCP event (including "MCP Server Started" when the agent loads it) proves MCP is installed.
  const source = channel === 'mcp' ? 'mcp' : getAppOnboardingLoginSource(channel, event)
  if (!source || auth?.authType !== 'apikey')
    return
  // Only the key the AI onboarding prompt hands out can be the agent we are waiting for. This
  // in-memory check keeps every other CLI/MCP event free of an extra database query.
  const keyName = auth.apikey?.name ?? c.get('apikey')?.name
  if (keyName !== AI_ONBOARDING_API_KEY_NAME)
    return

  let pool: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    pool = await getPgClient(c)
    // First contact sets ai_agent_connected_at; the first MCP tool call also sets
    // ai_mcp_connected_at. Later events match no row and write nothing.
    await getDrizzleClient(pool, { logger: false }).execute(sql`
      UPDATE public.users
      SET onboarding = onboarding
        || jsonb_build_object('ai_agent_connected_at', coalesce(onboarding -> 'ai_agent_connected_at', to_jsonb(now())))
        || CASE WHEN ${source}::text = 'mcp'
          THEN jsonb_build_object('ai_mcp_connected_at', coalesce(onboarding -> 'ai_mcp_connected_at', to_jsonb(now())))
          ELSE '{}'::jsonb
        END
      WHERE id = ${auth.userId}::uuid
        AND onboarding ->> 'setup_mode' = 'ai'
        AND (
          onboarding -> 'ai_agent_connected_at' IS NULL
          OR (${source}::text = 'mcp' AND onboarding -> 'ai_mcp_connected_at' IS NULL)
        )
    `)
  }
  catch (error) {
    // Best effort: the event itself must never fail because of this hint.
    cloudlogErr({ requestId: c.get('requestId'), message: 'ai onboarding agent marker failed', error: serializeError(error) })
  }
  finally {
    if (pool)
      await closeClient(c, pool)
  }
}
