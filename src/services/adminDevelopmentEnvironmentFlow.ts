export const DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS = ['answered', 'skipped', 'no_answer'] as const
export type DevelopmentEnvironmentFlowAnswer = typeof DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS[number]

export interface DevelopmentEnvironmentFlowGroup {
  answer: DevelopmentEnvironmentFlowAnswer
  people: number
  continued: number
  did_not_continue: number
}

export interface AdminDevelopmentEnvironmentFlow {
  generated_at: string
  period: { start: string, end: string }
  data_quality: { configured: boolean, connected: boolean, failure_reason: string | null }
  reached: number | null
  groups: DevelopmentEnvironmentFlowGroup[] | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseAdminDevelopmentEnvironmentFlow(value: unknown): AdminDevelopmentEnvironmentFlow | null {
  if (!record(value) || typeof value.generated_at !== 'string' || !Number.isFinite(Date.parse(value.generated_at))
    || !record(value.period) || typeof value.period.start !== 'string' || typeof value.period.end !== 'string'
    || !Number.isFinite(Date.parse(value.period.start)) || !Number.isFinite(Date.parse(value.period.end))
    || Date.parse(value.period.end) <= Date.parse(value.period.start)
    || !record(value.data_quality) || typeof value.data_quality.configured !== 'boolean' || typeof value.data_quality.connected !== 'boolean'
    || (value.data_quality.failure_reason !== null && !['too_large', 'unconfigured', 'timeout', 'unavailable', 'invalid_data'].includes(value.data_quality.failure_reason as string))) {
    return null
  }
  if (value.data_quality.failure_reason !== null) {
    if (value.reached !== null || value.groups !== null)
      return null
    return value as unknown as AdminDevelopmentEnvironmentFlow
  }
  if (!value.data_quality.configured || !value.data_quality.connected || !count(value.reached)
    || !Array.isArray(value.groups) || value.groups.length !== DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS.length) {
    return null
  }
  const groups = new Map<DevelopmentEnvironmentFlowAnswer, DevelopmentEnvironmentFlowGroup>()
  for (const group of value.groups) {
    if (!record(group) || !(DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS as readonly unknown[]).includes(group.answer)
      || groups.has(group.answer as DevelopmentEnvironmentFlowAnswer)
      || !count(group.people) || !count(group.continued) || !count(group.did_not_continue)
      || group.continued + group.did_not_continue !== group.people
      || (group.answer === 'skipped' && group.did_not_continue !== 0)) {
      return null
    }
    groups.set(group.answer as DevelopmentEnvironmentFlowAnswer, group as unknown as DevelopmentEnvironmentFlowGroup)
  }
  if ([...groups.values()].reduce((sum, group) => sum + group.people, 0) !== value.reached)
    return null
  return { ...value, groups: DEVELOPMENT_ENVIRONMENT_FLOW_ANSWERS.map(answer => groups.get(answer)!) } as AdminDevelopmentEnvironmentFlow
}
