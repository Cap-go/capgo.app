import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const API_SECRET = 'testsecret'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  checklist: vi.fn(),
  cloudlogErr: vi.fn(),
  emit: vi.fn(),
  recordBuildTime: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/builder_onboarding_checklist.ts', () => ({ persistBuilderBuildOutcome: mocks.checklist }))
vi.mock('../supabase/functions/_backend/utils/build_tracking.ts', () => ({ emitBuildTransitionEvent: mocks.emit }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: mocks.cloudlogErr }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  recordBuildTime: mocks.recordBuildTime,
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getPgClient: vi.fn(async () => ({ query: mocks.query })),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => ({ API_SECRET, BUILDER_URL: 'https://builder.test', BUILDER_API_KEY: 'builder-key' } as Record<string, string>)[key] ?? '',
}))
const HOUR = 60 * 60 * 1000

function staleBuild(id: string, createdAt: number) {
  return {
    id,
    builder_job_id: `job-${id}`,
    app_id: 'com.test.reconcile',
    owner_org: '11111111-1111-4111-8111-111111111111',
    requested_by: '22222222-2222-4222-8222-222222222222',
    platform: 'ios',
    build_mode: 'release',
    status: 'running',
    created_at: new Date(createdAt).toISOString(),
  }
}

function configureSupabase(builds: ReturnType<typeof staleBuild>[]) {
  const updates: Array<{ id: string, values: Record<string, unknown> }> = []
  mocks.query.mockImplementation(async (text: string, values: unknown[] = []) => {
    if (text.includes('FROM public.apps'))
      return { rows: [] }
    if (text.includes('FROM public.build_requests'))
      return { rows: builds.map(row => ({ row })) }
    if (text.includes('UPDATE public.build_requests')) {
      const id = values[0] as string
      updates.push({ id, values: { status: values[2], last_error: values[3] } })
      return { rows: [{ id }] }
    }
    throw new Error(`Unexpected query ${text}`)
  })
  return updates
}

async function runReconcile() {
  const { app } = await import('../supabase/functions/_backend/triggers/cron_reconcile_build_status.ts')
  return await app.request('http://local/', { method: 'POST', headers: { apisecret: API_SECRET } })
}

describe('cron_reconcile_build_status', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.checklist.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('settles old builds whose builder job no longer exists instead of retrying forever', async () => {
    const updates = configureSupabase([staleBuild('purged', Date.now() - 48 * HOUR)])
    const bodies: Response[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = new Response(JSON.stringify({ error: 'job not found' }), { status: 500 })
      bodies.push(response)
      return response
    })

    const response = await runReconcile()

    expect(response.status).toBe(200)
    expect(updates).toEqual([{ id: 'purged', values: expect.objectContaining({ status: 'failed', last_error: 'Build job no longer exists in builder' }) }])
    expect(mocks.checklist).toHaveBeenCalledWith(expect.anything(), { appId: 'com.test.reconcile', platform: 'ios', status: 'failed' })
    expect(mocks.cloudlogErr).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Error reconciling build' }))
    // Error bodies must be consumed so Workers does not cancel them as stalled.
    expect(bodies.every(body => body.bodyUsed)).toBe(true)
  })

  it('tells the builder a timed-out build is stopped for its build time limit, not by a user', async () => {
    configureSupabase([staleBuild('slow', Date.now() - HOUR)])
    const cancels: Array<{ url: string, body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/cancel')) {
        cancels.push({ url, body: String(init?.body) })
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ job: { status: 'running', started_at: Date.now() - HOUR, completed_at: null } }), { status: 200 })
    })

    await runReconcile()

    expect(cancels).toEqual([{ url: 'https://builder.test/jobs/job-slow/cancel', body: JSON.stringify({ reason: 'timeout' }) }])
  })

  it('keeps retrying recent missing jobs and other builder errors, draining their bodies', async () => {
    const updates = configureSupabase([
      staleBuild('recent', Date.now() - 10 * 60 * 1000),
      staleBuild('builder-down', Date.now() - 48 * HOUR),
    ])
    const bodies: Response[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const response = String(input).includes('job-recent')
        ? new Response(JSON.stringify({ error: 'job not found' }), { status: 500 })
        : new Response('upstream exploded', { status: 500 })
      bodies.push(response)
      return response
    })

    const response = await runReconcile()

    expect(response.status).toBe(200)
    expect(updates).toEqual([])
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'Error reconciling build', buildId: 'recent' }))
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Error reconciling build',
      buildId: 'builder-down',
      error: 'Error: Builder status fetch failed: 500 upstream exploded',
    }))
    expect(bodies.every(body => body.bodyUsed)).toBe(true)
  })
})
