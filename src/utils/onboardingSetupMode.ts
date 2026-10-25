import type { Json } from '~/types/database.types'
import { parseUserOnboardingProgress } from '~/utils/userOnboardingProgress'

/**
 * How a self-signup user chose to finish onboarding.
 *
 * - `ai`: the console creates the organization (with the plan picked in the UI) and hands
 *   the rest (app, channel, updater plugin, first upload) to the user's coding agent
 *   through Capgo MCP.
 * - `manual`: the existing browser wizard (intent → app → organization → setup).
 *
 * Stored in `users.onboarding.setup_mode`. The key is not one of the wizard progress fields,
 * so `mergeUserOnboardingProgress` keeps it when the manual wizard saves its progress.
 */
export const ONBOARDING_SETUP_MODES = ['ai', 'manual'] as const
export type OnboardingSetupMode = typeof ONBOARDING_SETUP_MODES[number]

export const AI_ONBOARDING_PATH = '/onboarding/ai'

function asObject(value: Json | unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function readOnboardingSetupMode(onboarding: Json | unknown): OnboardingSetupMode | null {
  const mode = asObject(onboarding).setup_mode
  return mode === 'ai' || mode === 'manual' ? mode : null
}

export function withOnboardingSetupMode(onboarding: Json, mode: OnboardingSetupMode): Json {
  return { ...asObject(onboarding), setup_mode: mode } as Json
}

/**
 * Which first screen `/onboarding/app` shows.
 * "Create new organization" always offers the choice again: it is a fresh setup.
 * A first-time user already inside the manual wizard (saved progress or a resume link)
 * keeps the manual flow, so nobody loses typed answers.
 */
export function initialOnboardingSetupScreen(options: {
  onboarding: Json | unknown
  newOrganization: boolean
  resuming: boolean
}): 'choice' | 'ai' | 'manual' {
  if (options.resuming)
    return 'manual'
  if (options.newOrganization)
    return 'choice'
  const saved = readOnboardingSetupMode(options.onboarding)
  if (saved === 'ai')
    return 'ai'
  if (saved === 'manual')
    return 'manual'
  if (parseUserOnboardingProgress(options.onboarding))
    return 'manual'
  return 'choice'
}

/**
 * New users who picked AI setup and have an organization but no app yet go back to the
 * prompt page, unless they chose to look around the dashboard first.
 */
export function shouldRedirectToAiOnboarding(options: {
  onboarding: Json | unknown
  appCount: number
  organizationCount: number
  path: string
  canExploreDashboard: boolean
}) {
  if (readOnboardingSetupMode(options.onboarding) !== 'ai')
    return false
  if (options.organizationCount !== 1 || options.appCount !== 0 || options.canExploreDashboard)
    return false
  // Account, organization and billing settings stay reachable; so does the manual wizard.
  return options.path !== AI_ONBOARDING_PATH && options.path !== '/app/new' && !options.path.startsWith('/settings')
}

/** Default organization name, so AI setup needs no typing. Must be at least 3 characters. */
export function defaultAiOrganizationName(firstName: string | null | undefined, fallback: string, template: (name: string) => string) {
  const name = firstName?.replace(/\s+/g, ' ').trim()
  const candidate = name ? template(name) : fallback
  return candidate.length >= 3 ? candidate : fallback
}

/** Live AI agent progress written by `/private/events` when the agent's CLI or MCP reaches Capgo. */
export function readAiAgentProgress(onboarding: Json | unknown) {
  const value = asObject(onboarding)
  const mcpConnected = typeof value.ai_mcp_connected_at === 'string'
  return {
    agentConnected: mcpConnected || typeof value.ai_agent_connected_at === 'string',
    mcpConnected,
  }
}

/**
 * What the user wants first on the AI path. Saved as the usual onboarding intent before the
 * agent registers the app, so the app gets the matching Getting started checklist.
 * `unsure` lets the agent inspect the project and recommend one.
 */
export const AI_ONBOARDING_GOALS = ['ota', 'builder', 'both', 'unsure'] as const
export type AiOnboardingGoal = typeof AI_ONBOARDING_GOALS[number]

export function aiGoalToIntent(goal: AiOnboardingGoal): 'ota' | 'builder' | 'both' | 'exploring' {
  return goal === 'unsure' ? 'exploring' : goal
}

export function readAiOnboardingGoal(onboarding: Json | unknown): AiOnboardingGoal | null {
  const intent = asObject(onboarding).intent
  if (intent === 'ota' || intent === 'builder' || intent === 'both')
    return intent
  return intent === 'exploring' ? 'unsure' : null
}

export function withOnboardingFields(onboarding: Json, fields: Record<string, Json>): Json {
  return { ...asObject(onboarding), ...fields } as Json
}

/**
 * Drops the agent markers of an earlier AI setup, so a new organization's prompt page starts
 * from "waiting for your agent". Keys are removed, not nulled: the backend marker only writes
 * when the key is absent.
 */
export function withoutAiAgentProgress(onboarding: Json): Json {
  const { ai_agent_connected_at: _agent, ai_mcp_connected_at: _mcp, ...rest } = asObject(onboarding)
  return rest as Json
}

/**
 * Starts tracking the agent for one organization: clears earlier markers and records the
 * organization, so the backend only counts events sent with that organization's prompt key.
 */
export function withAiSetupOrganization(onboarding: Json, orgId: string): Json {
  return { ...asObject(withoutAiAgentProgress(onboarding)), ai_setup_org_id: orgId } as Json
}

/** Page the AI path opens after creating an organization; `org` pins the new one. */
export function aiOnboardingPathFor(orgId: string) {
  return `${AI_ONBOARDING_PATH}?org=${encodeURIComponent(orgId)}`
}

/**
 * How Getting started shows its task list:
 * - AI setup: open, so the user watches the agent tick tasks off.
 * - Manual setup (new signups): hidden, one next step at a time without counts.
 * - Accounts from before the setup choice: unchanged (every step shown, user can hide the list).
 */
export type ChecklistTaskListMode = 'default' | 'hidden' | 'open'

export function checklistTaskListMode(onboarding: Json | unknown): ChecklistTaskListMode {
  const mode = readOnboardingSetupMode(onboarding)
  if (mode === 'ai')
    return 'open'
  return mode === 'manual' ? 'hidden' : 'default'
}
