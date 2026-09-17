// @vitest-environment happy-dom

import type { App } from 'vue'
import type { ChannelRolloutConfirmFlowsDeps } from '../src/utils/channelRolloutConfirmFlows'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import { useDialogV2Store } from '../src/stores/dialogv2'
import { createChannelRolloutConfirmFlows, formatRolloutCacheTtlDisplay, formatRolloutCacheTtlHuman, isRolloutPercentageDraftChanged } from '../src/utils/channelRolloutConfirmFlows'
import { getUpdatePackageDescription, getUpdatePackageInfoDescription } from '../src/utils/channelUpdatePackageCopy'
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
            disabled: button.disabled,
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
  rollout_cache_ttl_seconds?: number | null
  rollout_paused_at?: string | null
}

function createTestFlows(options: {
  container: HTMLElement
  t: (key: string, params?: Record<string, unknown>) => string
  channel: TestChannel
  saveChannelChange?: ReturnType<typeof vi.fn>
  saveChannelChanges?: ReturnType<typeof vi.fn>
  askUpdateNotificationAfterBundleChange?: ReturnType<typeof vi.fn>
  canUpdate?: boolean
}) {
  const dialogStore = useDialogV2Store()
  const saveChannelChange = options.saveChannelChange ?? vi.fn(async () => true)
  const saveChannelChanges = options.saveChannelChanges ?? vi.fn(async () => true)
  const askUpdateNotificationAfterBundleChange = options.askUpdateNotificationAfterBundleChange ?? vi.fn(async () => {})
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
    askUpdateNotificationAfterBundleChange: askUpdateNotificationAfterBundleChange as ChannelRolloutConfirmFlowsDeps['askUpdateNotificationAfterBundleChange'],
    openSelectRolloutVersion,
  })

  return {
    flows,
    saveChannelChange,
    saveChannelChanges,
    askUpdateNotificationAfterBundleChange,
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

  it('promoteRollout second confirm after save does not unlink the stable bundle', async () => {
    const { container, dialogStore, t } = mountDialogShell()
    const channel: TestChannel = { rollout_version: 202 }
    const writes: Record<string, unknown>[] = []
    let releaseNotification: () => void = () => {}
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve
    })
    const saveChannelChanges = vi.fn(async (changes: Record<string, unknown>) => {
      writes.push({ ...changes })
      if (Object.prototype.hasOwnProperty.call(changes, 'rollout_version'))
        channel.rollout_version = changes.rollout_version as number | null
      return true
    })
    const { flows } = createTestFlows({
      container,
      t,
      channel,
      saveChannelChanges,
      askUpdateNotificationAfterBundleChange: vi.fn(() => notificationGate),
    })

    const promote = flows.promoteRollout()
    await nextTick()
    findDialogButton(container, 'Confirm').click()
    await vi.waitFor(() => expect(saveChannelChanges).toHaveBeenCalledTimes(1))
    expect(writes[0]).toEqual(expect.objectContaining({ version: 202, rollout_version: null }))
    expect(channel.rollout_version).toBeNull()
    await nextTick()
    expect(findDialogButton(container, 'Confirm').disabled).toBe(true)

    findDialogButton(container, 'Confirm').click()
    const enabledConfirm = dialogStore.dialogOptions.buttons?.find(button => button.role === 'primary')
    expect(enabledConfirm).toBeDefined()
    await dialogStore.closeDialog({
      text: 'Confirm',
      role: 'primary',
      handler: enabledConfirm?.handler,
    })
    await dialogStore.closeDialog(enabledConfirm)

    releaseNotification()
    await promote
    expect(saveChannelChanges).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([expect.objectContaining({ version: 202, rollout_version: null })])
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

  it('empty rollout percentage draft is unchanged while invalid and out-of-range stay dirty', () => {
    expect(isRolloutPercentageDraftChanged('', 1000)).toBe(false)
    expect(isRolloutPercentageDraftChanged('   ', 1000)).toBe(false)
    expect(isRolloutPercentageDraftChanged('10', 1000)).toBe(false)
    expect(isRolloutPercentageDraftChanged('abc', 1000)).toBe(true)
    expect(isRolloutPercentageDraftChanged('25', 1000)).toBe(true)
    expect(isRolloutPercentageDraftChanged('150', 1000)).toBe(true)
  })

  it('number drafts from type=number v-model do not throw and compare in bps', () => {
    expect(isRolloutPercentageDraftChanged(10, 1000)).toBe(false)
    expect(isRolloutPercentageDraftChanged(1, 1000)).toBe(true)
    expect(isRolloutPercentageDraftChanged(25, 2500)).toBe(false)
    expect(isRolloutPercentageDraftChanged(0, 0)).toBe(false)
  })

  it('applyRolloutPercentage cancel skips save and confirm updates bps', async () => {
    const { container, t } = mountDialogShell()
    const channel: TestChannel = { rollout_percentage_bps: 1000 }
    const { flows, saveChannelChange, saveChannelChanges, dismiss } = createTestFlows({ container, t, channel })

    const firstApply = flows.applyRolloutPercentage('25')
    await nextTick()
    expect(container.textContent).toContain('Apply rollout percentage?')

    await dismiss('Cancel')
    await firstApply
    expect(saveChannelChange).not.toHaveBeenCalled()
    expect(saveChannelChanges).not.toHaveBeenCalled()

    const secondApply = flows.applyRolloutPercentage('25')
    await nextTick()
    await dismiss('Confirm')
    await secondApply
    expect(saveChannelChanges).toHaveBeenCalledWith({ rollout_percentage_bps: 2500 })

    const numericApply = flows.applyRolloutPercentage(40)
    await nextTick()
    await dismiss('Confirm')
    await numericApply
    expect(saveChannelChanges).toHaveBeenCalledWith({ rollout_percentage_bps: 4000 })
  })

  it('applyRolloutSettings confirms percentage and cache TTL together', async () => {
    const { container, t } = mountDialogShell()
    const channel: TestChannel = { rollout_percentage_bps: 1000, rollout_cache_ttl_seconds: 2592000 }
    const { flows, saveChannelChanges, dismiss } = createTestFlows({ container, t, channel })

    const apply = flows.applyRolloutSettings({ percentage: 25, cacheTtlSeconds: 3600 })
    await nextTick()
    expect(container.textContent).toContain('Update rollout settings?')
    expect(container.textContent).toContain('1 hour (3600s)')
    await dismiss('Confirm')
    await apply
    expect(saveChannelChanges).toHaveBeenCalledWith({
      rollout_percentage_bps: 2500,
      rollout_cache_ttl_seconds: 3600,
    })
  })

  it('applyRolloutSettings rejects an out-of-range cache TTL', async () => {
    const { container, t } = mountDialogShell()
    const channel: TestChannel = { rollout_percentage_bps: 1000, rollout_cache_ttl_seconds: 2592000 }
    const { flows, saveChannelChanges, toast } = createTestFlows({ container, t, channel })

    await flows.applyRolloutSettings({ percentage: 25, cacheTtlSeconds: 30 })
    expect(toast.error).toHaveBeenCalledWith(t('invalid-rollout-cache-ttl'))
    expect(saveChannelChanges).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Update rollout settings?')
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

  it('rollout settings info dialog shows help copy without confirm actions', async () => {
    const { container, dialogStore, t } = mountDialogShell()
    dialogStore.openDialog({
      id: 'rollout-settings-info',
      title: t('progressive-rollout'),
      description: `${t('rollout-settings-help')}\n\n${t('rollout-percentage-help')}\n\n${t('cache-ttl-help')}`,
      buttons: [{ text: t('close'), role: 'primary' }],
    })
    await nextTick()
    expect(container.textContent).toContain('Progressive rollout')
    expect(container.textContent).toContain('Stable fallback stays for most devices')
    expect(container.textContent).toContain('Share of eligible devices in the sticky rollout cohort')
    expect(container.textContent).toContain('cached server-side')
    expect(container.textContent).not.toContain('Confirm')
    findDialogButton(container, 'Close').click()
    await nextTick()
    expect(dialogStore.showDialog).toBe(false)
  })

  it('update package info dialog shows current format help without confirm actions', async () => {
    const { container, dialogStore, t } = mountDialogShell()
    dialogStore.openDialog({
      id: 'update-package-info',
      title: t('update-package'),
      description: getUpdatePackageInfoDescription(t, 'all'),
      buttons: [{ text: t('close'), role: 'primary' }],
    })
    await nextTick()
    expect(container.textContent).toContain('Download format')
    expect(container.textContent).toContain('Controls what each device downloads on update check')
    expect(container.textContent).toContain('Zip + delta (default)')
    expect(container.textContent).toContain('Devices that support delta get changed files only')
    expect(container.textContent).not.toContain('Confirm')
    findDialogButton(container, 'Close').click()
    await nextTick()
    expect(dialogStore.showDialog).toBe(false)
  })

  it('formats cache TTL as a human duration', () => {
    const { t } = mountDialogShell()
    expect(formatRolloutCacheTtlHuman(2592000, t)).toBe('30 days')
    expect(formatRolloutCacheTtlHuman(3600, t)).toBe('1 hour')
    expect(formatRolloutCacheTtlHuman(90, t)).toBe('1 minute 30 seconds')
    expect(formatRolloutCacheTtlDisplay(2592000, t)).toBe('30 days (2592000s)')
  })

  it('update package descriptions stay documented for every option', () => {
    const { t } = mountDialogShell()
    for (const option of ['all', 'zip', 'delta', 'zip_from_builtin', 'delta_from_builtin'] as const) {
      expect(getUpdatePackageDescription(t, option).length).toBeGreaterThan(10)
      expect(getUpdatePackageInfoDescription(t, option)).toContain(getUpdatePackageDescription(t, option))
    }
    expect(getUpdatePackageInfoDescription(t)).toContain(getUpdatePackageDescription(t, 'all'))
  })
})
