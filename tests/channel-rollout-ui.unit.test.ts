// @vitest-environment happy-dom

import type { App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import { useDialogV2Store } from '../src/stores/dialogv2'
import type { ChannelRolloutConfirmFlowsDeps } from '../src/utils/channelRolloutConfirmFlows'
import { createChannelRolloutConfirmFlows } from '../src/utils/channelRolloutConfirmFlows'
import { getUpdatePackageDescription } from '../src/utils/channelUpdatePackageCopy'
import { confirmConsequentialChannelChange } from '../src/utils/confirmConsequentialChannelChange'

const DialogHarness = defineComponent({
  name: 'DialogHarness',
  setup() {
    const dialogStore = useDialogV2Store()
    return () => {
      if (!dialogStore.showDialog)
        return null
      const options = dialogStore.dialogOptions
      return h('div', { 'data-testid': 'dialog-shell' }, [
        h('h3', options.title ?? ''),
        h('p', options.description ?? ''),
        ...(options.buttons ?? []).map(button =>
          h('button', {
            type: 'button',
            onClick: () => dialogStore.closeDialog(button),
          }, button.text),
        ),
      ])
    }
  },
})

const mountedApps: App[] = []

function mountDialogShell() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(DialogHarness)
  app.use(pinia)
  app.use(i18n)
  app.mount(container)
  mountedApps.push(app)
  return { container, dialogStore: useDialogV2Store(), t: i18n.global.t as (key: string, params?: Record<string, unknown>) => string }
}

function findDialogButton(container: HTMLElement, label: string) {
  const buttons = Array.from(container.querySelectorAll('button'))
  const match = buttons.find(button => button.textContent?.trim() === label)
  if (!match)
    throw new Error(`Dialog button not found: ${label}`)
  return match
}

async function dismissDialog(container: HTMLElement, label: 'Cancel' | 'Confirm') {
  findDialogButton(container, label).click()
  await nextTick()
  await nextTick()
}

interface TestChannel {
  update_package?: 'all' | 'zip' | 'delta' | 'zip_from_builtin' | 'delta_from_builtin' | null
  rollout_version?: number | null
  rollout_percentage_bps?: number | null
  rollout_paused_at?: string | null
}

function createTestFlows(options: {
  container: HTMLElement
  t: (key: string, params?: Record<string, unknown>) => string
  channel: TestChannel
  saveChannelChange?: ReturnType<typeof vi.fn>
  saveChannelChanges?: ReturnType<typeof vi.fn>
  canUpdate?: boolean
}) {
  const dialogStore = useDialogV2Store()
  const saveChannelChange = options.saveChannelChange ?? vi.fn(async () => true)
  const saveChannelChanges = options.saveChannelChanges ?? vi.fn(async () => true)
  const askUpdateNotificationAfterBundleChange = vi.fn(async () => {})
  const openSelectRolloutVersion = vi.fn(async () => {})
  const closeUpdatePackageDropdown = vi.fn()
  const toast = { error: vi.fn(), info: vi.fn() }

  const flows = createChannelRolloutConfirmFlows({
    dialogStore,
    t: options.t,
    toast,
    canUpdateChannelSettings: () => options.canUpdate ?? true,
    closeUpdatePackageDropdown,
    getChannel: () => options.channel,
    rolloutTargetName: () => 'Rollout bundle',
    stableBundleName: () => 'Stable bundle',
    rolloutPercentageText: () => '10%',
    saveChannelChange: saveChannelChange as ChannelRolloutConfirmFlowsDeps['saveChannelChange'],
    saveChannelChanges: saveChannelChanges as ChannelRolloutConfirmFlowsDeps['saveChannelChanges'],
    askUpdateNotificationAfterBundleChange,
    openSelectRolloutVersion,
  })

  return {
    flows,
    saveChannelChange,
    saveChannelChanges,
    toast,
    openSelectRolloutVersion,
    dismiss: (label: 'Cancel' | 'Confirm') => dismissDialog(options.container, label),
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
})

describe('channel information rollout and update package UX', () => {
  it('confirmConsequentialChannelChange blocks cancel while confirm is in flight', async () => {
    const { container, dialogStore, t } = mountDialogShell()
    const onConfirm = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
    })

    void confirmConsequentialChannelChange(
      dialogStore,
      { cancel: t('button-cancel'), confirm: t('button-confirm') },
      {
        id: 'confirm-rollout-percentage',
        title: t('confirm-rollout-percentage-title'),
        description: t('confirm-rollout-percentage-description', { current: '10%', next: '25%' }),
        onConfirm,
      },
    )

    await nextTick()
    findDialogButton(container, 'Confirm').click()
    await nextTick()
    findDialogButton(container, 'Cancel').click()
    await nextTick()
    expect(dialogStore.showDialog).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(dialogStore.showDialog).toBe(false)
  })

  it('confirmConsequentialChannelChange ignores duplicate confirm clicks', async () => {
    const { container, dialogStore, t } = mountDialogShell()
    const onConfirm = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })

    void confirmConsequentialChannelChange(
      dialogStore,
      { cancel: t('button-cancel'), confirm: t('button-confirm') },
      {
        id: 'confirm-promote-rollout',
        title: t('confirm-promote-rollout-title'),
        description: t('confirm-promote-rollout-description', { target: 'v2.0.0' }),
        onConfirm,
      },
    )

    await nextTick()
    const confirmButton = findDialogButton(container, 'Confirm')
    confirmButton.click()
    confirmButton.click()
    await dismissDialog(container, 'Confirm')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('onSelectUpdatePackage cancel skips save and confirm applies update_package', async () => {
    const { container, t } = mountDialogShell()
    const channel: TestChannel = { update_package: 'all' }
    const { flows, saveChannelChange, dismiss } = createTestFlows({ container, t, channel })

    const firstSelect = flows.onSelectUpdatePackage('delta')
    await nextTick()
    expect(container.textContent).toContain('Change download format?')

    await dismiss('Cancel')
    await firstSelect
    expect(saveChannelChange).not.toHaveBeenCalled()

    const secondSelect = flows.onSelectUpdatePackage('delta')
    await nextTick()
    await dismiss('Confirm')
    await secondSelect
    expect(saveChannelChange).toHaveBeenCalledWith('update_package', 'delta')
  })

  it('applyRolloutPercentage cancel skips save and confirm updates bps', async () => {
    const { container, t } = mountDialogShell()
    const channel: TestChannel = { rollout_percentage_bps: 1000 }
    const { flows, saveChannelChange, dismiss } = createTestFlows({ container, t, channel })

    const firstApply = flows.applyRolloutPercentage('25')
    await nextTick()
    expect(container.textContent).toContain('Apply rollout percentage?')

    await dismiss('Cancel')
    await firstApply
    expect(saveChannelChange).not.toHaveBeenCalled()

    const secondApply = flows.applyRolloutPercentage('25')
    await nextTick()
    await dismiss('Confirm')
    await secondApply
    expect(saveChannelChange).toHaveBeenCalledWith('rollout_percentage_bps', 2500)
  })

  it('rollout control confirms match expected dialog ids and saves', async () => {
    const { container, t } = mountDialogShell()
    const channel: TestChannel = {
      rollout_version: 42,
      rollout_percentage_bps: 500,
      rollout_paused_at: null,
    }
    const saveChannelChanges = vi.fn(async () => true)
    const { flows, saveChannelChange, dismiss } = createTestFlows({
      container,
      t,
      channel,
      saveChannelChanges,
    })

    const cases = [
      {
        run: () => flows.enableRollout(),
        title: 'Enable progressive rollout?',
        assert: () => expect(saveChannelChange).toHaveBeenCalledWith('rollout_enabled', true),
      },
      {
        run: () => flows.disableRollout(),
        title: 'Disable progressive rollout?',
        assert: () => expect(saveChannelChanges).toHaveBeenCalledWith(expect.objectContaining({ rollout_enabled: false })),
      },
      {
        run: () => flows.rollbackRollout(),
        title: 'Roll back progressive rollout?',
        assert: () => expect(saveChannelChanges).toHaveBeenCalledWith(expect.objectContaining({ rollout_percentage_bps: 0 })),
      },
      {
        run: () => flows.promoteRollout(),
        title: 'Complete progressive rollout?',
        assert: () => expect(saveChannelChanges).toHaveBeenCalledWith(expect.objectContaining({ version: 42 })),
      },
      {
        run: () => flows.toggleRolloutPause(),
        title: 'Pause rollout?',
        assert: () => expect(saveChannelChanges).toHaveBeenCalledWith(expect.objectContaining({ rollout_paused_at: expect.any(String) })),
      },
    ] as const

    for (const testCase of cases) {
      saveChannelChange.mockClear()
      saveChannelChanges.mockClear()
      const cancelFlow = testCase.run()
      await nextTick()
      expect(container.textContent).toContain(testCase.title)
      await dismiss('Cancel')
      await cancelFlow
      expect(saveChannelChange).not.toHaveBeenCalled()
      expect(saveChannelChanges).not.toHaveBeenCalled()

      const confirmFlow = testCase.run()
      await nextTick()
      await dismiss('Confirm')
      await confirmFlow
      testCase.assert()
    }
  })

  it('update package descriptions stay documented for every option', () => {
    const { t } = mountDialogShell()
    for (const option of ['all', 'zip', 'delta', 'zip_from_builtin', 'delta_from_builtin'] as const) {
      expect(getUpdatePackageDescription(t, option).length).toBeGreaterThan(10)
    }
  })
})
