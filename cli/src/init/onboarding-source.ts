import { env } from 'node:process'
import { getInvocationSource } from '../analytics/global-props'

export type ReportedOnboardingSource = 'cli' | 'mcp' | 'ai'

const AI_AGENT_ENV_KEYS = [
  'CURSOR_AGENT',
  'CURSOR_TRACE_ID',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'AIDER',
  'GEMINI_CLI',
  'CODEX_CLI',
  'CAPGO_ONBOARDING_SOURCE',
] as const

export function detectOnboardingSource(): ReportedOnboardingSource {
  if (getInvocationSource() === 'mcp')
    return 'mcp'
  if (isAiAgentEnvironment())
    return 'ai'
  return 'cli'
}

export function isAiAgentEnvironment(environment: NodeJS.ProcessEnv = env): boolean {
  if (environment.CAPGO_ONBOARDING_SOURCE === 'ai')
    return true
  return AI_AGENT_ENV_KEYS.some(key => key !== 'CAPGO_ONBOARDING_SOURCE' && Boolean(environment[key]))
}
