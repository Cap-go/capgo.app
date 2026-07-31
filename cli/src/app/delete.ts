import type { OptionsBase } from '../schemas/base'
import { intro, isCancel, log, outro, select } from '@clack/prompts'
import { checkAppExistsAndHasPermissionOrgErr, getAppIconStoragePath } from '../api/app'
import {
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getConfig,
  getOrganizationId,
  resolveUserIdFromApiKey,
  sendEvent,
} from '../utils'

export async function deleteAppInternal(
  initialAppId: string,
  options: OptionsBase,
  silent = false,
  skipConfirmation = false,
) {
  if (!silent)
    intro('Deleting')

  options.apikey = options.apikey || findSavedKey()
  const extConfig = await getConfig()
  const appId = getAppId(initialAppId, extConfig?.config)

  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to upload your bundle')
    throw new Error('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  const userId = await resolveUserIdFromApiKey(supabase, options.apikey)

  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.delete', silent)

  const { data: appOwnerRaw, error: appOwnerError } = await supabase.from('apps')
    .select('owner_org ( created_by, id )')
    .eq('app_id', appId)
    .single()

  const appOwner = appOwnerRaw as { owner_org: { created_by: string, id: string } } | null

  if (!skipConfirmation && !appOwnerError && (appOwner?.owner_org.created_by ?? '') !== userId) {
    if (!silent) {
      log.warn('Deleting the app is not recommended for users that are not the organization owner')
      log.warn('You are invited as a super_admin but your are not the owner')
      log.warn('It\'s strongly recommended that you do not continue!')

      const shouldContinue = await select({
        message: 'Do you want to continue?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      })

      if (isCancel(shouldContinue) || shouldContinue === 'no') {
        log.error('Canceled deleting the app, exiting')
        throw new Error('App deletion cancelled')
      }
    }
    else {
      throw new Error('Cannot delete app: you are not the organization owner')
    }
  }
  else if (appOwnerError && !silent) {
    log.warn(`Cannot get the app owner ${formatError(appOwnerError)}`)
  }

  const { error: storageError } = appOwner?.owner_org.id
    ? await supabase
        .storage
        .from('images')
        .remove([getAppIconStoragePath(appOwner.owner_org.id, appId)])
    : { error: null }

  if (storageError && !silent) {
    log.error('Could not delete app logo')
  }

  const { error: delError } = await supabase
    .storage
    .from(`apps/${appId}/${userId}`)
    .remove(['versions'])

  if (delError && !silent)
    log.error('Could not delete app version')

  const { error: dbError } = await supabase
    .from('apps')
    .delete()
    .eq('app_id', appId)

  if (dbError) {
    if (!silent)
      log.error('Could not delete app')
    throw new Error(`Could not delete app: ${formatError(dbError)}`)
  }

  const orgId = await getOrganizationId(supabase, appId)
  await sendEvent(options.apikey, {
    channel: 'app',
    event: 'App Deleted',
    icon: '🗑️',
    org_id: orgId,
    tracking_version: 2,
    tags: { 'app-id': appId },
    notify: false,
  }).catch(() => {})

  if (!silent) {
    log.success('App deleted in Capgo')
    outro('Done ✅')
  }

  return true
}

export async function deleteApp(
  initialAppId: string,
  options: OptionsBase,
) {
  return deleteAppInternal(initialAppId, options, false, false)
}
