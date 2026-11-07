import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HOSTED_MCP_RELAY_HEADER, hostedMcpRelayProof, hostedMcpRelayRequestHeaders } from '../supabase/functions/_backend/utils/hosted_mcp_relay.ts'
import { getBuildStatus, shouldPersistBuildStatus } from '../supabase/functions/_backend/public/build/status.ts'
import { API_SECRET } from './test-utils.ts'

const mocks = vi.hoisted(() => ({
  adminQuery: vi.fn(),
  rlsQuery: vi.fn(),
  checklist: vi.fn(),
  emit: vi.fn(),
  permission: vi.fn(),
  recordBuildTime: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/builder_onboarding_checklist.ts', () => ({ persistBuilderBuildOutcome: mocks.checklist }))
vi.mock('../supabase/functions/_backend/utils/build_tracking.ts', () => ({ emitBuildTransitionEvent: mocks.emit }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  recordBuildTime: mocks.recordBuildTime,
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => ({ query: mocks.adminQuery }),
  closeClient: () => {},
}))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: mocks.rlsQuery }),
  }
})
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => ({ BUILDER_URL: 'https://builder.test', BUILDER_API_KEY: 'builder-key', API_SECRET } as Record<string, string>)[key] ?? '',
}))

const appId = 'com.test.status-checklist'
const jobId = 'builder-job'

function context(headers: Record<string, string> = {}) {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
    req: {
      header: (name: string) => {
        const key = Object.keys(headers).find(header => header.toLowerCase() === name.toLowerCase())
        return key ? headers[key] : undefined
      },
    },
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  } as any
}

function configureCas(data: Array<{ id: string }>) {
  mocks.adminQuery.mockResolvedValue({ rows: data, rowCount: data.length })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.permission.mockResolvedValue(true)
  mocks.checklist.mockResolvedValue(false)
  mocks.emit.mockResolvedValue(undefined)
  mocks.recordBuildTime.mockResolvedValue(undefined)
  const buildRequest = {
    app_id: appId,
    owner_org: '11111111-1111-4111-8111-111111111111',
    requested_by: '22222222-2222-4222-8222-222222222222',
    platform: 'ios',
    status: 'running',
    build_mode: 'release',
  }
  mocks.rlsQuery.mockImplementation(async (text: string) => {
    if (text.includes('FROM public.build_requests'))
      return { rows: [{ row: buildRequest }] }
    return { rows: [{ row: { build_timeout_seconds: 900, build_timeout_updated_at: new Date().toISOString() } }] }
  })
  configureCas([{ id: 'row-id' }])
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    job: { status: 'succeeded', started_at: null, completed_at: null, error: null },
    machine: null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
})

describe('hostedMcp relay dispatch', () => {
  it('mint request headers createCaller uses for sub-requests', () => {
    const headers = hostedMcpRelayRequestHeaders(context() as any)
    expect(headers['user-agent']).toBe('capgo-mcp')
    expect(headers[HOSTED_MCP_RELAY_HEADER]).toBe(hostedMcpRelayProof(API_SECRET))
  })
})

describe('isHostedMcpBuildStatusRelay', () => {
  it('accepts only the server-side relay proof', async () => {
    const { isHostedMcpBuildStatusRelay } = await import('../supabase/functions/_backend/utils/hosted_mcp_relay.ts')
    const proof = hostedMcpRelayProof(API_SECRET)
    expect(await isHostedMcpBuildStatusRelay(context({ 'x-cli-command': 'mcp' }) as any)).toBe(false)
    expect(await isHostedMcpBuildStatusRelay(context({ [HOSTED_MCP_RELAY_HEADER]: proof }) as any)).toBe(true)
    expect(await isHostedMcpBuildStatusRelay(context({ [HOSTED_MCP_RELAY_HEADER]: 'deadbeef' }) as any)).toBe(false)
  })
})

describe('shouldPersistBuildStatus', () => {
  it.concurrent('defaults to persisting', () => {
    expect(shouldPersistBuildStatus({})).toBe(true)
    expect(shouldPersistBuildStatus({ persist: true })).toBe(true)
    expect(shouldPersistBuildStatus({ persist: 'true' })).toBe(true)
  })

  it.concurrent('ignores persist=false from non-MCP callers', () => {
    expect(shouldPersistBuildStatus({ persist: false })).toBe(true)
    expect(shouldPersistBuildStatus({ persist: 'false' })).toBe(true)
    expect(shouldPersistBuildStatus({ persist: false }, { hostedMcp: false })).toBe(true)
  })

  it.concurrent('allows persist=false only on the hosted MCP relay', () => {
    expect(shouldPersistBuildStatus({ persist: 'false' }, { hostedMcp: true })).toBe(false)
  })
})

describe('build status Builder checklist persistence', () => {
  it('runs after the CAS winner without changing the endpoint response', async () => {
    const c = context()
    const response = await getBuildStatus(c, { job_id: jobId, app_id: appId, platform: 'ios' }, { key: 'api-key' } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ job_id: jobId, status: 'succeeded', persisted: true })
    expect(mocks.checklist).toHaveBeenCalledWith(c, { appId, platform: 'ios', status: 'succeeded' })
  })

  it('does not run when the CAS update loses its race', async () => {
    configureCas([])
    const response = await getBuildStatus(context(), { job_id: jobId, app_id: appId, platform: 'ios' }, { key: 'api-key' } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ persisted: false })
    expect(mocks.checklist).not.toHaveBeenCalled()
  })

  it('still persists when persist=false is not from the MCP relay', async () => {
    await getBuildStatus(context(), { job_id: jobId, app_id: appId, platform: 'ios', persist: 'false' }, { key: 'api-key' } as any)
    expect(mocks.adminQuery).toHaveBeenCalled()
  })

  it('skips DB sync, billing and checklist when MCP relay sets persist=false', async () => {
    const response = await getBuildStatus(
      context({ [HOSTED_MCP_RELAY_HEADER]: hostedMcpRelayProof(API_SECRET) }),
      { job_id: jobId, app_id: appId, platform: 'ios', persist: 'false' },
      { key: 'api-key' } as any,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ job_id: jobId, status: 'succeeded', persisted: false })
    expect(mocks.adminQuery).not.toHaveBeenCalled()
    expect(mocks.checklist).not.toHaveBeenCalled()
    expect(mocks.emit).not.toHaveBeenCalled()
    expect(mocks.recordBuildTime).not.toHaveBeenCalled()
  })

  it('does not cancel a timed-out build when MCP read-only polling', async () => {
    const startedAt = Date.now() - 901_000
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/cancel'))
        throw new Error('unexpected_builder_cancel')
      return new Response(JSON.stringify({
        job: { status: 'running', started_at: startedAt, completed_at: null, error: null },
        machine: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const response = await getBuildStatus(
      context({ [HOSTED_MCP_RELAY_HEADER]: hostedMcpRelayProof(API_SECRET) }),
      { job_id: jobId, app_id: appId, platform: 'ios', persist: 'false' },
      { key: 'api-key' } as any,
    )
    expect(response.status).toBe(200)
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)
    expect(urls.some(entry => entry.includes('/cancel'))).toBe(false)
  })
})
