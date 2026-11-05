import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, getPgClient, closeClient } = vi.hoisted(() => ({
  execute: vi.fn(),
  getPgClient: vi.fn(),
  closeClient: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient,
  closeClient,
  getDrizzleClient: () => ({ execute }),
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>(),
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

const { AI_ONBOARDING_API_KEY_NAME, markAiOnboardingAgentConnected } = await import('../supabase/functions/_backend/utils/ai_onboarding_agent.ts')

function context(auth: Record<string, unknown> | undefined) {
  const values: Record<string, unknown> = { auth, requestId: 'req' }
  return { get: (key: string) => values[key] } as unknown as Context<any>
}

describe('markAiOnboardingAgentConnected', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPgClient.mockResolvedValue({})
  })

  it('updates the user for the AI onboarding key on CLI login and MCP events', async () => {
    const auth = { authType: 'apikey', userId: '00000000-0000-4000-8000-000000000001', apikey: { name: AI_ONBOARDING_API_KEY_NAME } }
    await markAiOnboardingAgentConnected(context(auth), 'user-login', 'User CLI login')
    await markAiOnboardingAgentConnected(context(auth), 'mcp', 'MCP Server Started')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(closeClient).toHaveBeenCalledTimes(2)
  })

  it('never queries the database for other keys, JWTs or unrelated events', async () => {
    await markAiOnboardingAgentConnected(context({ authType: 'apikey', userId: 'u', apikey: { name: 'ci-deploy' } }), 'user-login', 'User CLI login')
    await markAiOnboardingAgentConnected(context({ authType: 'jwt', userId: 'u', apikey: null }), 'user-login', 'User CLI login')
    await markAiOnboardingAgentConnected(context({ authType: 'apikey', userId: 'u', apikey: { name: AI_ONBOARDING_API_KEY_NAME } }), 'bundle', 'Bundle Uploaded')
    expect(getPgClient).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('only counts the prompt key of the organization being set up', async () => {
    const auth = { authType: 'apikey', userId: 'u', apikey: { name: AI_ONBOARDING_API_KEY_NAME, rbac_id: '00000000-0000-4000-8000-0000000000aa' } }
    await markAiOnboardingAgentConnected(context(auth), 'mcp', 'MCP Tool Invoked')
    const query = JSON.stringify(execute.mock.calls[0]![0])
    expect(query).toContain('ai_setup_org_id')
    expect(query).toContain('role_bindings')
    expect(query).toContain('00000000-0000-4000-8000-0000000000aa')
  })

  it('stays best effort when the database is unavailable', async () => {
    getPgClient.mockRejectedValueOnce(new Error('connection refused'))
    const auth = { authType: 'apikey', userId: 'u', apikey: { name: AI_ONBOARDING_API_KEY_NAME } }
    await expect(markAiOnboardingAgentConnected(context(auth), 'user-login', 'User CLI login')).resolves.toBeUndefined()
  })
})
