import type { OptionsBase } from '../schemas/base'
import { intro, isCancel, log, outro, select } from '@clack/prompts'
import { checkAppExistsAndHasPermissionOrgErr, getAppIconStoragePath } from '../api/app'
import { CliUserError } from '../shared/cli-user-error'
import {
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getCapgoCliHttpStatus,
  getConfig,
  invokeCapgoCliApi,
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
  // TODO(cli-http): identity still uses rpc via resolveUserIdFromApiKey
  const userId = await resolveUserIdFromApiKey(supabase, options.apikey)

  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.delete', silent)

  const { data: appData, error: appError } = await invokeCapgoCliApi<{
    owner_org?: string
    app_id?: string
  } & Record<string, unknown>>(`app/${encodeURIComponent(appId)}`, {
    apikey: options.apikey,
    method: 'GET',
    body: undefined,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (appError && getCapgoCliHttpStatus(appError) !== 404) {
    if (!silent)
      log.warn(`Cannot get the app owner ${formatError(appError)}`)
  }

  const orgId = typeof appData?.owner_org === 'string' ? appData.owner_org : undefined
  if (!orgId) {
    const message = `Cannot verify organization ownership for app ${appId}`
    if (!silent)
      log.error(message)
    throw new Error(message)
  }

  // Owner confirmation previously joined orgs.created_by; GET app does not include that.
  // TODO(cli-http): GET organization returns created_by — use it for owner confirmation
  const { data: orgData, error: orgError } = await invokeCapgoCliApi<{ created_by?: string }>(
    `organization?orgId=${encodeURIComponent(orgId)}`,
    {
      apikey: options.apikey,
      method: 'GET',
      body: undefined,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    },
  )
  const orgCreatedBy = typeof orgData?.created_by === 'string' ? orgData.created_by : undefined
  if (orgError || !orgCreatedBy) {
    const message = `Cannot verify organization ownership for app ${appId}`
    if (!silent)
      log.error(message)
    throw new Error(message)
  }

  if (!skipConfirmation && orgCreatedBy !== userId) {
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
        log.warn('Canceled deleting the app, exiting')
        throw new CliUserError('App deletion cancelled')
      }
    }
    else {
      throw new Error('Cannot delete app: you are not the organization owner')
    }
  }

  const { error: storageError } = orgId
    ? await supabase
        .storage
        .from('images')
        .remove([getAppIconStoragePath(orgId, appId)])
    : { error: null }

  if (storageError && !silent)
    log.error('Could not delete app logo')

  // TODO(cli-http): user-scoped storage path apps/${appId}/${userId} cleanup is not covered by DELETE app
  const { error: delError } = await supabase
    .storage
    .from(`apps/${appId}/${userId}`)
    .remove(['versions'])

  if (delError && !silent)
    log.error('Could not delete app version')

  const { error: dbError } = await invokeCapgoCliApi(`app/${encodeURIComponent(appId)}`, {
    apikey: options.apikey,
    method: 'DELETE',
    body: undefined,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (dbError) {
    if (!silent)
      log.error('Could not delete app')
    throw new Error(`Could not delete app: ${formatError(dbError)}`)
  }

  if (orgId) {
    await sendEvent(options.apikey, {
      channel: 'app',
      event: 'App Deleted',
      icon: '🗑️',
      org_id: orgId,
      tracking_version: 2,
      tags: { 'app-id': appId },
      notify: false,
    }).catch(() => {})
  }

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
