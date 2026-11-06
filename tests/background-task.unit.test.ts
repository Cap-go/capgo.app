import { afterEach, describe, expect, it, vi } from 'vitest'
import { backgroundTask, WAIT_FOR_COMPLETION_HEADER } from '../supabase/functions/_backend/utils/utils.ts'

const runtimeKey = vi.hoisted(() => ({ value: 'node' }))

vi.mock('hono/adapter', async importOriginal => ({
  ...(await importOriginal<typeof import('hono/adapter')>()),
  getRuntimeKey: () => runtimeKey.value,
}))

interface EdgeRuntimeLike {
  waitUntil?: (promise: Promise<unknown>) => void
}

const runtime = globalThis as typeof globalThis & { EdgeRuntime?: EdgeRuntimeLike }
const originalEdgeRuntime = runtime.EdgeRuntime

function createContext({ apiSecret, completionHeader = false, executionCtx }: {
  apiSecret?: string
  completionHeader?: boolean
  executionCtx?: { waitUntil: (promise: Promise<unknown>) => void }
} = {}) {
  return {
    env: {},
    get(key: string) {
      return key === 'APISecret' ? apiSecret : undefined
    },
    req: {
      header(key: string) {
        return completionHeader && key === WAIT_FOR_COMPLETION_HEADER ? 'true' : undefined
      },
    },
    get executionCtx() {
      if (!executionCtx)
        throw new Error('This context has no ExecutionContext')
      return executionCtx
    },
  } as any
}

afterEach(() => {
  runtimeKey.value = 'node'
  if (originalEdgeRuntime === undefined)
    delete runtime.EdgeRuntime
  else
    runtime.EdgeRuntime = originalEdgeRuntime
})

async function expectAwaited(result: unknown, task: Promise<unknown>) {
  expect(result).toBe(task)
  await expect(result).resolves.toBe('completed')
}

describe('backgroundTask on Supabase Edge Runtime', () => {
  it.each([
    ['the EdgeRuntime global is absent', undefined],
    ['EdgeRuntime has no waitUntil hook', {}],
  ])('awaits the task when %s', async (_label, edgeRuntime) => {
    if (edgeRuntime === undefined)
      delete runtime.EdgeRuntime
    else
      runtime.EdgeRuntime = edgeRuntime
    const task = Promise.resolve('completed')

    await expectAwaited(backgroundTask(createContext({ completionHeader: true }), task), task)
  })

  it('keeps an untrusted completion header in the background', async () => {
    const waitUntil = vi.fn()
    runtime.EdgeRuntime = { waitUntil }
    const task = Promise.resolve('completed')

    const result = backgroundTask(createContext({ completionHeader: true }), task)

    await expect(result).resolves.toBeNull()
    expect(waitUntil).toHaveBeenCalledWith(task)
  })

  it('awaits a completion header only after internal secret validation', async () => {
    const waitUntil = vi.fn()
    runtime.EdgeRuntime = { waitUntil }
    const task = Promise.resolve('completed')

    await expectAwaited(backgroundTask(createContext({ apiSecret: 'verified-secret', completionHeader: true }), task), task)
    expect(waitUntil).not.toHaveBeenCalled()
  })
})

describe('backgroundTask on workerd', () => {
  it('uses waitUntil when the context has an ExecutionContext', async () => {
    runtimeKey.value = 'workerd'
    const waitUntil = vi.fn()
    const task = Promise.resolve('completed')

    const result = backgroundTask(createContext({ executionCtx: { waitUntil } }), task)

    await expect(result).resolves.toBeNull()
    expect(waitUntil).toHaveBeenCalledWith(task)
  })

  it('returns the task instead of throwing when no ExecutionContext exists (Durable Object router)', async () => {
    runtimeKey.value = 'workerd'
    const task = Promise.resolve('completed')

    await expectAwaited(backgroundTask(createContext(), task), task)
  })
})
