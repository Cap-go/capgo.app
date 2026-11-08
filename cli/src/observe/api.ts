import { z } from 'zod'
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
  const baseSchema = z.object({ app_id: z.literal(options.appId), view: z.literal(options.view ?? 'summary') }).passthrough()
  let schema = baseSchema
  if (options.view === 'release')
    schema = baseSchema.extend({ release: z.record(z.string(), z.unknown()).nullable() })
  else if (options.view === 'errors')
    schema = baseSchema.extend({ summary: z.record(z.string(), z.unknown()), actions: z.array(z.record(z.string(), z.unknown())), samples: z.array(z.record(z.string(), z.unknown())) })
  const result = schema.safeParse(data)
  if (!result.success)
    throw new CliUserError('Capgo returned an invalid Observe response. Retry the read; missing telemetry does not prove the release is healthy.')
  return result.data
}
