import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { post } from '../supabase/functions/_backend/public/app/post.ts'

const mocks = vi.hoisted(() => ({ assignment: vi.fn(), connect: vi.fn(), query: vi.fn(), close: vi.fn(), order: [] as string[] }))
vi.mock('../supabase/functions/_backend/utils/ab_tests.ts', () => ({ getOrCreateUserABTests: mocks.assignment }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: mocks.connect, closeClient: mocks.close, logPgError: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: async () => true }))
vi.mock('../supabase/functions/_backend/utils/app_creator.ts', () => ({ addAppCreatorToOnboarding: () => ({}), resolveAppCreatorEmail: () => 'test@example.com' }))
vi.mock('../supabase/functions/_backend/utils/storage.ts', () => ({ createSignedImageUrl: vi.fn(), getStorageAllowedOrigins: vi.fn(), resolveWritableImageValue: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ isValidAppId: () => true }))

const body = { app_id: 'com.test.abassignment', name: 'Assignment test', owner_org: 'org-id' }
const context = {
  get: () => ({ userId: 'user-id', claims: { email: 'test@example.com' } }),
  json: (value: unknown) => Response.json(value),
} as unknown as Context<MiddlewareKeyVariables>

describe('app creation A/B assignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order = []
    mocks.assignment.mockImplementation(async () => mocks.order.push('assignment'))
    mocks.connect.mockImplementation(() => {
      mocks.order.push('connection')
      return { query: mocks.query }
    })
    mocks.query.mockImplementation(async () => {
      mocks.order.push('insert')
      return { rows: [{ ...body, icon_url: '' }] }
    })
  })

  it('preserves the assignment HTTP error and never opens an app connection', async () => {
    const error = new HTTPException(404, { message: 'User not found', cause: { error: 'user_not_found' } })
    mocks.assignment.mockRejectedValue(error)
    await expect(post(context, body)).rejects.toBe(error)
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('assigns the experiment before opening the app connection and inserting', async () => {
    const response = await post(context, body)
    expect(response.status).toBe(200)
    expect(mocks.order).toEqual(['assignment', 'connection', 'insert'])
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })
})
