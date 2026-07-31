import { describe, expect, it, vi } from 'vitest'

const { middlewareKeyMock, middlewareByOptions } = vi.hoisted(() => {
  const middlewareByOptions = new Map<string, unknown>()
  const middlewareKeyMock = vi.fn((...options: unknown[]) => {
    const middleware = async (_c: unknown, next: () => Promise<void>) => {
      await next()
    }
    middlewareByOptions.set(JSON.stringify(options), middleware)
    return middleware
  })

  return { middlewareKeyMock, middlewareByOptions }
})

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: middlewareKeyMock,
}))

const { app } = await import('../supabase/functions/_backend/public/bundle/index.ts')

type RootMethod = 'DELETE' | 'GET' | 'POST' | 'PUT'

function rootMiddleware(method: RootMethod) {
  const route = app.routes.find(route => route.method === method && route.path === '/')
  if (!route)
    throw new Error(`Missing root ${method} bundle route`)
  return route.handler
}

function middlewareFor(...options: unknown[]) {
  const middleware = middlewareByOptions.get(JSON.stringify(options))
  if (!middleware)
    throw new Error(`Missing middlewareKey call for ${JSON.stringify(options)}`)
  return middleware
}

describe('root bundle route middleware', () => {
  it('uses direct-primary auth for mutations while retaining the GET defaults', () => {
    const writeOptions = { usePostgres: true, readOnly: false }

    expect(middlewareKeyMock).toHaveBeenCalledWith()
    expect(middlewareKeyMock).toHaveBeenCalledWith(writeOptions)

    expect(rootMiddleware('GET')).toBe(middlewareFor())
    expect(rootMiddleware('DELETE')).toBe(middlewareFor(writeOptions))
    expect(rootMiddleware('PUT')).toBe(middlewareFor(writeOptions))
    expect(rootMiddleware('POST')).toBe(middlewareFor(writeOptions))
  })
})
