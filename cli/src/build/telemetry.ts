import { sendEvent } from '../utils.js'

export type BuilderUploadFailureCategory
  = | 'network_error'
    | 'unauthorized'
    | 'payload_too_large'
    | 'storage_failure'
    | 'unknown'

type BuilderUploadPhase = 'started' | 'succeeded' | 'failed'

export interface TrackBuilderUploadInput {
  apikey: string
  appId: string
  orgId: string
  platform: 'ios' | 'android'
  buildMode: string
  jobId: string
  sizeBytes: number
  phase: BuilderUploadPhase
  durationSeconds?: number
  error?: unknown
}

interface MaybeTusResponse {
  originalResponse?: { getStatus?: () => unknown }
}

function getTusErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  const candidate = (error as MaybeTusResponse).originalResponse?.getStatus?.()
  return typeof candidate === 'number' ? candidate : undefined
}

export function mapBuilderUploadError(error: unknown): BuilderUploadFailureCategory {
  const status = getTusErrorStatus(error)
  if (status === 401 || status === 403)
    return 'unauthorized'
  if (status === 413)
    return 'payload_too_large'
  if (status !== undefined && status >= 500 && status < 600)
    return 'storage_failure'
  if (status === undefined || status === 0)
    return 'network_error'
  return 'unknown'
}

const EVENT_NAME_BY_PHASE: Record<BuilderUploadPhase, string> = {
  started: 'Builder Upload Started',
  succeeded: 'Builder Upload Succeeded',
  failed: 'Builder Upload Failed',
}

export async function trackBuilderUpload(input: TrackBuilderUploadInput): Promise<void> {
  const tags: Record<string, string> = {
    app_id: input.appId,
    platform: input.platform,
    build_mode: input.buildMode,
    job_id: input.jobId,
    upload_size_bytes: String(input.sizeBytes),
  }

  if (typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds))
    tags.upload_duration_seconds = String(Math.round(input.durationSeconds))

  if (input.phase === 'failed' && input.error !== undefined)
    tags.failure_category = mapBuilderUploadError(input.error)

  try {
    await sendEvent(input.apikey, {
      event: EVENT_NAME_BY_PHASE[input.phase],
      channel: 'build-lifecycle',
      org_id: input.orgId,
      tracking_version: 2,
      tags,
    })
  }
  catch {
    // never throw — telemetry must not break the build flow
  }
}
