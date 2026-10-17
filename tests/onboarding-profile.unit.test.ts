import type { Json } from '../src/types/supabase.types'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, shallowReactive } from 'vue'
import OnboardingProfile from '../src/components/OnboardingProfile.vue'
import { mergeUserOnboardingProgress, serializeUserOnboardingWrite } from '../src/services/userOnboardingWriteQueue'
import { hasProfileOnboarding, resolveOnboardingAnalyticsVersion } from '../src/utils/onboardingABTests'
import { createOnboardingDetailsFieldDebouncer } from '../src/utils/onboardingProgressAnalytics'

const mocks = vi.hoisted(() => ({ single: vi.fn(), update: vi.fn(), draftWrite: vi.fn(), latest: vi.fn(), setUser: vi.fn(), toast: vi.fn() }))
const state = shallowReactive({ authGeneration: 0, user: { id: 'profile-user', email: 'profile@example.com', first_name: '', last_name: '', onboarding: { version: 6 } as Json, image_url: null } })
vi.mock('~/stores/main', () => ({ useMainStore: () => state }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('~/services/posthog', () => ({ setUser: mocks.setUser }))
vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://example.supabase.co' }),
  isLocal: () => false,
  useSupabase: () => ({ from: () => ({
    update: (payload: { onboarding?: Json }) => {
      mocks.update(payload)
      return { eq: () => ({
        select: () => ({ single: mocks.single }),
        filter: (_column: string, _operator: string, expected: string) => ({
          select: () => ({ maybeSingle: () => mocks.draftWrite(payload.onboarding, JSON.parse(expected)) }),
        }),
      }) }
    },
    select: () => ({ eq: () => ({ maybeSingle: mocks.latest }) }),
  }) }),
}))

let app: ReturnType<typeof createApp> | undefined
function mount() {
  const container = document.createElement('div')
  const fields = vi.fn()
  app = createApp(OnboardingProfile, { onFieldInput: fields })
  const profile = app.mount(container) as unknown as { isValid: boolean, save: () => Promise<boolean> }
  return { container, profile, fields }
}
async function enter(container: HTMLElement, field: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[data-test="onboarding-${field}"]`)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'profile-user', email: 'profile@example.com', first_name: '', last_name: '', onboarding: { version: 6 }, image_url: null }
  mocks.draftWrite.mockImplementation(async (onboarding: Json) => ({ data: { onboarding }, error: null }))
  mocks.single.mockResolvedValue({ data: { id: 'profile-user', first_name: 'Example', last_name: 'User' }, error: null })
})
afterEach(async () => {
  state.authGeneration++
  app?.unmount()
  app = undefined
  await Promise.resolve()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('profile onboarding V6', () => {
  it('gates the form and analytics version by persisted cohort, preserving legacy experiment versions', () => {
    expect(hasProfileOnboarding({ version: 6 })).toBe(true)
    expect(hasProfileOnboarding({ version: 5 })).toBe(false)
    expect(resolveOnboardingAnalyticsVersion({ version: 6 })).toBe(6)
    expect(resolveOnboardingAnalyticsVersion({})).toBe(4)
    const abtests = { webnativeapp_publish_intent: { assigned_at: '2026-01-01', branch: 'A' } }
    expect(resolveOnboardingAnalyticsVersion({ abtests })).toBe('5.A')
    expect(resolveOnboardingAnalyticsVersion({ version: 6, abtests })).toBe(6)
    state.user.onboarding = { version: 4 }
    const { container, profile } = mount()
    expect(container.querySelector('input')).toBeNull()
    expect(profile.isValid).toBe(true)
  })

  it('autosaves both draft fields after 500 ms and restores them after remounting', async () => {
    vi.useFakeTimers()
    state.user.onboarding = { version: 6, intent: 'ota', abtests: { retained: true } }
    const { container } = mount()
    await enter(container, 'first-name', ' Ex ')
    await vi.advanceTimersByTimeAsync(300)
    await enter(container, 'last-name', ' User ')
    await vi.advanceTimersByTimeAsync(499)
    expect(mocks.draftWrite).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(state.user.onboarding).toEqual({
      version: 6,
      intent: 'ota',
      abtests: { retained: true },
      profile_draft: { first_name: ' Ex ', last_name: ' User ' },
    })
    expect(state.user.first_name).toBe('')
    expect(state.user.last_name).toBe('')
    expect(mocks.setUser).not.toHaveBeenCalled()
    app?.unmount()
    const restored = mount().container
    expect(restored.querySelector<HTMLInputElement>('[data-test="onboarding-first-name"]')?.value).toBe(' Ex ')
    expect(restored.querySelector<HTMLInputElement>('[data-test="onboarding-last-name"]')?.value).toBe(' User ')
    expect(mergeUserOnboardingProgress({ step: 'details' }, state.user.onboarding)).toMatchObject({
      profile_draft: { first_name: ' Ex ', last_name: ' User ' },
    })
  })

  it('restores partial drafts and preserves an explicitly cleared prefilled name', async () => {
    vi.useFakeTimers()
    state.user.first_name = 'Existing'
    state.user.onboarding = { version: 6, profile_draft: { last_name: 'Draft' } }
    const { container, profile } = mount()
    expect(container.querySelector<HTMLInputElement>('[data-test="onboarding-first-name"]')?.value).toBe('Existing')
    await enter(container, 'first-name', '')
    await vi.advanceTimersByTimeAsync(500)
    expect(container.querySelector<HTMLInputElement>('[data-test="onboarding-first-name"]')?.value).toBe('')
    expect(profile.isValid).toBe(false)
    app?.unmount()
    const restored = mount().container
    expect(restored.querySelector<HTMLInputElement>('[data-test="onboarding-first-name"]')?.value).toBe('')
    expect(restored.querySelector<HTMLInputElement>('[data-test="onboarding-last-name"]')?.value).toBe('Draft')
  })

  it('retries conflicts against the latest onboarding JSON without overwriting newer typing', async () => {
    vi.useFakeTimers()
    let finishWrite!: (value: unknown) => void
    mocks.draftWrite.mockResolvedValueOnce({ data: null, error: null })
      .mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve }))
    const latest = { version: 6, step: 'intent', abtests: { concurrent: true } }
    mocks.latest.mockResolvedValue({ data: { onboarding: latest }, error: null })
    const { container } = mount()
    await enter(container, 'first-name', 'Old')
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.draftWrite).toHaveBeenNthCalledWith(2, {
      ...latest,
      profile_draft: { first_name: 'Old', last_name: '' },
    }, latest)
    await enter(container, 'first-name', 'New')
    finishWrite({ data: { onboarding: { ...latest, profile_draft: { first_name: 'Old', last_name: '' } } }, error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(container.querySelector<HTMLInputElement>('[data-test="onboarding-first-name"]')?.value).toBe('New')
    await vi.advanceTimersByTimeAsync(500)
    expect(state.user.onboarding).toMatchObject({ ...latest, profile_draft: { first_name: 'New' } })
  })

  it('retries failed autosaves on the next edit and flushes pending edits on unmount', async () => {
    vi.useFakeTimers()
    mocks.draftWrite.mockResolvedValueOnce({ data: null, error: new Error('offline') })
    const { container } = mount()
    await enter(container, 'first-name', 'Example')
    await vi.advanceTimersByTimeAsync(500)
    expect(state.user.onboarding).toEqual({ version: 6 })
    await enter(container, 'last-name', 'User')
    app?.unmount()
    app = undefined
    await vi.advanceTimersByTimeAsync(0)
    expect(state.user.onboarding).toMatchObject({ profile_draft: { first_name: 'Example', last_name: 'User' } })
    expect(mocks.setUser).not.toHaveBeenCalled()
  })

  it('does not write a queued draft after the authentication generation changes', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const blocked = serializeUserOnboardingWrite(state.user.id, () => new Promise<void>((resolve) => {
      release = resolve
    }))
    const { container } = mount()
    await enter(container, 'first-name', 'Old user')
    await vi.advanceTimersByTimeAsync(500)
    state.authGeneration++
    release()
    await blocked
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.draftWrite).not.toHaveBeenCalled()
    expect(state.user.onboarding).toEqual({ version: 6 })
  })

  it('updates PostHog person names only after the profile is saved', async () => {
    const { container, profile, fields } = mount()
    await enter(container, 'first-name', '  Example  ')
    await enter(container, 'last-name', '  User  ')
    expect(mocks.setUser).not.toHaveBeenCalled()
    expect(fields.mock.calls).toEqual([['first_name', '  Example  '], ['last_name', '  User  ']])
    expect(await profile.save()).toBe(true)
    expect(mocks.update).toHaveBeenCalledWith({ first_name: 'Example', last_name: 'User' })
    expect(mocks.setUser).toHaveBeenCalledWith('profile-user', expect.objectContaining({ first_name: 'Example', last_name: 'User', nickname: 'Example User' }), 'https://example.supabase.co')
  })

  it('does not report unsaved names when persistence fails, and allows retry', async () => {
    mocks.single.mockResolvedValueOnce({ data: null, error: new Error('offline') })
    const { container, profile } = mount()
    await enter(container, 'first-name', 'Example')
    await enter(container, 'last-name', 'User')
    expect(await profile.save()).toBe(false)
    expect(mocks.setUser).not.toHaveBeenCalled()
    expect(state.user.first_name).toBe('')
    expect(await profile.save()).toBe(true)
    expect(mocks.setUser).toHaveBeenCalledOnce()
  })

  it('keeps a successful save successful if analytics throws', async () => {
    mocks.setUser.mockImplementationOnce(() => {
      throw new Error('analytics unavailable')
    })
    const { container, profile } = mount()
    await enter(container, 'first-name', 'Example')
    await enter(container, 'last-name', 'User')
    expect(await profile.save()).toBe(true)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('identifies saved names as PostHog person properties', async () => {
    const identify = vi.fn()
    vi.stubGlobal('posthog', { identify, setPersonProperties: vi.fn() })
    const { setUser } = await vi.importActual<typeof import('../src/services/posthog')>('../src/services/posthog')
    setUser('profile-user', { first_name: 'Example', last_name: 'User', nickname: 'Example User' }, 'https://example.supabase.co')
    expect(identify).toHaveBeenCalledWith('profile-user', expect.objectContaining({ first_name: 'Example', last_name: 'User', name: 'Example User' }))
  })

  it('debounces each name independently for 500 ms and sends lengths without typed names', () => {
    vi.useFakeTimers()
    const capture = vi.fn()
    const tracker = createOnboardingDetailsFieldDebouncer(capture, 500)
    tracker.schedule('onboarding_first_name_entered', 'first_name', 'intent', 'Ex')
    vi.advanceTimersByTime(300)
    tracker.schedule('onboarding_first_name_entered', 'first_name', 'intent', 'Example')
    tracker.schedule('onboarding_last_name_entered', 'last_name', 'intent', 'User')
    vi.advanceTimersByTime(499)
    expect(capture).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(capture.mock.calls).toEqual([
      ['onboarding_first_name_entered', 'intent', { field_length: 7 }],
      ['onboarding_last_name_entered', 'intent', { field_length: 4 }],
    ])
    tracker.dispose()
  })
})
