import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'

const checkPermissionMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => {
  const actual = await vi.importActual<typeof import('../supabase/functions/_backend/utils/utils.ts')>('../supabase/functions/_backend/utils/utils.ts')
  return {
    ...actual,
    getEnv: (_c: unknown, key: string) => {
      if (key === 'BUMP_LEVEL_MODEL')
        return ''
      return ''
    },
    isValidAppId: (appId: string) => typeof appId === 'string' && appId.includes('.'),
  }
})

const { aiBumpLevel } = await import('../supabase/functions/_backend/public/bundle/ai_bump_level.ts')

const apikey = {
  key: 'test-apikey',
  user_id: 'user-1',
} as any

function createContext(ai?: { run: ReturnType<typeof vi.fn> }) {
  return {
    env: { AI: ai },
    get: vi.fn((key: string) => key === 'requestId' ? 'req-1' : undefined),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<MiddlewareKeyVariables>
}

const validBody = {
  appId: 'com.example.app',
  baseVersion: '1.2.3',
  manifestDiff: {
    added: ['new.js'],
    removed: [],
    changed: ['index.js'],
    counts: { added: 1, removed: 0, changed: 1 },
  },
}

describe('bundle ai_bump_level', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkPermissionMock.mockResolvedValue(true)
  })

  it('rejects when upload permission is denied', async () => {
    checkPermissionMock.mockResolvedValue(false)
    const error = await aiBumpLevel(createContext({ run: vi.fn() }), validBody, apikey).catch(caught => caught)
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(400)
    expect(error.message).toContain('You can\'t access this app')
    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'app.upload_bundle', { appId: 'com.example.app' })
  })

  it('returns 503 when Workers AI binding is missing', async () => {
    const error = await aiBumpLevel(createContext(undefined), validBody, apikey).catch(caught => caught)
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(503)
    expect(error.cause.error).toBe('ai_unavailable')
  })

  it('rejects invalid body without appId', async () => {
    const error = await aiBumpLevel(createContext({ run: vi.fn() }), {
      baseVersion: '1.0.0',
      manifestDiff: { added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0 } },
    }, apikey).catch(caught => caught)
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(400)
    expect(error.cause.error).toBe('missing_app_id')
  })

  it('returns level and reason on happy path', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      level: 'minor',
      reason: 'Added feature files',
    }))
    const response = await aiBumpLevel(createContext({ run }), validBody, apikey)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      level: 'minor',
      reason: 'Added feature files',
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('@cf/moonshotai/kimi-k2.6')
  })

  it('returns 502 when AI returns an invalid level', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      level: 'mega',
      reason: 'bad',
    }))
    const error = await aiBumpLevel(createContext({ run }), validBody, apikey).catch(caught => caught)
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(502)
    expect(error.cause.error).toBe('ai_invalid_response')
  })
})
