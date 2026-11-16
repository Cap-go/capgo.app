import type { Context } from 'hono'
import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPostgresClient } from './test-utils.ts'

const { trackPosthogEvent, db } = vi.hoisted(() => ({
  trackPosthogEvent: vi.fn(),
  db: { client: undefined as PoolClient | undefined },
}))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  backgroundTask: (_c: unknown, p: Promise<unknown>) => p,
}))
// The real UPDATE runs on the test transaction, which is rolled back at the end.
vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: async () => db.client,
  closeClient: () => {},
}))

const { AI_ONBOARDING_API_KEY_NAME, markAiOnboardingAgentConnected } = await import('../supabase/functions/_backend/utils/ai_onboarding_agent.ts')

afterAll(async () => (await getPostgresClient()).end())

describe('markAiOnboardingAgentConnected first-write detection', () => {
  it('sends each connected event only when its marker is first written', async () => {
    const client = await (await getPostgresClient()).connect()
    db.client = client
    const userId = randomUUID()
    const values: Record<string, unknown> = { auth: { authType: 'apikey', userId, apikey: { name: AI_ONBOARDING_API_KEY_NAME } }, requestId: 'req' }
    const c = { get: (key: string) => values[key] } as unknown as Context<any>
    const sentEvents = () => trackPosthogEvent.mock.calls.map(([, payload]) => payload.event)
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO auth.users(id, email) VALUES ($1, $2)', [userId, `${userId}@ai-onboarding.test`])
      await client.query('INSERT INTO public.users(id, email, onboarding) VALUES ($1, $2, $3)', [userId, `${userId}@ai-onboarding.test`, { setup_mode: 'ai', intent: 'builder' }])

      await markAiOnboardingAgentConnected(c, 'user-login', 'User CLI login')
      expect(sentEvents()).toEqual(['onboarding_ai_agent_connected'])
      expect(trackPosthogEvent.mock.calls[0]![1].nonPersonTags).toEqual({ source: 'cli', intent: 'builder' })

      trackPosthogEvent.mockClear()
      await markAiOnboardingAgentConnected(c, 'user-login', 'User CLI login')
      expect(sentEvents()).toEqual([])

      // An agent marker from an earlier request: MCP only adds its own marker.
      await client.query(`UPDATE public.users SET onboarding = onboarding || '{"ai_agent_connected_at": "2026-01-01T00:00:00+00:00"}' WHERE id = $1`, [userId])
      await markAiOnboardingAgentConnected(c, 'mcp', 'MCP Tool Invoked')
      expect(sentEvents()).toEqual(['onboarding_ai_mcp_connected'])
      const onboarding = (await client.query('SELECT onboarding FROM public.users WHERE id = $1', [userId])).rows[0].onboarding
      expect(onboarding.ai_agent_connected_at).toBe('2026-01-01T00:00:00+00:00')
      expect(onboarding.ai_mcp_connected_at).toEqual(expect.any(String))
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
      db.client = undefined
    }
  })
})
