import type { ObserveOptions } from '../schemas/sdk'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, formatCapgoCliInvokeError, invokeCapgoCliApi } from '../utils'

export async function fetchObserve(options: ObserveOptions): Promise<Record<string, unknown>> {
  const apikey = options.apikey || findSavedKey(true)
  const { data, error } = await invokeCapgoCliApi<Record<string, unknown>>('private/observe', {
    apikey,
    method: 'POST',
    body: {
      appId: options.appId,
      view: options.view ?? 'summary',
      days: options.days,
      action: options.action,
      deviceId: options.deviceId,
      versionName: options.versionName,
      sort: options.sort,
      limit: options.limit,
    },
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  if (error)
    throw new CliUserError(await formatCapgoCliInvokeError(error))
  return data ?? {}
}
