import { randomUUID } from 'node:crypto'
import { getActiveCliReplaySessionId, isCliTelemetryDisabled } from './replay'

type TelemetryValue = string | number | boolean
type TelemetryProperties = Record<string, TelemetryValue>

export interface InitProgressTelemetry {
  journey_id: string
  last_run_id?: string
}

export interface InitTelemetryOptions {
  capture?: (event: string, properties: TelemetryProperties, icon: string, appId?: string) => Promise<void> | void
  enabled?: boolean
  replaySessionId?: () => string | undefined
}

interface ResumeCandidate extends InitProgressTelemetry {
  savedStep?: number
  totalSteps?: number
}

const journeyIdPattern = /^ij_[a-z0-9-]+$/i
const runIdPattern = /^ir_[a-z0-9-]+$/i

export function parseInitProgressTelemetry(progress: unknown): InitProgressTelemetry | undefined {
  if (!progress || typeof progress !== 'object')
    return undefined
  const telemetry = (progress as { telemetry?: unknown }).telemetry
  if (!telemetry || typeof telemetry !== 'object')
    return undefined
  const { journey_id, last_run_id } = telemetry as Partial<InitProgressTelemetry>
  if (typeof journey_id !== 'string' || !journeyIdPattern.test(journey_id))
    return undefined
  if (last_run_id !== undefined && (typeof last_run_id !== 'string' || !runIdPattern.test(last_run_id)))
    return { journey_id }
  return last_run_id ? { journey_id, last_run_id } : { journey_id }
}

export function mergeInitProgressTelemetry<T extends Record<string, unknown>>(progress: T, telemetry?: InitProgressTelemetry): T | (T & { telemetry: InitProgressTelemetry }) {
  return telemetry ? { ...progress, telemetry } : progress
}

export function createInitTelemetry(options: InitTelemetryOptions = {}) {
  const enabled = options.enabled ?? !isCliTelemetryDisabled()
  const runId = `ir_${randomUUID()}`
  const initialJourneyId = `ij_${randomUUID()}`
  const replaySessionId = options.replaySessionId ?? getActiveCliReplaySessionId
  let journeyId = initialJourneyId
  let candidate: ResumeCandidate | undefined
  let auth: { apikey: string, orgId: string } | undefined
  let appId: string | undefined
  let choice: 'continue' | 'restart' | undefined
  const recorded = new Set<string>()

  function properties(extra: TelemetryProperties = {}): TelemetryProperties {
    const sessionId = replaySessionId()
    return {
      ...extra,
      onboarding_event_version: 1,
      onboarding_journey_id: journeyId,
      onboarding_run_id: runId,
      ...(sessionId ? { $session_id: sessionId } : {}),
    }
  }

  async function emit(event: string, extra?: TelemetryProperties, once = false, icon = '✅', eventAppId: string | null = appId ?? null) {
    if (!enabled || (once && recorded.has(event)))
      return
    if (once)
      recorded.add(event)
    try {
      const eventProperties = properties(extra)
      if (options.capture)
        await options.capture(event, eventProperties, icon, eventAppId ?? undefined)
      else if (auth) {
        const { apikey, orgId } = auth
        await import('../app/debug').then(({ markSnag }) => markSnag('onboarding-v2', orgId, apikey, event, eventAppId ?? undefined, icon, eventProperties))
      }
    }
    catch {
      // Analytics is best-effort and must not interrupt onboarding.
    }
  }

  function resumeProperties(): TelemetryProperties {
    if (!candidate)
      return {}
    return {
      resume_journey_id: candidate.journey_id,
      ...(candidate.last_run_id ? { resumed_from_run_id: candidate.last_run_id } : {}),
      ...(candidate.savedStep === undefined ? {} : { saved_step: candidate.savedStep }),
    }
  }

  return {
    get journeyId() { return journeyId },
    get runId() { return runId },
    clearScope() { appId = undefined },
    getLegacyBackfillMetadata: () => enabled && candidate && !candidate.last_run_id ? { journey_id: candidate.journey_id } : undefined,
    getProgressMetadata: (): InitProgressTelemetry | undefined => {
      if (!enabled)
        return choice === 'continue' && candidate ? { journey_id: candidate.journey_id, ...(candidate.last_run_id ? { last_run_id: candidate.last_run_id } : {}) } : undefined
      return { journey_id: journeyId, last_run_id: runId }
    },
    prepareResumeCandidate: (saved?: InitProgressTelemetry, savedStep?: number, totalSteps?: number) => {
      if (!enabled && !saved)
        return undefined
      candidate = saved ? { ...saved, savedStep, totalSteps } : { journey_id: `ij_${randomUUID()}`, savedStep, totalSteps }
      return { journey_id: candidate.journey_id, ...(candidate.last_run_id ? { last_run_id: candidate.last_run_id } : {}) }
    },
    recordMilestone: (event: string, extra?: TelemetryProperties, icon = '✅', eventAppId?: string | null) => emit(event, extra, false, icon, eventAppId),
    recordResumeDecision: async (nextChoice: 'continue' | 'restart') => {
      if (!candidate || choice)
        return
      choice = nextChoice
      const initial = journeyId
      if (nextChoice === 'continue')
        journeyId = candidate.journey_id
      await emit('onboarding-resume-decision', {
        ...resumeProperties(),
        ...(nextChoice === 'continue' ? { initial_journey_id: initial } : {}),
        choice: nextChoice,
      }, true)
    },
    recordResumePromptViewed: () => candidate ? emit('onboarding-resume-prompt-viewed', { ...resumeProperties(), ...(candidate.totalSteps === undefined ? {} : { total_steps: candidate.totalSteps }) }, true) : Promise.resolve(),
    recordRunEnded: (outcome: 'completed' | 'cancelled' | 'failed', exitCode: number) => emit('onboarding-run-ended', { outcome, exit_code: exitCode }, true, outcome === 'completed' ? '✅' : outcome === 'cancelled' ? '🤷' : '❌'),
    recordRunStarted: () => emit('onboarding-run-started', {
      resume_available: Boolean(candidate),
      ...resumeProperties(),
      ...(candidate?.totalSteps === undefined ? {} : { total_steps: candidate.totalSteps }),
    }, true),
    setAuth: (orgId: string, apikey: string) => { auth = { apikey, orgId } },
    setScope: (nextAppId?: string) => { if (nextAppId !== undefined) appId = nextAppId },
  }
}
