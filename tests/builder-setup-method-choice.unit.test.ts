// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import AppOnboardingBuilderChecklist from '../src/components/dashboard/AppOnboardingBuilderChecklist.vue'
import { BUILDER_STEP_IDS } from '../src/services/builderOnboardingChecklist'

const mocks = vi.hoisted(() => ({
  manualFirst: null as unknown as { value: boolean },
  rememberSetupMethod: vi.fn(),
  onboarding: null as unknown,
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, string>) => values ? `${key}:${Object.values(values).join(',')}` : key }) }))
vi.mock('~/utils/onboardingSkipStep', () => ({ skipOnboardingStep: vi.fn() }))
vi.mock('~/modules/i18n', () => ({ i18n: { global: { t: (key: string) => key, locale: { value: 'en' } } } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
vi.mock('~/composables/useSetupMethodPreference', () => ({
  useSetupMethodPreference: () => ({ manualFirst: mocks.manualFirst, rememberSetupMethod: mocks.rememberSetupMethod }),
}))
vi.mock('~/services/console', () => {
  const query: any = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: { onboarding: mocks.onboarding }, error: null }),
  }
  return { useConsole: () => ({ from: () => query }) }
})

const command = 'npx @capgo/cli@latest build init -a ak_1234567890abcdef3f9a'
const cleanups: Array<() => void> = []

function onboarding(started: Partial<Record<'ios' | 'android', string>> = {}) {
  return { setup: {
    todo_list_version: 4,
    builder_todo_list_version: '1',
    paths: ['builder'],
    selected_path: 'builder',
    steps: { builder: Object.fromEntries((['ios', 'android'] as const).map(platform => [platform, Object.fromEntries(BUILDER_STEP_IDS[platform].map(id => [id, { status: started[platform] === id ? 'done' : 'pending' }]))])) },
  } }
}

function mount(value = onboarding()) {
  mocks.onboarding = value
  const events: Record<string, unknown[][]> = {}
  const record = (name: string) => (...args: unknown[]) => (events[name] ??= []).push(args)
  const host = document.createElement('div')
  const app = createApp(defineComponent({
    setup: () => () => h(AppOnboardingBuilderChecklist, {
      appId: 'com.example.builder',
      initialOnboarding: value,
      command,
      hiding: false,
      leaving: false,
      onCopyCommand: record('copyCommand'),
      onMethodSelected: record('methodSelected'),
      onPlatformChanged: record('platformChanged'),
    }),
  }))
  app.component('RouterLink', defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }))
  app.mount(host)
  cleanups.push(() => app.unmount())
  return { host, events, find: (test: string) => host.querySelector<HTMLElement>(`[data-test="${test}"]`) }
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  mocks.manualFirst = ref(false)
  mocks.rememberSetupMethod.mockReset()
})

afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
})

describe('Builder setup method choice', () => {
  it('opens on the AI assistant and waits for setup without asking for a platform', () => {
    const { find } = mount()
    expect(find('builder-method-ai')?.getAttribute('aria-pressed')).toBe('true')
    expect(find('builder-checklist-ai-setup')).not.toBeNull()
    expect(find('builder-checklist-terminal')).toBeNull()
    expect(find('builder-checklist-waiting')?.textContent).toContain('builder-checklist-waiting-ai')
    expect(find('builder-platform-ios')).toBeNull()
    expect(find('builder-platform-android')).toBeNull()
  })

  it('switches to the terminal command without --platform and keeps the key hidden until revealed', async () => {
    const { find, events } = mount()
    find('builder-method-terminal')!.click()
    await nextTick()
    expect(events.methodSelected).toEqual([['terminal']])
    expect(mocks.rememberSetupMethod).toHaveBeenCalledWith('manual')
    expect(find('builder-checklist-ai-setup')).toBeNull()
    expect(find('builder-checklist-command')?.textContent).toBe('npx @capgo/cli@latest build init -a ak_••••••••3f9a')
    expect(find('builder-checklist-waiting')?.textContent).toContain('builder-checklist-waiting-terminal')
    find('builder-checklist-command-reveal')!.click()
    await nextTick()
    expect(find('builder-checklist-command')?.textContent).toBe(command)
    find('builder-checklist-command-copy')!.click()
    expect(events.copyCommand).toEqual([[]])
  })

  it('opens on the terminal when the user last picked the manual way', () => {
    mocks.manualFirst.value = true
    const { find } = mount()
    expect(find('builder-method-terminal')?.getAttribute('aria-pressed')).toBe('true')
    expect(find('builder-checklist-terminal')).not.toBeNull()
  })

  it('follows the saved method once the user loads, until the user picks one', async () => {
    const { find } = mount()
    mocks.manualFirst.value = true
    await nextTick()
    expect(find('builder-method-terminal')?.getAttribute('aria-pressed')).toBe('true')
    find('builder-method-ai')!.click()
    mocks.manualFirst.value = false
    mocks.manualFirst.value = true
    await nextTick()
    expect(find('builder-method-ai')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the steps of the platform the CLI or assistant started', async () => {
    const { find, events } = mount(onboarding({ android: 'start_setup' }))
    await nextTick()
    expect(find('builder-checklist-waiting')).toBeNull()
    expect(find('builder-platform-android')?.getAttribute('aria-pressed')).toBe('true')
    expect(find('builder-platform-ios')).toBeNull()
    expect(find('builder-step-prepare_keystore')).not.toBeNull()
    expect(events.platformChanged).toEqual([['android']])
  })

  it('adds a tab for the second platform only once it has started', async () => {
    const { find } = mount(onboarding({ ios: 'start_setup', android: 'start_setup' }))
    await nextTick()
    expect(find('builder-platform-ios')?.getAttribute('aria-pressed')).toBe('true')
    find('builder-platform-android')!.click()
    await nextTick()
    expect(find('builder-step-prepare_keystore')).not.toBeNull()
  })
})
