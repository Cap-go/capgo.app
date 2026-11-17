import { toast } from 'vue-sonner'
import { confirmChannelChange } from '~/composables/useChannelChangeConfirm'
import { i18n } from '~/modules/i18n'
import { invalidateChannelImpact } from '~/services/channelImpact'
import { channelUpdatePackageErrorKey } from '~/services/channelUpdatePackageError'
import { useConsole } from '~/services/console'

export interface ChannelRollbackContext {
  channelName: string
  versionId: number | null
  /** Bundle the channel serves, or null for the store version. */
  versionName: string | null
  /** A rollback sets a new stable bundle, which resets any configured rollout. */
  rolloutTargetName: string | null
}

/** What the history tables need about a channel to offer a rollback; null when it cannot be read. */
export async function readChannelRollbackContext(channelId: number): Promise<ChannelRollbackContext | null> {
  try {
    const { data, error } = await useConsole()
      .from('channels')
      .select('name, version, current:app_versions!channels_version_fkey(name), rollout:app_versions!channels_rollout_version_fkey(name)')
      .eq('id', channelId)
      .single()
    if (error || !data) {
      console.error('Error fetching current version:', error)
      return null
    }
    const currentName = (data.current as { name: string } | null)?.name ?? null
    return {
      channelName: data.name,
      versionId: data.version,
      versionName: currentName && !['builtin', 'unknown'].includes(currentName) ? currentName : null,
      rolloutTargetName: (data.rollout as { name: string } | null)?.name ?? null,
    }
  }
  catch (error) {
    console.error('Error fetching current version:', error)
    return null
  }
}

/**
 * "Rollback to this version" from the history tables: the same impact confirm
 * as setting a bundle, then the write. Everything stays bound to the channel
 * the user confirmed; `stillSameChannel` says whether the table still shows it.
 * Resolves true when the bundle was set and the table still shows that channel.
 */
export async function confirmAndRollbackChannel(options: {
  appId: string
  channelId: number
  channelName: string
  bundle: { id: number, name: string }
  currentBundleName: string | null
  /** A rollback sets a new stable bundle, which resets any configured rollout. */
  rolloutTargetName: string | null
  stillSameChannel: () => boolean
}): Promise<boolean> {
  const { t } = i18n.global
  const result = await confirmChannelChange({
    appId: options.appId,
    channelId: options.channelId,
    channelName: options.channelName,
    action: 'set',
    bundle: options.bundle,
    currentBundleName: options.currentBundleName,
    stopsRolloutTarget: options.rolloutTargetName,
    title: t('rollback-to-version'),
    confirmText: t('rollback'),
  })
  if (!result.confirmed || !options.stillSameChannel())
    return false
  try {
    const { error } = await useConsole()
      .from('channels')
      .update({ version: options.bundle.id })
      .eq('id', options.channelId)
    if (error) {
      console.error('Error rolling back version:', error)
      toast.error(t(channelUpdatePackageErrorKey(error) ?? 'error-rollback'))
      return false
    }
  }
  catch (error) {
    console.error('Error rolling back version:', error)
    toast.error(t(channelUpdatePackageErrorKey(error) ?? 'error-rollback'))
    return false
  }
  invalidateChannelImpact(options.channelId)
  toast.success(t('rollback-success'))
  return options.stillSameChannel()
}
