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
    rollout_cache_ttl_seconds?: number | null
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

export function isRolloutPercentageDraftChanged(draft: string | number, currentBps: number) {
  const normalized = String(draft ?? '').trim()
  if (!normalized)
    return false
  const parsed = Number.parseFloat(normalized)
  if (Number.isNaN(parsed))
    return true
  return Math.round(parsed * 100) !== currentBps
}

export function parseRolloutCacheTtlSeconds(draft: string | number) {
  const parsed = Number(String(draft ?? '').trim())
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 31536000)
    return null
  return parsed
}

const ROLLOUT_CACHE_TTL_UNITS = [
  { seconds: 86400, one: 'day', many: 'days' },
  { seconds: 3600, one: 'hour', many: 'hours' },
  { seconds: 60, one: 'minute', many: 'minutes' },
  { seconds: 1, one: 'second', many: 'seconds' },
] as const

export function formatRolloutCacheTtlHuman(seconds: number, t: Translate) {
  let remaining = Math.max(0, Math.floor(seconds))
  const parts: string[] = []
  for (const unit of ROLLOUT_CACHE_TTL_UNITS) {
    const count = Math.floor(remaining / unit.seconds)
    if (count <= 0)
      continue
    remaining %= unit.seconds
    parts.push(`${count} ${t(count === 1 ? unit.one : unit.many)}`)
  }
  if (parts.length === 0)
    return `0 ${t('seconds')}`
  return parts.join(' ')
}

export function formatRolloutCacheTtlDisplay(seconds: number, t: Translate) {
  return t('cache-ttl-display', {
    human: formatRolloutCacheTtlHuman(seconds, t),
    seconds: String(seconds),
  })
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

  async function applyRolloutSettings(input: { percentage: string | number, cacheTtlSeconds?: string | number }) {
    const percentage = Number.parseFloat(String(input.percentage).trim())
    if (Number.isNaN(percentage) || percentage < 0 || percentage > 100) {
      deps.toast.error(deps.t('invalid-rollout-percentage'))
      return
    }
    const nextBps = Math.round(percentage * 100)
    const currentBps = deps.getChannel()?.rollout_percentage_bps ?? 0
    const percentChanged = nextBps !== currentBps
    const hasTtl = input.cacheTtlSeconds !== undefined
    let nextTtl: number | undefined
    let ttlChanged = false
    if (hasTtl) {
      const parsedTtl = parseRolloutCacheTtlSeconds(input.cacheTtlSeconds as string | number)
      if (parsedTtl == null) {
        deps.toast.error(deps.t('invalid-rollout-cache-ttl'))
        return
      }
      nextTtl = parsedTtl
      ttlChanged = parsedTtl !== (deps.getChannel()?.rollout_cache_ttl_seconds ?? 2592000)
    }
    if (!percentChanged && !ttlChanged) {
      deps.toast.info(hasTtl
        ? deps.t('rollout-settings-unchanged')
        : deps.t('rollout-percentage-unchanged', { percent: formatRolloutPercentageLabel(percentage) }))
      return
    }
    const changes: Record<string, unknown> = {}
    if (percentChanged)
      changes.rollout_percentage_bps = nextBps
    if (ttlChanged)
      changes.rollout_cache_ttl_seconds = nextTtl
    await confirm({
      id: hasTtl ? 'confirm-rollout-settings' : 'confirm-rollout-percentage',
      title: hasTtl ? deps.t('confirm-rollout-settings-title') : deps.t('confirm-rollout-percentage-title'),
      description: hasTtl
        ? deps.t('confirm-rollout-settings-description', {
            percent: formatRolloutPercentageLabel(percentage),
            ttl: formatRolloutCacheTtlDisplay(nextTtl ?? deps.getChannel()?.rollout_cache_ttl_seconds ?? 2592000, deps.t),
          })
        : deps.t('confirm-rollout-percentage-description', {
            current: formatRolloutPercentageLabel(currentBps / 100),
            next: formatRolloutPercentageLabel(percentage),
          }),
      onConfirm: async () => {
        await deps.saveChannelChanges(changes)
      },
    })
  }

  async function applyRolloutPercentage(draftValue: string | number) {
    await applyRolloutSettings({ percentage: draftValue })
  }

  async function applyAutoPauseSettings(changes: Record<string, unknown>) {
    if (Object.keys(changes).length === 0) {
      deps.toast.info(deps.t('auto-pause-settings-unchanged'))
      return
    }
    await confirm({
      id: 'confirm-auto-pause-settings',
      title: deps.t('confirm-auto-pause-settings-title'),
      description: deps.t('confirm-auto-pause-settings-description'),
      onConfirm: async () => {
        await deps.saveChannelChanges(changes)
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
    let promoteWriteStarted = false
    await confirm({
      id: 'confirm-promote-rollout',
      title: deps.t('confirm-promote-rollout-title'),
      description: deps.t('confirm-promote-rollout-description', {
        target: promotedTargetName,
      }),
      onConfirm: async () => {
        if (promoteWriteStarted)
          return
        const liveTarget = deps.getChannel()?.rollout_version
        if (liveTarget != null && liveTarget !== promotedVersionId) {
          deps.toast.error(deps.t('error-invalid-version'))
          return
        }
        promoteWriteStarted = true
        const saved = await deps.saveChannelChanges({
          version: promotedVersionId,
          rollout_version: null,
          rollout_enabled: false,
          rollout_percentage_bps: 0,
          rollout_paused_at: null,
          rollout_pause_reason: null,
        })
        if (!saved) {
          promoteWriteStarted = false
          return
        }
        await deps.askUpdateNotificationAfterBundleChange()
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
    applyRolloutSettings,
    applyRolloutPercentage,
    applyAutoPauseSettings,
    enableRollout,
    rollbackRollout,
    promoteRollout,
    toggleRolloutPause,
    confirmSetRolloutTarget,
  }
}
