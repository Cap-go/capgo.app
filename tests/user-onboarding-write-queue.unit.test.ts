import { describe, expect, it } from 'vitest'
import { serializeUserOnboardingWrite } from '../src/services/userOnboardingWriteQueue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('user onboarding write queue', () => {
  it.concurrent('serializes writes for the same user', async () => {
    const firstWrite = deferred()
    const events: string[] = []

    const first = serializeUserOnboardingWrite('admin-1', async () => {
      events.push('first:start')
      await firstWrite.promise
      events.push('first:end')
    })
    const second = serializeUserOnboardingWrite('admin-1', async () => {
      events.push('second:start')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    firstWrite.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it.concurrent('continues the queue after a failed write', async () => {
    const first = serializeUserOnboardingWrite('admin-2', async () => {
      throw new Error('write failed')
    })
    const second = serializeUserOnboardingWrite('admin-2', async () => 'persisted')

    await expect(first).rejects.toThrow('write failed')
    await expect(second).resolves.toBe('persisted')
  })

  it.concurrent('does not block writes for different users', async () => {
    const firstWrite = deferred()
    const first = serializeUserOnboardingWrite('admin-3', async () => firstWrite.promise)
    const second = serializeUserOnboardingWrite('admin-4', async () => 'persisted')

    await expect(second).resolves.toBe('persisted')
    firstWrite.resolve()
    await first
  })
})
