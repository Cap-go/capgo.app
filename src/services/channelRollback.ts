import { toast } from 'vue-sonner'
import { confirmChannelChange } from '~/composables/useChannelChangeConfirm'
import { i18n } from '~/modules/i18n'
import { invalidateChannelImpact } from '~/services/channelImpact'
import { channelUpdatePackageErrorKey } from '~/services/channelUpdatePackageError'
import { useConsole } from '~/services/console'

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
