import type { OrganizationDeleteOptions } from '../schemas/organization'
import { confirm as confirmC, intro, isCancel, log, outro } from '@clack/prompts'
import { checkAlerts } from '../api/update'
import { CliUserError } from '../shared/cli-user-error'
import {
  assertOrgPermission,
  check2FAAccessForOrg,
  findSavedKey,
  formatError,
  invokeCapgoCliApi,
  sendEvent,
} from '../utils'

export async function deleteOrganizationInternal(
  orgId: string,
  options: OrganizationDeleteOptions,
  silent = false,
) {
  if (!silent)
    intro('Deleting organization')

  await checkAlerts()

  const enrichedOptions: OrganizationDeleteOptions = {
    ...options,
    apikey: options.apikey || findSavedKey(),
  }

  if (!enrichedOptions.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to delete an organization')
    throw new Error('Missing API key')
  }

  if (!orgId) {
    if (!silent)
      log.error('Missing argument, you need to provide an organization ID')
    throw new Error('Missing organization id')
  }

  const hostOptions = {
    supaHost: enrichedOptions.supaHost,
    supaAnon: enrichedOptions.supaAnon,
  }
  await assertOrgPermission(null, enrichedOptions.apikey, 'org.delete', orgId, `Insufficient permissions to delete organization ${orgId}`, silent, hostOptions)
  await check2FAAccessForOrg(enrichedOptions.apikey, orgId, silent, hostOptions)

  const { data: orgData, error: orgError } = await invokeCapgoCliApi<{ name?: string, created_by?: string }>(
    `organization?orgId=${encodeURIComponent(orgId)}`,
    {
      apikey: enrichedOptions.apikey,
      method: 'GET',
      body: undefined,
      supaHost: enrichedOptions.supaHost,
      supaAnon: enrichedOptions.supaAnon,
    },
  )

  if (orgError || !orgData?.name) {
    if (!silent)
      log.error(`Cannot get organization details ${formatError(orgError)}`)
    throw new Error(`Cannot get organization details: ${formatError(orgError)}`)
  }

  if (!silent && !enrichedOptions.autoConfirm) {
    const confirmDelete = await confirmC({
      message: `Are you sure you want to delete organization "${orgData.name}"? This action cannot be undone.`,
    })

    if (isCancel(confirmDelete) || !confirmDelete) {
      log.warn('Canceled deleting the organization')
      throw new CliUserError('Organization deletion cancelled')
    }
  }

  if (!silent)
    log.info(`Deleting organization "${orgData.name}"`)

  const { error: dbError } = await invokeCapgoCliApi('organization', {
    apikey: enrichedOptions.apikey,
    method: 'DELETE',
    body: { orgId },
    supaHost: enrichedOptions.supaHost,
    supaAnon: enrichedOptions.supaAnon,
  })

  if (dbError) {
    if (!silent)
      log.error(`Could not delete organization ${formatError(dbError)}`)
    throw new Error(`Could not delete organization: ${formatError(dbError)}`)
  }

  await sendEvent(enrichedOptions.apikey, {
    channel: 'organization',
    event: 'Organization Deleted',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'org-name': orgData.name,
    },
  }).catch(() => {})

  if (!silent) {
    log.success(`Organization "${orgData.name}" deleted from Capgo`)
    outro('Done ✅')
  }

  return true
}

export async function deleteOrganization(orgId: string, options: OrganizationDeleteOptions) {
  await deleteOrganizationInternal(orgId, options, false)
}
