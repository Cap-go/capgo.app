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

/**
 * What a confirm needs about a channel it reads fresh (history rollbacks, promote
 * to another channel): what it serves and its rollout target. Null when it
 * cannot be read.
 */
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
 * The channel is read right before the confirm (another session may have
 * changed its bundle or started a rollout since the table loaded), and nothing
 * opens when that read fails. Resolves true when the bundle was set and the
 * table still shows that channel.
 */
export async function confirmAndRollbackChannel(options: {
  appId: string
  channelId: number
  bundle: { id: number, name: string }
  stillSameChannel: () => boolean
}): Promise<boolean> {
  const { t } = i18n.global
  const context = await readChannelRollbackContext(options.channelId)
  if (!options.stillSameChannel())
    return false
  if (!context) {
    toast.error(t('channel-impact-bundle-read-failed'))
    return false
  }
  const result = await confirmChannelChange({
    appId: options.appId,
    channelId: options.channelId,
    channelName: context.channelName,
    action: 'set',
    bundle: options.bundle,
    currentBundleName: context.versionName,
    // A new stable bundle resets any configured rollout (channel trigger); the
    // same bundle again does not change the version, so the rollout stays.
    stopsRolloutTarget: context.versionId === options.bundle.id ? null : context.rolloutTargetName,
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
