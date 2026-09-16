export const DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS = ['answered', 'skipped', 'no_answer'] as const
export type DevelopmentEnvironmentFlowAnswer = typeof DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS[number]

export interface DevelopmentEnvironmentFlowGroup {
  answer: DevelopmentEnvironmentFlowAnswer
  people: number
  continued: number
  did_not_continue: number
}

export interface DevelopmentEnvironmentFlowAttempt {
  personId: string
  attemptId: string
  events: { event: string, step: string, timestampMs: number, answer: string }[]
}

const ANSWERS = ['hosted_builder', 'ai_assistant', 'hand_coded', 'other']
const QUESTION = 'publish_app_question'
const NEXT_STEPS = ['details', 'app_name', 'app_id', 'app_icon', 'organization', 'setup']

export function buildDevelopmentEnvironmentFlow(attempts: DevelopmentEnvironmentFlowAttempt[]) {
  const people = new Map<string, { reachedMs: number, continuedMs: number | null, answer: DevelopmentEnvironmentFlowAnswer }>()
  for (const attempt of attempts) {
    if (!attempt.personId.trim() || !attempt.attemptId.trim())
      continue
    const events = [...attempt.events].sort((a, b) => a.timestampMs - b.timestampMs
      || Number(b.event === 'onboarding_step_completed') - Number(a.event === 'onboarding_step_completed'))
    const reached = events.find(event => event.event === 'onboarding_step_viewed' && event.step === QUESTION)
    if (!reached)
      continue
    const afterReach = events.filter(event => event.timestampMs >= reached.timestampMs)
    const continuation = afterReach.find(event =>
      (event.event === 'onboarding_step_completed' && event.step === QUESTION)
      // The query only includes later views with previous_step = this question.
      || (event.event === 'onboarding_step_viewed' && NEXT_STEPS.includes(event.step)),
    )
    const beforeContinuation = afterReach.filter(event => event.timestampMs <= (continuation?.timestampMs ?? Number.POSITIVE_INFINITY))
    const selection = beforeContinuation.filter(event =>
      event.step === QUESTION && ANSWERS.includes(event.answer)
      && ['onboarding_development_environment_selected', 'onboarding_step_completed'].includes(event.event),
    ).at(-1)
    const answer: DevelopmentEnvironmentFlowAnswer = continuation?.event === 'onboarding_step_completed' && continuation.answer === 'skipped'
      ? 'skipped'
      : selection ? 'answered' : 'no_answer'
    const candidate = { reachedMs: reached.timestampMs, continuedMs: continuation?.timestampMs ?? null, answer }
    const current = people.get(attempt.personId)
    // Count each person once: their first recorded continuation, or latest
    // exposed attempt when none continued. Restarts cannot inflate drop-off.
    if (!current
      || (candidate.continuedMs !== null && (current.continuedMs === null || candidate.continuedMs < current.continuedMs))
      || (candidate.continuedMs === null && current.continuedMs === null && candidate.reachedMs > current.reachedMs)) {
      people.set(attempt.personId, candidate)
    }
  }
  const groups: DevelopmentEnvironmentFlowGroup[] = DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS.map(answer => ({ answer, people: 0, continued: 0, did_not_continue: 0 }))
  for (const person of people.values()) {
    const group = groups.find(group => group.answer === person.answer)!
    group.people++
    if (person.continuedMs !== null)
      group.continued++
    else
      group.did_not_continue++
  }
  return { reached: people.size, groups }
}
