// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import AppOnboardingDualChecklist from '../src/components/dashboard/AppOnboardingDualChecklist.vue'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../src/services/appOnboarding'
import { BUILDER_STEP_IDS } from '../src/services/builderOnboardingChecklist'
import { loadChecklistPreference, saveChecklistPreference } from '../src/utils/dualOnboardingChecklists'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const user = 'fake-checklist-user'
const appId = 'com.example.identity-checklist'
const cleanups: Array<() => void> = []

function mountChecklist(started = true, selectedPath = 'ota', builderPlatforms = ['ios', 'android'], initialPath?: 'ota' | 'builder') {
  const userId = ref<string | null>(null)
  const requestedPath = ref(initialPath)
  let automaticPlatformChange: ((platform: 'ios' | 'android') => void) | undefined
  const Inspection = defineComponent({
    setup() {
      const inspected = ref(false)
      return () => h('button', { 'data-test': 'inspect', 'onClick': () => inspected.value = true }, inspected.value ? 'inspected' : 'inspect')
    },
  })
  const onboarding = { setup: {
    todo_list_version: 4,
    ota_todo_list_version: '1',
    builder_todo_list_version: '1',
    paths: ['ota', 'builder'],
    selected_path: selectedPath,
    selected_builder_platform: 'ios',
    steps: {
      ota: Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: started && id === 'login_cli_mcp' ? 'done' : 'pending' }])),
      builder: Object.fromEntries((['ios', 'android'] as const).map(platform => [platform, Object.fromEntries(BUILDER_STEP_IDS[platform].map(id => [id, { status: started && builderPlatforms.includes(platform) && id === 'start_setup' ? 'done' : 'pending' }]))])),
    },
  } }
  const host = document.createElement('div')
  const app = createApp(defineComponent({
    setup() {
      return () => h(AppOnboardingDualChecklist, { appId, userId: userId.value, initialOnboarding: onboarding, initialPath: requestedPath.value, hiding: false, leaving: false }, {
        builder: (panel: any) => {
          automaticPlatformChange = panel.selectPlatform
          return h('div', { 'data-test': 'builder', 'data-platform': panel.platform }, [
            h('button', { 'data-test': 'ios', 'onClick': () => panel.selectPlatform('ios') }, 'iOS'),
            h(Inspection),
          ])
        },
      })
    },
  }))
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  return { host, userId, requestedPath, automaticPlatformChange: () => automaticPlatformChange?.('ios') }
}

describe('dual-checklist identity hydration', () => {
  beforeEach(() => {
    localStorage.clear()
    saveChecklistPreference(user, appId, { path: 'builder', platform: 'android' })
  })
  afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

  it('opens an explicitly requested Builder path over existing OTA progress and a late preference', async () => {
    saveChecklistPreference(user, appId, { path: 'ota' })
    const { host, userId } = mountChecklist(true, 'ota', [], 'builder')
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-builder')
    userId.value = user
    await nextTick()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-builder')
    expect(loadChecklistPreference(user, appId).path).toBe('builder')
  })

  it('opens an explicitly requested Builder path without requiring progress or a goal choice', () => {
    const { host } = mountChecklist(false, 'ota', [], 'builder')
    expect(host.querySelector('[data-test="setup-goal-chooser"]')).toBeNull()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-builder')
  })

  it('applies a later explicit path request while keeping the checklist mounted', async () => {
    saveChecklistPreference(user, appId, { path: 'ota' })
    const { host, userId, requestedPath } = mountChecklist()
    userId.value = user
    await nextTick()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-live-updates')
    requestedPath.value = 'builder'
    await nextTick()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-builder')
    expect(loadChecklistPreference(user, appId).path).toBe('builder')
    requestedPath.value = undefined
    await nextTick()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-builder')
  })

  it('loads saved path and platform when identity arrives after mount', async () => {
    const { host, userId } = mountChecklist()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-live-updates')
    userId.value = user
    await nextTick()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-builder')
    expect(host.querySelector('[data-test="builder"]')?.getAttribute('data-platform')).toBe('android')
    expect(loadChecklistPreference(user, appId)).toEqual({ path: 'builder', platform: 'android' })
  })

  it('keeps the chooser when identity arrives without saved step progress', async () => {
    const { host, userId } = mountChecklist(false)
    userId.value = user
    await nextTick()
    expect(host.querySelector('[data-test="setup-goal-chooser"]')).not.toBeNull()
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0)
  })

  it('preserves deliberate path, platform and task inspection while identity loads', async () => {
    saveChecklistPreference(user, appId, { path: 'ota', platform: 'android' })
    const { host, userId } = mountChecklist()
    await new Promise(resolve => setTimeout(resolve, 1))
    ;(host.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click()
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 1))
    ;(host.querySelector('[data-test="ios"]') as HTMLButtonElement).click()
    ;(host.querySelector('[data-test="inspect"]') as HTMLButtonElement).click()
    await nextTick()
    userId.value = user
    await nextTick()
    expect(host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-builder')
    expect(host.querySelector('[data-test="builder"]')?.getAttribute('data-platform')).toBe('ios')
    expect(host.querySelector('[data-test="inspect"]')?.textContent).toBe('inspected')
    expect(loadChecklistPreference(user, appId)).toEqual({ path: 'builder', platform: 'ios' })
  })

  it('does not count automatic platform hydration as interaction', async () => {
    const { host, userId, automaticPlatformChange } = mountChecklist(true, 'builder')
    automaticPlatformChange()
    userId.value = user
    await nextTick()
    expect(host.querySelector('[data-test="builder"]')?.getAttribute('data-platform')).toBe('android')
  })

  it('persists an unchanged OTA resume instead of a stale arriving Builder preference', async () => {
    const first = mountChecklist(true, 'builder', [])
    first.userId.value = user
    await nextTick()
    expect(loadChecklistPreference(user, appId).path).toBe('ota')
    const reopened = mountChecklist(true, 'builder')
    reopened.userId.value = user
    await nextTick()
    expect(reopened.host.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('setup-goal-live-updates')
  })

  it('persists an unchanged Builder resume with its actually started platform', async () => {
    saveChecklistPreference(user, appId, { path: 'builder', platform: 'ios' })
    const { host, userId } = mountChecklist(true, 'builder', ['android'])
    userId.value = user
    await nextTick()
    expect(host.querySelector('[data-test="builder"]')?.getAttribute('data-platform')).toBe('android')
    expect(loadChecklistPreference(user, appId)).toEqual({ path: 'builder', platform: 'android' })
  })
})
