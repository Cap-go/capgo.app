import { describe, expect, it, vi } from 'vitest'
import {
  createOnboardingProgressPersistence,
  shouldInitializeOnboardingProgressTracking,
} from '../src/utils/onboardingProgressPersistence'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('onboarding progress persistence', () => {
  it('skips every status when aborted before enqueue', async () => {
    const write = vi.fn(() => Promise.resolve('persisted' as const))
    const persistence = createOnboardingProgressPersistence({ write })

    persistence.abort()

    await expect(persistence.persist()).resolves.toBe('skipped')
    await expect(persistence.persist('completed')).resolves.toBe('skipped')
    expect(write).not.toHaveBeenCalled()
    expect(persistence.isAborted()).toBe(true)
  })

  it('lets an in-flight write finish but skips queued and later writes after abort', async () => {
    const firstWrite = deferred<'persisted'>()
    const writeStarted = deferred<void>()
    const write = vi.fn(() => {
      writeStarted.resolve()
      return firstWrite.promise
    })
    const persistence = createOnboardingProgressPersistence({ write })

    const inFlight = persistence.persist()
    await writeStarted.promise
    const queued = persistence.persist()
    persistence.abort()
    const laterCompleted = persistence.persist('completed')
    firstWrite.resolve('persisted')

    await expect(inFlight).resolves.toBe('persisted')
    await expect(queued).resolves.toBe('skipped')
    await expect(laterCompleted).resolves.toBe('skipped')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('activates the conflict barrier before queued and later nonterminal writes run', async () => {
    const firstWrite = deferred<'conflict'>()
    const writeStarted = deferred<void>()
    const write = vi.fn(() => {
      writeStarted.resolve()
      return firstWrite.promise
    })
    const persistence = createOnboardingProgressPersistence({ write })

    const inFlight = persistence.persist()
    await writeStarted.promise
    const queued = persistence.persist()
    firstWrite.resolve('conflict')

    await expect(inFlight).resolves.toBe('conflict')
    await expect(queued).resolves.toBe('skipped')
    await expect(persistence.persist()).resolves.toBe('skipped')
    expect(persistence.isBlocked()).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('allows completed through a conflict barrier but not through abort', async () => {
    const write = vi.fn()
      .mockResolvedValueOnce('conflict')
      .mockResolvedValueOnce('persisted')
    const persistence = createOnboardingProgressPersistence({ write })

    await expect(persistence.persist()).resolves.toBe('conflict')
    await expect(persistence.persist('completed')).resolves.toBe('persisted')
    persistence.abort()
    await expect(persistence.persist('completed')).resolves.toBe('skipped')

    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(2, 'completed')
  })

  it('turns a rejected write into a retryable failure without poisoning later queue work', async () => {
    const failure = new Error('network unavailable')
    const rejectedWrite = deferred<'persisted'>()
    const writeStarted = deferred<void>()
    const write = vi.fn()
      .mockImplementationOnce(() => {
        writeStarted.resolve()
        return rejectedWrite.promise
      })
      .mockResolvedValueOnce('persisted')
    const onError = vi.fn()
    const persistence = createOnboardingProgressPersistence({ write, onError })

    const first = persistence.persist()
    await writeStarted.promise
    const queued = persistence.persist()
    rejectedWrite.reject(failure)

    await expect(first).resolves.toBe('retryable_failure')
    await expect(queued).resolves.toBe('persisted')
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(failure)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('keeps queue work retryable when both the writer and onError throw', async () => {
    const failure = new Error('write crashed')
    const errorHandlerFailure = new Error('error handler crashed')
    const write = vi.fn()
      .mockImplementationOnce(() => {
        throw failure
      })
      .mockResolvedValueOnce('persisted')
    const onError = vi.fn(() => {
      throw errorHandlerFailure
    })
    const persistence = createOnboardingProgressPersistence({ write, onError })

    const first = persistence.persist()
    const queued = persistence.persist()

    await expect(first).resolves.toBe('retryable_failure')
    await expect(queued).resolves.toBe('persisted')
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(failure)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['persisted', false, false, true],
    ['retryable_failure', false, false, true],
    ['skipped', false, false, false],
    ['conflict', false, false, false],
    ['persisted', true, false, false],
    ['retryable_failure', false, true, false],
  ] as const)(
    'initializes for %s with aborted=%s and disposed=%s only when persistence is confirmed or retryable',
    (result, aborted, disposed, expected) => {
      expect(shouldInitializeOnboardingProgressTracking(result, { aborted, disposed })).toBe(expected)
    },
  )
})
