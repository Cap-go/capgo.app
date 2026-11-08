import { z } from 'zod'
import { observeViewSchema } from '../schemas/sdk'
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
      source: options.source,
      channelId: options.channelId,
      action: options.action,
      deviceId: options.deviceId,
      versionName: options.versionName,
      sort: options.sort,
      limit: options.limit,
    },
    apiHost: options.apiHost,
  })
  if (error)
    throw new CliUserError(await formatCapgoCliInvokeError(error))
  const baseSchema = z.object({ app_id: z.string(), view: observeViewSchema }).passthrough()
  const schema = options.view === 'release' ? baseSchema.extend({ release: z.record(z.string(), z.unknown()).nullable() }) : baseSchema
  const result = schema.safeParse(data)
  if (!result.success)
    throw new CliUserError('Capgo returned an invalid Observe response. Retry the read; missing telemetry does not prove the release is healthy.')
  return result.data
}
