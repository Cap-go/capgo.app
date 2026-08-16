import type { UserOnboardingStatus } from './userOnboardingProgress'

export type OnboardingPersistResult = 'persisted' | 'retryable_failure' | 'conflict' | 'skipped'

export interface OnboardingPersistOptions {
  allowDisposed?: boolean
}

interface CreateOnboardingProgressPersistenceOptions {
  onError?: (error: unknown) => void
  write: (
    status: UserOnboardingStatus,
    options: OnboardingPersistOptions,
  ) => OnboardingPersistResult | Promise<OnboardingPersistResult>
}

interface OnboardingProgressTrackingInitializationState {
  aborted: boolean
  disposed: boolean
}

export function createOnboardingProgressPersistence(options: CreateOnboardingProgressPersistenceOptions) {
  let chain: Promise<OnboardingPersistResult> = Promise.resolve('persisted')
  let aborted = false
  let blocked = false

  function shouldSkip(status: UserOnboardingStatus) {
    return aborted || (blocked && status !== 'completed')
  }

  function persist(
    status: UserOnboardingStatus = 'in_progress',
    writeOptions: OnboardingPersistOptions = {},
  ) {
    if (shouldSkip(status))
      return Promise.resolve<OnboardingPersistResult>('skipped')

    chain = chain.then(async () => {
      if (shouldSkip(status))
        return 'skipped'

      try {
        const result = await options.write(status, writeOptions)
        if (result === 'conflict')
          blocked = true
        return result
      }
      catch (error) {
        try {
          options.onError?.(error)
        }
        catch {
          // Persistence failures must not poison later queue work.
        }
        return 'retryable_failure'
      }
    })
    return chain
  }

  return {
    abort() {
      aborted = true
    },
    isAborted: () => aborted,
    isBlocked: () => blocked,
    persist,
  }
}

export function shouldInitializeOnboardingProgressTracking(
  result: OnboardingPersistResult,
  state: OnboardingProgressTrackingInitializationState,
) {
  return !state.aborted
    && !state.disposed
    && (result === 'persisted' || result === 'retryable_failure')
}
