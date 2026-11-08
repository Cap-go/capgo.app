import { z } from 'zod'
import type { BuildMonitorOptions } from '../schemas/sdk'
import { buildMonitorOptionsSchema } from '../schemas/sdk'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, formatCapgoCliInvokeError, invokeCapgoCliApi } from '../utils'

export async function fetchBuildMonitor(kind: 'status' | 'logs', options: BuildMonitorOptions): Promise<Record<string, unknown>> {
  const input = buildMonitorOptionsSchema.parse(options)
  const query = new URLSearchParams({ app_id: input.appId, job_id: input.jobId })
  if (kind === 'logs') {
    query.set('snapshot', 'true')
    if (input.cursor !== undefined)
      query.set('cursor', String(input.cursor))
  }
  const path = kind === 'status' ? 'build/status' : `build/logs/${encodeURIComponent(input.jobId)}`
  const { data, error } = await invokeCapgoCliApi<Record<string, unknown>>(`${path}?${query}`, {
    apikey: input.apikey || findSavedKey(true), method: 'GET', apiHost: input.apiHost,
    signal: AbortSignal.timeout(20_000),
  })
  if (error)
    throw new CliUserError(await formatCapgoCliInvokeError(error))
  const schema = kind === 'status'
    ? z.object({ job_id: z.string(), status: z.string().trim().min(1) }).passthrough()
    : z.object({ job_id: z.string(), logs: z.string(), cursor: z.number().int().nonnegative(), truncated: z.boolean() }).passthrough()
  const result = schema.safeParse(data)
  if (!result.success)
    throw new CliUserError(`Capgo returned an invalid build ${kind} response. Retry the read; do not infer build success from missing data.`)
  return result.data
}
