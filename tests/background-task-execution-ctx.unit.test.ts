import { describe, expect, it, vi } from 'vitest'
import { backgroundTask } from '../supabase/functions/_backend/utils/utils.ts'

vi.mock('hono/adapter', async importOriginal => ({
  ...(await importOriginal<typeof import('hono/adapter')>()),
  getRuntimeKey: () => 'workerd',
}))

function createContext(executionCtx?: { waitUntil: (promise: Promise<unknown>) => void }) {
  return {
    env: {},
    get: () => undefined,
    req: { header: () => undefined },
    get executionCtx() {
      if (!executionCtx)
        throw new Error('This context has no ExecutionContext')
      return executionCtx
    },
  } as any
}

describe('background task execution context', () => {
  it('uses waitUntil when the workerd context has an ExecutionContext', async () => {
    const waitUntil = vi.fn()
    const task = Promise.resolve('completed')

    const result = backgroundTask(createContext({ waitUntil }), task)

    await expect(result).resolves.toBeNull()
    expect(waitUntil).toHaveBeenCalledWith(task)
  })

  it('returns the task instead of throwing when no ExecutionContext exists (Durable Object router)', async () => {
    const task = Promise.resolve('completed')

    const result = backgroundTask(createContext(), task)

    expect(result).toBe(task)
    await expect(result).resolves.toBe('completed')
  })
})
