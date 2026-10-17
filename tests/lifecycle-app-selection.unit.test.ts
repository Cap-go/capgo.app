import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lifecycleAppSelection } from '../src/utils/lifecycleAppSelection'
import { selectLifecycleApp } from '../supabase/functions/_backend/utils/lifecycle_v2_context.ts'

const mocks = vi.hoisted(() => ({ get: vi.fn(), query: vi.fn(), close: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: mocks.get, closeClient: mocks.close }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn() }))
const id = '11111111-1111-4111-8111-111111111111'
const org = '22222222-2222-4222-8222-222222222222'
const app = { id, app_id: 'com.example.selection', owner_org: org, onboarding: { setup: { todo_list_version: 4, paths: ['ota'], selected_path: 'ota' } } }
describe('lifecycle app context selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockResolvedValue({ query: mocks.query })
    mocks.query.mockResolvedValue({ rowCount: 1 })
  })
  it('sends only app/product incarnation identity and org scope through authenticated tracking', () => {
    expect(lifecycleAppSelection(app)).toEqual({ event: 'Lifecycle App Selected', channel: 'app-onboarding', tracking_version: 2, org_id: org, tags: { app_id: app.app_id, app_incarnation: id, product: 'ota' } })
    expect(lifecycleAppSelection({ ...app, id: null })).toBeNull()
    expect(lifecycleAppSelection({ ...app, onboarding: {} })).toBeNull()
  })
  it('fences a selection by verified org, current app incarnation and enabled product without awarding progress', async () => {
    expect(await selectLifecycleApp({ get: () => 'test' } as any, org, app.app_id, id, 'ota')).toBe(true)
    const [sql, values] = mocks.query.mock.calls[0]
    expect(values).toEqual([org, app.app_id, id, 'ota'])
    expect(sql).toContain('a.id = $3::uuid')
    expect(sql).toContain('a.owner_org = j.org_id')
    expect(sql).toContain('acknowledged_before = CURRENT_TIMESTAMP')
    expect(sql).not.toContain('lastProgressAt')
    expect(sql).not.toContain('SET state')
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('ignores malformed identities and stale or unsupported selection without a new fact', async () => {
    expect(await selectLifecycleApp({} as any, org, app.app_id, 'deleted-incarnation', 'ota')).toBe(false)
    expect(await selectLifecycleApp({} as any, org, app.app_id, id, 'exploring')).toBe(false)
    expect(mocks.query).not.toHaveBeenCalled()
    mocks.query.mockResolvedValue({ rowCount: 0 })
    expect(await selectLifecycleApp({} as any, org, app.app_id, id, 'ota')).toBe(false)
  })
  it('keeps connection acquisition failure from failing an otherwise accepted tracking request', async () => {
    mocks.get.mockRejectedValueOnce(new Error('connection unavailable'))
    expect(await selectLifecycleApp({ get: () => 'test' } as any, org, app.app_id, id, 'ota')).toBe(false)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('releases an acquired client after a query failure', async () => {
    mocks.query.mockRejectedValueOnce(new Error('query unavailable'))
    expect(await selectLifecycleApp({ get: () => 'test' } as any, org, app.app_id, id, 'ota')).toBe(false)
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
