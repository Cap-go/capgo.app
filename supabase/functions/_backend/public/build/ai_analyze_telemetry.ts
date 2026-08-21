import type { Context } from 'hono'
import { cloudlogErr, serializeError } from '../../utils/logging.ts'
import { sendEventToTracking } from '../../utils/tracking.ts'

export type AiAnalysisResult
  = | 'success'
    | 'already_analyzed'
    | 'invalid_state'
    | 'unauthorized'
    | 'builder_error'
    | 'config_error'
    | 'logs_too_big'
    | 'mid_stream_error'
    | 'refunded'
    | 'upgrade_required'

export interface EmitAiAnalysisResultInput {
  appId: string
  jobId: string
  result: AiAnalysisResult
  ownerOrg?: string
  userId: string
  logsBytes: number
  durationMs?: number
}

/**
 * Emit the `AI Build Analysis Result` event for an exit branch.
 *
 * Privacy boundary: the AI diagnosis text from the builder MUST NOT cross into any
 * tag here. Only the closed-enum `result`, size/duration metadata, and stable
 * identifiers are sent. Callers fire this before throwing (or before returning a
 * successful response) so every exit branch produces exactly one Result event.
 */
export async function emitAiAnalysisResult(c: Context, input: EmitAiAnalysisResultInput): Promise<void> {
  const tags: Record<string, string> = {
    app_id: input.appId,
    job_id: input.jobId,
    result: input.result,
    logs_bytes: String(input.logsBytes),
  }
  if (input.ownerOrg)
    tags.org_id = input.ownerOrg
  if (input.durationMs !== undefined && Number.isFinite(input.durationMs))
    tags.duration_ms = String(Math.round(input.durationMs))

  // Telemetry MUST NOT break the AI analyze flow.
  try {
    await sendEventToTracking(c, {
      event: 'AI Build Analysis Result',
      channel: 'build-lifecycle',
      user_id: input.userId,
      groups: input.ownerOrg ? { organization: input.ownerOrg } : undefined,
      tags,
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'AI Build Analysis Result telemetry failed',
      result: input.result,
      error: serializeError(error),
    })
  }
}
