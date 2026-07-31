// src/init/mcp/session-state.ts
import type { Platform } from './contract.js'
import { getConfigWriteTarget } from '../../config'

export interface LiveUpdateSessionState {
  platform?: Platform
  encryptionChoice?: 'enable' | 'skip'
  channelName?: string
  currentVersion?: string
  delta?: boolean
  resumeResolved?: boolean
  dirtyGitResolved?: boolean
  deviceRunConfirmed?: boolean
  otaReceivedConfirmed?: boolean
}

const registry = new Map<string, LiveUpdateSessionState>()

function sessionKey(appId: string): string {
  return JSON.stringify([getConfigWriteTarget() ?? null, appId])
}

function mergeDefined<T extends object>(base: T, partial: Partial<T>): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined)
      next[key] = value
  }
  return next as T
}

export function getSession(appId: string): LiveUpdateSessionState {
  const key = sessionKey(appId)
  const existing = registry.get(key)
  if (existing)
    return existing
  const created: LiveUpdateSessionState = {}
  registry.set(key, created)
  return created
}

export function mergeSession(appId: string, partial: Partial<LiveUpdateSessionState>): LiveUpdateSessionState {
  const session = getSession(appId)
  const next = mergeDefined(session, partial)
  registry.set(sessionKey(appId), next)
  return next
}

export function clearSession(appId: string): void {
  registry.delete(sessionKey(appId))
}

export function clearAllSessions(): void {
  registry.clear()
}
