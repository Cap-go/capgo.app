import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ permission: vi.fn(), paid: vi.fn(), query: vi.fn(), metadata: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/plan-gating.ts', () => ({ requirePaidPlan: mocks.paid }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: async () => ({ query: mocks.query }), closeClient: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({ apikeyPrincipal: vi.fn(), withRlsContext: mocks.metadata }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ getEnv: () => '', isValidAppId: (s: string) => s.includes('.') }))
const { recommendRelease, parseRecommendation } = await import('../supabase/functions/_backend/public/bundle/recommend.ts')
const input = { appId: 'com.example.release', context: { source: 'local', commits: 'fix: typo', changes: 'index.ts', tags: '1.2.3', truncated: false } }
const result = { nextVersion: '1.2.4', level: 'patch', reason: 'Corrects a typo', changelog: '' }
function context(run: ReturnType<typeof vi.fn>) {
  return { env: { AI: { run } }, get: vi.fn(), header: vi.fn(), json: (v: unknown) => Response.json(v) } as any
}
const key = { key: 'fake-key' } as any
beforeEach(() => {
  vi.clearAllMocks()
  mocks.permission.mockResolvedValue(true)
  mocks.paid.mockResolvedValue(undefined)
  mocks.query.mockResolvedValue({ rows: [] })
  mocks.metadata.mockResolvedValue({ orgId: '00000000-0000-4000-8000-000000000001', history: [{ name: '1.2.3' }] })
})

describe('paid release recommendations', () => {
  it('denies scoped keys before reading metadata or spending AI', async () => {
    mocks.permission.mockResolvedValue(false)
    const run = vi.fn()
    await expect(recommendRelease(context(run), input, key)).rejects.toMatchObject({ status: 403 })
    expect(mocks.metadata).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
  it('denies unpaid users without recording an inference', async () => {
    mocks.paid.mockRejectedValue(new Error('paid required'))
    const run = vi.fn()
    await expect(recommendRelease(context(run), input, key)).rejects.toThrow('paid required')
    expect(mocks.query).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
  it('records the attempt before inference and success after validation', async () => {
    const run = vi.fn(async () => {
      expect(mocks.query.mock.calls[0][0]).toContain('INSERT INTO public.ai_release_usage_daily')
      return { choices: [{ message: { content: JSON.stringify(result) } }] }
    })
    const response = await recommendRelease(context(run), input, key)
    expect(await response.json()).toMatchObject({ nextVersion: '1.2.4', baseVersion: '1.2.3' })
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('successes = successes + 1')
    expect(run.mock.calls).toHaveLength(1)
  })
  it('does not call AI if durable accounting fails', async () => {
    mocks.query.mockRejectedValue(new Error('db down'))
    const run = vi.fn()
    await expect(recommendRelease(context(run), input, key)).rejects.toThrow('db down')
    expect(run).not.toHaveBeenCalled()
  })
  it('counts provider failures and does not retry or return provider secrets', async () => {
    const run = vi.fn().mockRejectedValue(new Error('private prompt'))
    await expect(recommendRelease(context(run), input, key)).rejects.toMatchObject({ status: 502 })
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('failures = failures + 1')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('rejects occupied names including deleted versions', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT 1') ? [{}] : [] }))
    await expect(recommendRelease(context(vi.fn().mockResolvedValue(result)), input, key)).rejects.toMatchObject({ status: 502 })
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('failures = failures + 1')
  })
  it('rejects oversized input before authorization', async () => {
    await expect(recommendRelease(context(vi.fn()), { ...input, context: { ...input.context, commits: 'x'.repeat(16001) } }, key)).rejects.toMatchObject({ status: 400 })
    expect(mocks.permission).not.toHaveBeenCalled()
  })
  it.each(['1.2.3', '1.1.9', 'not-semver', '1.2.3+metadata'])('rejects non-increasing semver %s', (nextVersion) => {
    expect(() => parseRecommendation({ ...result, nextVersion }, '1.2.3', false)).toThrow()
  })
  it('preserves prerelease naming and requires requested changelog text', () => {
    expect(parseRecommendation({ ...result, nextVersion: '1.3.0-beta.2', level: 'prerelease' }, '1.3.0-beta.1', false).nextVersion).toBe('1.3.0-beta.2')
    expect(() => parseRecommendation(result, '1.2.3', true)).toThrow()
    expect(parseRecommendation({ ...result, changelog: '- Fixed typo' }, '1.2.3', true).changelog).toBe('- Fixed typo')
  })
})
