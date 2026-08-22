import { describe, expect, it } from 'vitest'
import { preserveUserBentoEvents, serializeUserOnboardingWrite } from '../src/services/userOnboardingWriteQueue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('user onboarding write queue', () => {
  it.concurrent('preserves backend Bento event state while applying the next progress snapshot', () => {
    const current = {
      status: 'in_progress',
      bento_events: {
        'cli:command_invoked': {
          details: [{ observed_at: '2026-08-22T10:00:00.000Z' }],
          occurrence_count: 1,
          sent_at: '2026-08-22T10:00:01.000Z',
        },
      },
    }
    const next = { status: 'completed', step: 'setup' }

    expect(preserveUserBentoEvents(next, current)).toEqual({
      ...next,
      bento_events: current.bento_events,
    })
  })

  it.concurrent.each([
    ['null', null],
    ['array', ['not', 'an', 'object'] as string[]],
    ['string', 'not an object'],
    ['number', 42],
    ['boolean', false],
  ] as const)('ignores a malformed %s backend Bento event value', (_label, bentoEvents) => {
    const next = { status: 'completed' }

    expect(preserveUserBentoEvents({ ...next }, { bento_events: bentoEvents })).toEqual(next)
  })

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
