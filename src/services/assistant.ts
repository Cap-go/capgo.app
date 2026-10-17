import type { CliLoginOrganization } from '~/services/cliLogin'
import type { ConsoleClient } from '~/services/consoleClient'
import type { Database } from '~/types/supabase.types'
import { createCliLoginKeyDependencies, createMcpOAuthKey, resolveCliKeyEligibility } from '~/services/cliLogin'

export type AssistantCard
  = | { type: 'link', title: string, description?: string, path: string }
    | { type: 'question', question: string, options: string[], allowFreeText: boolean }
    | { type: 'confirm', title: string, description: string, tool: string, arguments: Record<string, unknown> }

export interface AssistantAction {
  tool: string
  title: string
  ok: boolean
}

export interface AssistantResponse {
  reply: string
  cards: AssistantCard[]
  actions: AssistantAction[]
}

export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface AssistantContext {
  path?: string
  orgId?: string
  orgName?: string
  appId?: string
}

export const ASSISTANT_CLIENT_NAME = 'Capgo Assistant'

export class AssistantKeyError extends Error {}

const keyStorageKey = (userId: string) => `capgo-assistant-key:${userId}`

/** The assistant's Capgo API key lives on this device only, like the ChatGPT tokens. */
export function loadAssistantKey(userId: string): string {
  return localStorage.getItem(keyStorageKey(userId)) ?? ''
}

export function saveAssistantKey(userId: string, apikey: string) {
  if (apikey)
    localStorage.setItem(keyStorageKey(userId), apikey)
  else
    localStorage.removeItem(keyStorageKey(userId))
}

/**
 * The assistant calls the hosted MCP tools with a dedicated API key, bound to the organizations the
 * user administers, exactly like an MCP OAuth client. It shows up as "MCP · Capgo Assistant" in the
 * API key list, expires within 90 days and can be revoked there.
 */
export async function createAssistantKey(
  supabase: ConsoleClient<Database>,
  userId: string,
  organizations: CliLoginOrganization[],
): Promise<string> {
  const dependencies = createCliLoginKeyDependencies(supabase, userId)
  const { eligible } = await resolveCliKeyEligibility(organizations, dependencies)
  if (!eligible.length)
    throw new AssistantKeyError('no_eligible_organization')
  return createMcpOAuthKey(eligible, dependencies, ASSISTANT_CLIENT_NAME)
}
