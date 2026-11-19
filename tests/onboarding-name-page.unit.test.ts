// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, shallowReactive } from 'vue'
import NamePage from '../src/pages/onboarding/name.vue'

const mocks = vi.hoisted(() => ({
  valid: false,
  persist: vi.fn(),
  toastError: vi.fn(),
  save: vi.fn(),
  reset: vi.fn(),
  replace: vi.fn(),
  logout: vi.fn(),
  capture: vi.fn(),
  dialog: { openDialog: vi.fn(), closeDialog: vi.fn(), onDialogDismiss: vi.fn(), lastButtonRole: '', dialogOptions: { id: '' } },
  profileEmit: undefined as undefined | ((event: string, ...args: unknown[]) => void),
  route: { query: {} as Record<string, string> },
}))
const main = shallowReactive({ authGeneration: 1, user: { id: 'name-user', first_name: '', last_name: '', onboarding: { version: 6 } as any }, logout: mocks.logout })
vi.mock('~/stores/dialogv2', () => ({ useDialogV2Store: () => mocks.dialog }))
vi.mock('~/stores/main', () => ({ useMainStore: () => main }))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => ({ hasOrganizations: false }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace, resolve: (path: string) => {
    const url = new URL(path, 'https://example.com')
    return { path: url.pathname, query: Object.fromEntries(url.searchParams), hash: url.hash }
  } }),
}))
vi.mock('vue-sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('~/services/console', () => ({ getLocalConfig: () => ({ apiHost: 'https://example.com' }), isLocal: () => false }))
vi.mock('~/services/onboardingTracking', () => ({ sendOnboardingEvent: mocks.capture }))
vi.mock('~/services/userOnboardingWriteQueue', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/userOnboardingWriteQueue')>(),
  serializeUserOnboardingWrite: (_id: string, write: () => unknown) => write(),
  replaceUserOnboardingWithRetry: mocks.persist,
}))
vi.mock('~/components/OnboardingProfile.vue', async () => {
  const { defineComponent, h, ref } = await import('vue')
  return { default: defineComponent({
    emits: ['fieldInput', 'saveFailed'],
    setup: (_, { expose, emit }) => {
      mocks.profileEmit = emit as typeof mocks.profileEmit
      expose({ isValid: ref(mocks.valid), resetDraft: mocks.reset, save: async () => {
        const saved = await mocks.save()
        if (!saved)
          emit('saveFailed')
        return saved
      } })
      return () => h('div')
    },
  }) }
})

let dismissResume: (() => void) | undefined
let app: ReturnType<typeof createApp> | undefined
async function mount(openName = true) {
  const container = document.createElement('div')
  app = createApp(NamePage)
  app.mount(container)
  await nextTick()
  await Promise.resolve()
  if (openName) {
    container.querySelector<HTMLButtonElement>('[data-test="onboarding-welcome-continue"]')?.click()
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
  }
  return container
}
async function submit(container: HTMLElement) {
  container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await nextTick()
  await Promise.resolve()
  await nextTick()
}
beforeEach(() => {
  vi.clearAllMocks()
  main.authGeneration = 1
  mocks.valid = false
  mocks.dialog.lastButtonRole = ''
  mocks.dialog.openDialog.mockImplementation((options: { id: string }) => {
    mocks.dialog.dialogOptions.id = options.id
  })
  mocks.dialog.closeDialog.mockImplementation(() => dismissResume?.())
  dismissResume = undefined
  mocks.dialog.onDialogDismiss.mockImplementation(() => new Promise<void>((resolve) => {
    dismissResume = resolve
  }))
  mocks.persist.mockImplementation(async (_id: string, current: unknown, build: (current: unknown) => unknown) => ({ status: 'persisted', onboarding: build(current) }))
  mocks.route.query = {}
  mocks.save.mockResolvedValue(true)
  mocks.reset.mockResolvedValue(true)
  mocks.replace.mockResolvedValue(undefined)
  main.user = { id: 'name-user', first_name: '', last_name: '', onboarding: { version: 6 } }
})
afterEach(() => {
  app?.unmount()
  app = undefined
  vi.useRealTimers()
})

describe('required About you', () => {
  it('opens straight on About you without a welcome screen', async () => {
    const container = await mount(false)
    expect(container.querySelector('[data-test="onboarding-welcome"]')).toBeNull()
    expect(container.querySelector('form')).not.toBeNull()
    expect(container.querySelector('[data-test="onboarding-name-restart"]')).toBeNull()
    expect(mocks.dialog.openDialog).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_step_viewed', expect.objectContaining({ step: 'name', step_index: 0 }))
    expect(mocks.capture.mock.calls.some(call => call[1]?.step === 'welcome')).toBe(false)
  })
  it('resumes the name form after a refresh with an existing draft', async () => {
    const attemptId = '36473744-0000-4000-8000-000000000001'
    const previousRun = 'ir_36473744-0000-4000-8000-000000000002'
    main.user.onboarding = { ...main.user.onboarding, onboarding_attempt_id: attemptId, last_run_id: previousRun, profile_draft: { first_name: 'Draft', last_name: '' } }
    const container = await mount(false)
    expect(mocks.dialog.openDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'onboarding-resume-title',
      preventAccidentalClose: true,
    }))
    expect(container.querySelector('form')).toBeNull()
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_resume_dialog_viewed', expect.objectContaining({
      saved_step: 'name',
      resume_onboarding_attempt_id: attemptId,
      resumed_from_run_id: previousRun,
    }))
    expect(mocks.capture.mock.calls.some(call => call[0] === 'onboarding_step_viewed')).toBe(false)
    mocks.dialog.lastButtonRole = 'onboarding-resume-continue'
    dismissResume!()
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
    expect(container.querySelector('[data-test="onboarding-welcome"]')).toBeNull()
    expect(main.user.onboarding.profile_draft.first_name).toBe('Draft')
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_resume_continued', expect.objectContaining({
      onboarding_attempt_id: attemptId,
      resumed_from_run_id: previousRun,
    }))
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_step_viewed', expect.objectContaining({ step: 'name', resumed: true, step_index: 0, onboarding_attempt_id: attemptId, onboarding_run_id: expect.not.stringMatching(previousRun) }))
    expect(main.user.onboarding.onboarding_attempt_id).toBe(attemptId)
  })
  it('restarts a saved name draft on a fresh About you form while retaining account identity and AB assignments', async () => {
    const oldAttempt = '36473744-0000-4000-8000-000000000001'
    const assignments = { new_channel: { branch: 'A', assigned_at: '2026-10-19T11:00:00.000Z' } }
    main.user = { ...main.user, first_name: 'Saved', last_name: 'User', onboarding: {
      ...main.user.onboarding,
      abtests: assignments,
      onboarding_attempt_id: oldAttempt,
      profile_draft: { first_name: 'Unfinished', last_name: '' },
      status: 'in_progress',
      flow: 'pre_org',
      step: 'details',
      intent: 'ota',
      app_name: 'Old app',
    } }
    const container = await mount(false)
    expect(mocks.dialog.openDialog).toHaveBeenCalled()
    const restart = mocks.dialog.openDialog.mock.calls[0][0].buttons.find((button: { id: string }) => button.id === 'onboarding-resume-restart')
    expect(await restart.handler()).not.toBe(false)
    mocks.dialog.lastButtonRole = 'onboarding-resume-restart'
    dismissResume!()
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
    expect(container.querySelector('[data-test="onboarding-welcome"]')).toBeNull()
    expect(main.user.onboarding).toMatchObject({ abtests: assignments, version: 6 })
    for (const field of ['profile_draft', 'profile_completed_at', 'app_name', 'intent', 'step'])
      expect(main.user.onboarding).not.toHaveProperty(field)
    expect(main.user.first_name).toBe('Saved')
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_resume_restarted', expect.objectContaining({ resume_onboarding_attempt_id: oldAttempt }))
    expect(main.user.onboarding.onboarding_attempt_id).not.toBe(oldAttempt)
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_step_viewed', expect.objectContaining({ step: 'name', resumed: false }))
  })

  it.each(['error', 'throw'])('keeps Restart retryable and progress intact after %s', async (failure) => {
    main.user.onboarding = { ...main.user.onboarding, profile_draft: { first_name: 'Draft', last_name: '' } }
    const container = await mount(false)
    expect(mocks.dialog.openDialog).toHaveBeenCalled()
    const restart = mocks.dialog.openDialog.mock.calls[0][0].buttons.find((button: { id: string }) => button.id === 'onboarding-resume-restart')
    if (failure === 'throw')
      mocks.persist.mockRejectedValueOnce(new Error('network unavailable'))
    else
      mocks.persist.mockResolvedValueOnce({ status: 'error', error: new Error('network unavailable') })
    expect(await restart.handler()).toBe(false)
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('[data-test="onboarding-welcome"]')).toBeNull()
    expect(main.user.onboarding.profile_draft.first_name).toBe('Draft')
    expect(mocks.toastError).toHaveBeenCalled()
    expect(mocks.capture.mock.calls.some(call => call[0] === 'onboarding_resume_restarted')).toBe(false)
    expect(await restart.handler()).toBe(true)
    expect(main.user.onboarding.profile_draft).toBeUndefined()
  })

  it('asks again on refresh of confirmed names opened with Back', async () => {
    mocks.route.query = { edit: '1', to: '/onboarding/app' }
    main.user = { ...main.user, first_name: 'Example', last_name: 'User', onboarding: { ...main.user.onboarding, profile_completed_at: '2026-10-20T10:00:00Z' } }
    const container = await mount(false)
    expect(mocks.dialog.openDialog).toHaveBeenCalledOnce()
    expect(container.querySelector('form')).toBeNull()
    mocks.dialog.lastButtonRole = 'onboarding-resume-continue'
    dismissResume!()
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_resume_continued', expect.objectContaining({ saved_step: 'name' }))
  })

  it.each(['dispose', 'auth-change'])('ignores a pending decision after %s', async (change) => {
    main.user.onboarding = { ...main.user.onboarding, profile_draft: { first_name: 'Draft', last_name: '' } }
    await mount(false)
    const restart = mocks.dialog.openDialog.mock.calls[0][0].buttons[0].handler
    if (change === 'dispose') {
      app!.unmount()
      app = undefined
      expect(mocks.dialog.closeDialog).toHaveBeenCalledOnce()
    }
    else {
      main.authGeneration++
    }
    mocks.dialog.lastButtonRole = 'onboarding-resume-continue'
    dismissResume!()
    await nextTick()
    expect(await restart()).toBe(false)
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(mocks.capture.mock.calls.some(call => call[0] === 'onboarding_resume_continued')).toBe(false)
  })

  it('uses the shared onboarding frame and shows About you as the first progress step', async () => {
    const container = await mount()
    expect(container.querySelector('[data-test="onboarding-page"]')).not.toBeNull()
    expect(container.querySelector('h1')?.textContent).toContain('onboarding-welcome-title')
    const steps = container.querySelectorAll('nav[aria-label="app-onboarding-progress-label"] li')
    // Before the AI-or-manual choice, the stepper shows that choice's steps, not the manual wizard's.
    expect(steps).toHaveLength(4)
    expect(steps[0].getAttribute('aria-current')).toBe('step')
    expect(steps[0].textContent).toContain('unified-onboarding-step-about-you')
    expect(steps[1].textContent).toContain('ai-onboarding-step-mode')
    expect(container.querySelectorAll('[data-test="onboarding-logout"]')).toHaveLength(1)
  })
  it('continues directly into the goal step with the same telemetry identity', async () => {
    mocks.valid = true
    const container = await mount()
    await submit(container)
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalled())
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({ path: '/onboarding/app', state: { capgoProfileOnboardingHandoff: expect.any(Object) } }))
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_step_completed', expect.objectContaining({ step: 'name', next_step: 'intent' }))
  })

  it('reopens confirmed names from Your goal without replaying welcome or starting a new run', async () => {
    const identity = { attemptId: 'return-attempt', runId: 'return-run' }
    const previousState = window.history.state
    window.history.replaceState({ capgoProfileOnboardingHandoff: identity }, '')
    mocks.route.query = { edit: '1', to: '/onboarding/app' }
    mocks.valid = true
    main.user = { ...main.user, first_name: 'Example', last_name: 'User', onboarding: {
      ...main.user.onboarding,
      profile_completed_at: '2026-10-20T10:00:00Z',
    } }
    try {
      const container = await mount(false)
      expect(container.querySelector('form')).not.toBeNull()
      expect(container.querySelector('[data-test="onboarding-welcome"]')).toBeNull()
      expect(mocks.replace).not.toHaveBeenCalled()
      expect(mocks.capture).toHaveBeenCalledWith('onboarding_step_viewed', expect.objectContaining({
        step: 'name',
        previous_step: 'intent',
        resumed: false,
        onboarding_attempt_id: identity.attemptId,
        onboarding_run_id: identity.runId,
      }))
      await submit(container)
      await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
        path: '/onboarding/app',
        state: { capgoProfileOnboardingHandoff: identity },
      })))
    }
    finally {
      window.history.replaceState(previousState, '')
    }
  })

  it('blocks continuing and programmatic form submission while names are invalid', async () => {
    const container = await mount()
    expect(container.querySelector<HTMLButtonElement>('[data-test="onboarding-name-continue"]')?.disabled).toBe(true)
    await submit(container)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
  it('stays on name after a failed save and tracks failure without step completion', async () => {
    mocks.valid = true
    mocks.save.mockResolvedValue(false)
    const container = await mount()
    await submit(container)
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_profile_save_failed', expect.objectContaining({ step: 'name', onboarding_version: 6 }))
    expect(mocks.capture.mock.calls.some(call => call[0] === 'onboarding_step_completed' && call[1]?.step === 'name')).toBe(false)
  })
  it('preserves the original destination query/hash and telemetry identity after saving', async () => {
    mocks.valid = true
    mocks.route.query.to = '/onboarding/organization?source=org-switcher#details'
    const container = await mount()
    await submit(container)
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalled())
    expect(main.user.onboarding.profile_completed_at).toEqual(expect.any(String))
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({ path: '/onboarding/organization', query: { source: 'org-switcher' }, hash: '#details', state: { capgoProfileOnboardingHandoff: expect.objectContaining({ attemptId: expect.any(String), runId: expect.any(String) }) } }))
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_profile_saved', expect.objectContaining({ step: 'name', onboarding_version: 6 }))
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_step_completed', expect.objectContaining({ next_step: 'organization' }))
  })
  it.each(['error', 'throw'])('requires persisted confirmation when its write fails with %s', async (failure) => {
    mocks.valid = true
    const container = await mount()
    if (failure === 'throw')
      mocks.persist.mockRejectedValueOnce(new Error('network unavailable'))
    else
      mocks.persist.mockResolvedValueOnce({ status: 'error', error: new Error('write rejected') })
    await submit(container)
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(main.user.onboarding.profile_completed_at).toBeUndefined()
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_profile_save_failed', expect.objectContaining({ step: 'name' }))
    expect(mocks.capture.mock.calls.some(call => call[0] === 'onboarding_step_completed' && call[1]?.step === 'name')).toBe(false)
  })
  it('debounces field events for 500 ms and sends lengths without raw names', async () => {
    vi.useFakeTimers()
    await mount()
    mocks.profileEmit?.('fieldInput', 'first_name', 'Alice')
    mocks.profileEmit?.('fieldInput', 'last_name', 'Smith')
    mocks.profileEmit?.('fieldInput', 'company_name', 'Example Company')
    await vi.advanceTimersByTimeAsync(499)
    expect(mocks.capture.mock.calls.some(call => call[0] === 'onboarding_first_name_entered')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_first_name_entered', expect.objectContaining({ step: 'name', field_length: 5, onboarding_version: 6 }))
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_last_name_entered', expect.objectContaining({ step: 'name', field_length: 5, onboarding_version: 6 }))
    expect(mocks.capture).toHaveBeenCalledWith('onboarding_company_name_entered', expect.objectContaining({ step: 'name', field_length: 15, onboarding_version: 6 }))
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toMatch(/Alice|Smith|Example Company/)
  })
})
