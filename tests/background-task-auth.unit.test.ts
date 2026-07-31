import { afterEach, describe, expect, it, vi } from 'vitest'
import { backgroundTask, WAIT_FOR_COMPLETION_HEADER } from '../supabase/functions/_backend/utils/utils.ts'

type EdgeRuntimeLike = {
  waitUntil?: (promise: Promise<unknown>) => void
}

const runtime = globalThis as typeof globalThis & { EdgeRuntime?: EdgeRuntimeLike }
const originalEdgeRuntime = runtime.EdgeRuntime

function createContext(apiSecret?: string) {
  return {
    env: {},
    get(key: string) {
      return key === 'APISecret' ? apiSecret : undefined
    },
    req: {
      header(key: string) {
        return key === WAIT_FOR_COMPLETION_HEADER ? 'true' : undefined
      },
    },
  } as any
}

afterEach(() => {
  if (originalEdgeRuntime === undefined)
    delete runtime.EdgeRuntime
  else
    runtime.EdgeRuntime = originalEdgeRuntime
})

describe('background task completion header', () => {
  it('keeps an untrusted completion header in the background', async () => {
    const waitUntil = vi.fn()
    runtime.EdgeRuntime = { waitUntil }
    const task = Promise.resolve('completed')

    const result = backgroundTask(createContext(), task)

    await expect(result).resolves.toBeNull()
    expect(waitUntil).toHaveBeenCalledWith(task)
  })

  it('awaits a completion header only after internal secret validation', async () => {
    const waitUntil = vi.fn()
    runtime.EdgeRuntime = { waitUntil }
    const task = Promise.resolve('completed')

    const result = backgroundTask(createContext('verified-secret'), task)

    expect(result).toBe(task)
    await expect(result).resolves.toBe('completed')
    expect(waitUntil).not.toHaveBeenCalled()
  })
})
