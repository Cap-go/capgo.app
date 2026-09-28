import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuildStatus } from '../supabase/functions/_backend/public/build/status.ts'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  apikey: vi.fn(),
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
  supabaseAdmin: mocks.admin,
  supabaseApikey: mocks.apikey,
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => key === 'BUILDER_URL' ? 'https://builder.test' : key === 'BUILDER_API_KEY' ? 'builder-key' : '',
}))

const appId = 'com.test.status-checklist'
const jobId = 'builder-job'

function context() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  } as any
}

function configureCas(data: Array<{ id: string }>) {
  const update = {
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({ data, error: null }),
  }
  mocks.admin.mockReturnValue({ from: vi.fn().mockReturnValue({ update: vi.fn().mockReturnValue(update) }) })
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
  mocks.apikey.mockReturnValue({
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'build_requests') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: buildRequest, error: null }),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { app_id: appId, build_timeout_seconds: 900, build_timeout_updated_at: new Date().toISOString() },
            error: null,
          }),
        }),
      }
    }),
  })
  configureCas([{ id: 'row-id' }])
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    job: { status: 'succeeded', started_at: null, completed_at: null, error: null },
    machine: null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
})

describe('build status Builder checklist persistence', () => {
  it('runs after the CAS winner without changing the endpoint response', async () => {
    const c = context()
    const response = await getBuildStatus(c, { job_id: jobId, app_id: appId, platform: 'ios' }, { key: 'api-key' } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ job_id: jobId, status: 'succeeded' })
    expect(mocks.checklist).toHaveBeenCalledWith(c, { appId, platform: 'ios', status: 'succeeded' })
  })

  it('does not run when the CAS update loses its race', async () => {
    configureCas([])
    const response = await getBuildStatus(context(), { job_id: jobId, app_id: appId, platform: 'ios' }, { key: 'api-key' } as any)

    expect(response.status).toBe(200)
    expect(mocks.checklist).not.toHaveBeenCalled()
  })
})
