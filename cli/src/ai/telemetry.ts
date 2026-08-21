import type { PostAnalyzeResult } from './analyze.js'
import { sendEvent } from '../utils.js'

export type AiAnalysisChoice = 'capgo_ai' | 'local_ai' | 'skip' | 'auto_upload' | 'retry'
export type AiAnalysisTriggeredBy = 'menu' | 'ci_flag' | 'onboarding'
export type AiAnalysisResult = 'success' | 'already_analyzed' | 'too_big' | 'error' | 'mid_stream_error' | 'upgrade_required'

// Closed-enum mapper for PostAnalyzeResult → telemetry result tag. Shared by
// the build-failure flow and both onboarding TUIs so a new PostAnalyzeResult
// variant cannot update one path and silently skew telemetry in the other.
// Never include the analysis text itself in telemetry.
export function aiAnalysisResultFromPostAnalyze(result: PostAnalyzeResult): AiAnalysisResult {
  if (result.kind === 'ok')
    return 'success'
  if (result.kind === 'already_analyzed')
    return 'already_analyzed'
  if (result.kind === 'too_big')
    return 'too_big'
  if (result.kind === 'upgrade_required')
    return 'upgrade_required'
  return result.partial !== undefined ? 'mid_stream_error' : 'error'
}

export interface TrackAiAnalysisChoiceInput {
  apikey: string
  orgId: string
  appId: string
  platform: 'ios' | 'android'
  jobId: string
  choice: AiAnalysisChoice
  triggeredBy: AiAnalysisTriggeredBy
}

export interface TrackAiAnalysisResultInput {
  apikey: string
  orgId: string
  appId: string
  platform: 'ios' | 'android'
  jobId: string
  result: AiAnalysisResult
  errorStatus?: number
}

/**
 * Emit `CLI AI Build Analysis Choice` for every branch the user (or CI flag) selected.
 *
 * Privacy boundary: only closed-enum choice + triggered_by metadata is sent. The
 * AI diagnosis text is never observed at this stage.
 */
export async function trackAiAnalysisChoice(input: TrackAiAnalysisChoiceInput): Promise<void> {
  try {
    await sendEvent(input.apikey, {
      event: 'CLI AI Build Analysis Choice',
      channel: 'build-lifecycle',
      org_id: input.orgId,
      tracking_version: 2,
      tags: {
        app_id: input.appId,
        platform: input.platform,
        job_id: input.jobId,
        choice: input.choice,
        triggered_by: input.triggeredBy,
      },
    })
  }
  catch {
    // Telemetry must never break the build flow.
  }
}

/**
 * Emit `CLI AI Build Analysis Result` only for paths that actually hit the server
 * (capgo_ai or auto_upload).
 *
 * Privacy boundary: the AI analysis text (`result.analysis` in PostAnalyzeResult)
 * MUST NEVER appear in any tag here. Only the closed-enum `result` and optional
 * `error_status` cross the boundary.
 */
export async function trackAiAnalysisResult(input: TrackAiAnalysisResultInput): Promise<void> {
  const tags: Record<string, string> = {
    app_id: input.appId,
    platform: input.platform,
    job_id: input.jobId,
    result: input.result,
  }
  if (input.result === 'error' && typeof input.errorStatus === 'number' && Number.isFinite(input.errorStatus))
    tags.error_status = String(input.errorStatus)

  try {
    await sendEvent(input.apikey, {
      event: 'CLI AI Build Analysis Result',
      channel: 'build-lifecycle',
      org_id: input.orgId,
      tracking_version: 2,
      tags,
    })
  }
  catch {
    // Telemetry must never break the build flow.
  }
}
