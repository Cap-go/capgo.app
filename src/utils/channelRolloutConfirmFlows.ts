import type { useDialogV2Store } from '~/stores/dialogv2'
import type { Database } from '~/types/supabase.types'
import { getUpdatePackageLabel } from '~/utils/channelUpdatePackageCopy'
import { confirmConsequentialChannelChange } from '~/utils/confirmConsequentialChannelChange'

type ChannelUpdatePackage = Database['public']['Enums']['channel_update_package']
type DialogStore = Pick<ReturnType<typeof useDialogV2Store>, 'openDialog' | 'onDialogDismiss'>

type Translate = (key: string, params?: Record<string, unknown>) => string

export interface ChannelRolloutConfirmFlowsDeps {
  dialogStore: DialogStore
  t: Translate
  toast: {
    error: (message: string) => void
    info: (message: string) => void
  }
  canUpdateChannelSettings: () => boolean
  closeUpdatePackageDropdown: () => void
  getChannel: () => ({
    update_package?: ChannelUpdatePackage | null
    rollout_version?: number | null
    rollout_percentage_bps?: number | null
    rollout_paused_at?: string | null
  } | undefined)
  rolloutTargetName: () => string
  stableBundleName: () => string
  rolloutPercentageText: () => string
  saveChannelChange: (key: string, value: unknown) => Promise<boolean | void>
  saveChannelChanges: (changes: Record<string, unknown>) => Promise<boolean>
  askUpdateNotificationAfterBundleChange: () => Promise<void>
  openSelectRolloutVersion: () => Promise<void>
}

function formatRolloutPercentageLabel(percentage: number) {
  return `${percentage.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
}

function buttonLabels(t: Translate) {
  return { cancel: t('button-cancel'), confirm: t('button-confirm') }
}

export function createChannelRolloutConfirmFlows(deps: ChannelRolloutConfirmFlowsDeps) {
  const confirm = (options: Parameters<typeof confirmConsequentialChannelChange>[2]) =>
    confirmConsequentialChannelChange(deps.dialogStore, buttonLabels(deps.t), options)

  async function onSelectUpdatePackage(value: ChannelUpdatePackage) {
    if (!deps.canUpdateChannelSettings()) {
      deps.toast.error(deps.t('no-permission'))
      return false
    }

    deps.closeUpdatePackageDropdown()
    if (value === deps.getChannel()?.update_package)
      return

    await confirm({
      id: 'confirm-update-package',
      title: deps.t('confirm-update-package-title'),
      description: deps.t('confirm-update-package-description', {
        current: getUpdatePackageLabel(deps.t, deps.getChannel()?.update_package),
        next: getUpdatePackageLabel(deps.t, value),
      }),
      onConfirm: async () => {
        await deps.saveChannelChange('update_package', value)
      },
    })
  }

  async function applyRolloutPercentage(draftValue: string) {
    const percentage = Number.parseFloat(draftValue)
    if (Number.isNaN(percentage) || percentage < 0 || percentage > 100) {
      deps.toast.error(deps.t('invalid-rollout-percentage'))
      return
    }
    const nextBps = Math.round(percentage * 100)
    const currentBps = deps.getChannel()?.rollout_percentage_bps ?? 0
    if (nextBps === currentBps) {
      deps.toast.info(deps.t('rollout-percentage-unchanged', { percent: formatRolloutPercentageLabel(percentage) }))
      return
    }
    const currentLabel = formatRolloutPercentageLabel(currentBps / 100)
    const nextLabel = formatRolloutPercentageLabel(percentage)
    await confirm({
      id: 'confirm-rollout-percentage',
      title: deps.t('confirm-rollout-percentage-title'),
      description: deps.t('confirm-rollout-percentage-description', {
        current: currentLabel,
        next: nextLabel,
      }),
      onConfirm: async () => {
        await deps.saveChannelChange('rollout_percentage_bps', nextBps)
      },
    })
  }

  async function enableRollout() {
    const channel = deps.getChannel()
    if (!channel)
      return
    if (!channel.rollout_version) {
      await deps.openSelectRolloutVersion()
      return
    }
    await confirm({
      id: 'confirm-enable-rollout',
      title: deps.t('confirm-enable-rollout-title'),
      description: deps.t('confirm-enable-rollout-description', {
        target: deps.rolloutTargetName(),
        fallback: deps.stableBundleName(),
        percent: deps.rolloutPercentageText(),
      }),
      onConfirm: async () => {
        await deps.saveChannelChange('rollout_enabled', true)
      },
    })
  }

  async function disableRollout() {
    await confirm({
      id: 'confirm-disable-rollout',
      title: deps.t('confirm-disable-rollout-title'),
      description: deps.t('confirm-disable-rollout-description', {
        fallback: deps.stableBundleName(),
      }),
      confirmRole: 'danger',
      onConfirm: async () => {
        if (await deps.saveChannelChanges({
          rollout_enabled: false,
          rollout_version: null,
          rollout_paused_at: null,
          rollout_pause_reason: null,
        })) {
          await deps.askUpdateNotificationAfterBundleChange()
        }
      },
    })
  }

  async function rollbackRollout() {
    await confirm({
      id: 'confirm-rollback-rollout',
      title: deps.t('confirm-rollback-rollout-title'),
      description: deps.t('confirm-rollback-rollout-description', {
        target: deps.rolloutTargetName(),
        fallback: deps.stableBundleName(),
      }),
      confirmRole: 'danger',
      onConfirm: async () => {
        if (await deps.saveChannelChanges({
          rollout_version: null,
          rollout_enabled: false,
          rollout_percentage_bps: 0,
          rollout_paused_at: null,
          rollout_pause_reason: null,
        })) {
          await deps.askUpdateNotificationAfterBundleChange()
        }
      },
    })
  }

  async function promoteRollout() {
    const promotedVersionId = deps.getChannel()?.rollout_version
    if (!promotedVersionId)
      return
    const promotedTargetName = deps.rolloutTargetName()
    await confirm({
      id: 'confirm-promote-rollout',
      title: deps.t('confirm-promote-rollout-title'),
      description: deps.t('confirm-promote-rollout-description', {
        target: promotedTargetName,
      }),
      onConfirm: async () => {
        if (await deps.saveChannelChanges({
          version: promotedVersionId,
          rollout_version: null,
          rollout_enabled: false,
          rollout_percentage_bps: 0,
          rollout_paused_at: null,
          rollout_pause_reason: null,
        })) {
          await deps.askUpdateNotificationAfterBundleChange()
        }
      },
    })
  }

  async function toggleRolloutPause() {
    if (deps.getChannel()?.rollout_paused_at) {
      await confirm({
        id: 'confirm-resume-rollout',
        title: deps.t('confirm-resume-rollout-title'),
        description: deps.t('confirm-resume-rollout-description', {
          percent: deps.rolloutPercentageText(),
          target: deps.rolloutTargetName(),
        }),
        onConfirm: async () => {
          await deps.saveChannelChanges({
            rollout_paused_at: null,
            rollout_pause_reason: null,
          })
        },
      })
      return
    }
    await confirm({
      id: 'confirm-pause-rollout',
      title: deps.t('confirm-pause-rollout-title'),
      description: deps.t('confirm-pause-rollout-description', {
        target: deps.rolloutTargetName(),
      }),
      onConfirm: async () => {
        await deps.saveChannelChanges({
          rollout_paused_at: new Date().toISOString(),
          rollout_pause_reason: deps.t('manual-rollout-pause'),
        })
      },
    })
  }

  async function confirmSetRolloutTarget(options: {
    currentTargetName: string
    nextTargetName: string
    onConfirm: () => Promise<void>
  }) {
    await confirm({
      id: 'confirm-set-rollout-target',
      title: deps.t('confirm-set-rollout-target-title'),
      description: deps.t('confirm-set-rollout-target-description', {
        current: options.currentTargetName,
        next: options.nextTargetName,
        percent: deps.rolloutPercentageText(),
        fallback: deps.stableBundleName(),
      }),
      onConfirm: options.onConfirm,
    })
  }

  return {
    onSelectUpdatePackage,
    applyRolloutPercentage,
    enableRollout,
    disableRollout,
    rollbackRollout,
    promoteRollout,
    toggleRolloutPause,
    confirmSetRolloutTarget,
  }
}
