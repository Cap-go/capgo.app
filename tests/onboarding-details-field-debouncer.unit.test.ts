import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOnboardingDetailsFieldDebouncer } from '../src/utils/onboardingProgressAnalytics'

describe('onboarding details field analytics debounce', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the latest non-empty value one second after the last keystroke', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const tracker = createOnboardingDetailsFieldDebouncer(emit)

    tracker.schedule('onboarding_app_name_entered', 'app_name', 'app_name', 'Example')
    vi.advanceTimersByTime(750)
    tracker.schedule('onboarding_app_name_entered', 'app_name', 'app_name', '  Example App  ')
    vi.advanceTimersByTime(999)
    expect(emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith('onboarding_app_name_entered', 'app_name', { field_length: 11 })
  })

  it('tracks fields independently, cancels empty values, and flushes pending values on dispose', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const tracker = createOnboardingDetailsFieldDebouncer(emit)

    tracker.schedule('onboarding_app_name_entered', 'app_name', 'app_name', 'Discard me')
    tracker.schedule('onboarding_app_name_entered', 'app_name', 'app_name', '   ')
    tracker.schedule('onboarding_app_id_entered', 'app_id', 'app_id', 'com.example.app')
    tracker.schedule('onboarding_store_url_entered', 'store_url', 'app_id', 'https://apps.apple.com/example')
    const iconStoreUrl = 'https://play.google.com/example'
    tracker.schedule('onboarding_store_icon_url_entered', 'icon_store_url', 'app_icon', iconStoreUrl)
    vi.advanceTimersByTime(1_000)

    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenCalledWith('onboarding_app_id_entered', 'app_id', { field_length: 15 })
    expect(emit).toHaveBeenCalledWith('onboarding_store_url_entered', 'app_id', { field_length: 30 })
    expect(emit).toHaveBeenCalledWith('onboarding_store_icon_url_entered', 'app_icon', { field_length: iconStoreUrl.length })

    tracker.schedule('onboarding_app_name_entered', 'app_name', 'app_name', 'Never emitted')
    tracker.dispose()
    vi.runAllTimers()
    expect(emit).toHaveBeenCalledTimes(4)
    expect(emit).toHaveBeenLastCalledWith('onboarding_app_name_entered', 'app_name', { field_length: 13 })
  })

  it('keeps the page step captured before a user continues during the debounce', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const tracker = createOnboardingDetailsFieldDebouncer(emit)
    let currentPage: 'app_id' | 'app_name' = 'app_name'

    tracker.schedule('onboarding_app_name_entered', 'app_name', currentPage, 'Example App')
    currentPage = 'app_id'
    vi.advanceTimersByTime(1_000)

    expect(currentPage).toBe('app_id')
    expect(emit).toHaveBeenCalledWith('onboarding_app_name_entered', 'app_name', { field_length: 11 })
  })
})
