export const FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS = [
  'cli_copy_init',
  'ai_copy_init',
  'both_copy_init',
  'no_copy_init',
  'cli_copy_other_cli',
  'ai_copy_other_cli',
  'both_copy_other_cli',
  'no_copy_other_cli',
  'cli_copy_no_cli',
  'ai_copy_no_cli',
  'both_copy_no_cli',
  'no_action',
] as const

export type FrontendOnboardingDailySetupCliOutcomeKey = typeof FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS[number]
export type FrontendOnboardingDailySetupCliLifecycle = 'first_time' | 'returning'
export type FrontendOnboardingDailySetupCliEventKind = 'setup' | 'cli_copy' | 'ai_copy' | 'cli_command'

export interface FrontendOnboardingDailySetupCliEvent {
  personId: string
  timestampMs: number
  kind: FrontendOnboardingDailySetupCliEventKind
  commandPath?: string
  agentInvoker?: boolean
  agentId?: string
  agentName?: string
}

export interface FrontendOnboardingDailySetupCliSignals {
  cliCopied: boolean
  aiCopied: boolean
  initRun: boolean
  otherCliRun: boolean
}

export type FrontendOnboardingDailySetupCliOutcomeCounts = Record<FrontendOnboardingDailySetupCliOutcomeKey, number>

export interface FrontendOnboardingDailySetupCliOutcomePoint {
  date: string
  first_time: FrontendOnboardingDailySetupCliOutcomeCounts
  returning: FrontendOnboardingDailySetupCliOutcomeCounts
}

export interface FrontendOnboardingDailySetupCliAgentGroup {
  key: string
  agent_id?: string
  agent_name?: string
}

export interface FrontendOnboardingDailySetupCliAgentPoint {
  date: string
  counts: Record<string, number>
}

export interface FrontendOnboardingDailySetupCliAgentUsage {
  groups: FrontendOnboardingDailySetupCliAgentGroup[]
  points: FrontendOnboardingDailySetupCliAgentPoint[]
}

interface FrontendOnboardingDailySetupCliAgentSignals {
  cliInvoked: boolean
  unknownAgentInvoked: boolean
  agents: Map<string, string>
}

interface FrontendOnboardingDailySetupCliAnchor {
  personId: string
  timestampMs: number
  date: string
  lifecycle: FrontendOnboardingDailySetupCliLifecycle | undefined
  signals: FrontendOnboardingDailySetupCliSignals
  agentSignals: FrontendOnboardingDailySetupCliAgentSignals
}

const UTC_DAY_MS = 24 * 60 * 60 * 1000
const RESERVED_AGENT_GROUP_KEYS = ['multiple_agents', 'unknown_agent', 'no_agent', 'no_cli_invoked'] as const

export function createFrontendOnboardingDailySetupCliOutcomeCounts(): FrontendOnboardingDailySetupCliOutcomeCounts {
  return Object.fromEntries(
    FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS.map(key => [key, 0]),
  ) as FrontendOnboardingDailySetupCliOutcomeCounts
}

export function classifyFrontendOnboardingDailySetupCliOutcome(
  signals: FrontendOnboardingDailySetupCliSignals,
): FrontendOnboardingDailySetupCliOutcomeKey {
  const copyPrefix = signals.cliCopied && signals.aiCopied
    ? 'both_copy'
    : signals.cliCopied
      ? 'cli_copy'
      : signals.aiCopied
        ? 'ai_copy'
        : 'no_copy'

  if (signals.initRun)
    return `${copyPrefix}_init` as FrontendOnboardingDailySetupCliOutcomeKey

  if (signals.otherCliRun)
    return `${copyPrefix}_other_cli` as FrontendOnboardingDailySetupCliOutcomeKey

  if (copyPrefix !== 'no_copy')
    return `${copyPrefix}_no_cli` as FrontendOnboardingDailySetupCliOutcomeKey

  return 'no_action'
}

export function buildFrontendOnboardingDailySetupCliOutcomes(
  events: readonly FrontendOnboardingDailySetupCliEvent[],
  startMs: number,
  endMs: number,
): FrontendOnboardingDailySetupCliOutcomePoint[] {
  const anchorsByPerson = buildFrontendOnboardingDailySetupCliAnchors(events, startMs, endMs)

  const pointsByDate = new Map<string, FrontendOnboardingDailySetupCliOutcomePoint>()
  for (let timestampMs = getUtcDayStart(startMs); timestampMs < endMs; timestampMs += UTC_DAY_MS) {
    const date = getUtcDate(timestampMs)
    pointsByDate.set(date, {
      date,
      first_time: createFrontendOnboardingDailySetupCliOutcomeCounts(),
      returning: createFrontendOnboardingDailySetupCliOutcomeCounts(),
    })
  }

  for (const anchors of anchorsByPerson.values()) {
    for (const anchor of anchors) {
      if (!anchor.lifecycle)
        continue

      const point = pointsByDate.get(anchor.date)
      if (!point)
        continue

      const outcome = classifyFrontendOnboardingDailySetupCliOutcome(anchor.signals)
      point[anchor.lifecycle][outcome]++
    }
  }

  return [...pointsByDate.values()]
}

export function buildFrontendOnboardingDailySetupCliAgentUsage(
  events: readonly FrontendOnboardingDailySetupCliEvent[],
  startMs: number,
  endMs: number,
): FrontendOnboardingDailySetupCliAgentUsage {
  const anchorsByPerson = buildFrontendOnboardingDailySetupCliAnchors(events, startMs, endMs)
  const countsByDate = new Map<string, Record<string, number>>()
  const totalsByGroup = new Map<string, number>()
  const agentNames = new Map<string, string>()

  for (let timestampMs = getUtcDayStart(startMs); timestampMs < endMs; timestampMs += UTC_DAY_MS)
    countsByDate.set(getUtcDate(timestampMs), {})

  for (const anchors of anchorsByPerson.values()) {
    for (const anchor of anchors) {
      if (!anchor.lifecycle)
        continue

      const counts = countsByDate.get(anchor.date)
      if (!counts)
        continue

      const groupKey = classifyFrontendOnboardingDailySetupCliAgentSignals(anchor.agentSignals)
      counts[groupKey] = (counts[groupKey] ?? 0) + 1
      totalsByGroup.set(groupKey, (totalsByGroup.get(groupKey) ?? 0) + 1)

      for (const [agentId, agentName] of anchor.agentSignals.agents) {
        if (agentName && !agentNames.has(agentId))
          agentNames.set(agentId, agentName)
      }
    }
  }

  const detectedGroups = [...totalsByGroup.keys()]
    .filter(key => key.startsWith('agent:'))
    .map((key): FrontendOnboardingDailySetupCliAgentGroup => {
      const agentId = key.slice('agent:'.length)
      return {
        key,
        agent_id: agentId,
        agent_name: agentNames.get(agentId) ?? agentId,
      }
    })
    .sort((left, right) => {
      const totalDifference = (totalsByGroup.get(right.key) ?? 0) - (totalsByGroup.get(left.key) ?? 0)
      if (totalDifference !== 0)
        return totalDifference

      const nameDifference = (left.agent_name ?? left.key).localeCompare(right.agent_name ?? right.key)
      return nameDifference || left.key.localeCompare(right.key)
    })

  const reservedGroups = RESERVED_AGENT_GROUP_KEYS
    .filter(key => totalsByGroup.has(key))
    .map(key => ({ key }))
  const groups = [...detectedGroups, ...reservedGroups]
  const points = [...countsByDate].map(([date, counts]) => ({
    date,
    counts: Object.fromEntries(groups.map(group => [group.key, counts[group.key] ?? 0])),
  }))

  return { groups, points }
}

function buildFrontendOnboardingDailySetupCliAnchors(
  events: readonly FrontendOnboardingDailySetupCliEvent[],
  startMs: number,
  endMs: number,
): Map<string, FrontendOnboardingDailySetupCliAnchor[]> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    throw new RangeError('startMs and endMs must be finite bounds with endMs greater than startMs')

  const tailEndMs = endMs + UTC_DAY_MS
  const normalizedEvents = events.map((event) => {
    const personId = event.personId?.trim()
    if (!personId)
      throw new Error('Frontend onboarding event personId must be a non-empty string')

    if (!Number.isFinite(event.timestampMs))
      throw new Error('Frontend onboarding event timestampMs must be finite')

    if (!['setup', 'cli_copy', 'ai_copy', 'cli_command'].includes(event.kind))
      throw new Error(`Unsupported frontend onboarding event kind: ${event.kind}`)

    const commandPath = event.commandPath
    if (event.kind === 'cli_command' && !commandPath?.trim())
      throw new Error('CLI command event commandPath must be a non-empty string')
    if (event.agentInvoker !== undefined && typeof event.agentInvoker !== 'boolean')
      throw new Error('CLI command event agentInvoker must be a Boolean')
    if (event.agentId !== undefined && typeof event.agentId !== 'string')
      throw new Error('CLI command event agentId must be a string')
    if (event.agentName !== undefined && typeof event.agentName !== 'string')
      throw new Error('CLI command event agentName must be a string')

    return {
      ...event,
      personId,
      commandPath,
      agentId: event.agentId?.trim() || undefined,
      agentName: event.agentName?.trim() || undefined,
    }
  })

  const anchorsByPersonDate = new Map<string, FrontendOnboardingDailySetupCliAnchor>()
  for (const event of normalizedEvents) {
    if (event.kind !== 'setup' || event.timestampMs < startMs || event.timestampMs >= tailEndMs)
      continue

    const date = getUtcDate(event.timestampMs)
    const key = `${event.personId}\u0000${date}`
    const existingAnchor = anchorsByPersonDate.get(key)
    if (existingAnchor && existingAnchor.timestampMs <= event.timestampMs)
      continue

    anchorsByPersonDate.set(key, {
      personId: event.personId,
      timestampMs: event.timestampMs,
      date,
      lifecycle: undefined,
      signals: createFrontendOnboardingDailySetupCliSignals(),
      agentSignals: createFrontendOnboardingDailySetupCliAgentSignals(),
    })
  }

  const anchorsByPerson = new Map<string, FrontendOnboardingDailySetupCliAnchor[]>()
  for (const anchor of anchorsByPersonDate.values()) {
    const anchors = anchorsByPerson.get(anchor.personId) ?? []
    anchors.push(anchor)
    anchorsByPerson.set(anchor.personId, anchors)
  }

  for (const anchors of anchorsByPerson.values()) {
    anchors.sort((left, right) => left.timestampMs - right.timestampMs)
    let hasDisplayedAnchor = false
    for (const anchor of anchors) {
      if (anchor.timestampMs >= endMs)
        continue

      anchor.lifecycle = hasDisplayedAnchor ? 'returning' : 'first_time'
      hasDisplayedAnchor = true
    }
  }

  for (const event of normalizedEvents) {
    if (event.kind === 'setup')
      continue

    const anchors = anchorsByPerson.get(event.personId)
    if (!anchors)
      continue

    const anchorIndex = findLatestAnchorIndex(anchors, event.timestampMs)
    if (anchorIndex === -1)
      continue

    const anchor = anchors[anchorIndex]
    const nextAnchor = anchors[anchorIndex + 1]
    const windowEndMs = Math.min(anchor.timestampMs + UTC_DAY_MS, nextAnchor?.timestampMs ?? Infinity)
    if (event.timestampMs >= windowEndMs || !anchor.lifecycle)
      continue

    if (event.kind === 'cli_copy')
      anchor.signals.cliCopied = true
    else if (event.kind === 'ai_copy')
      anchor.signals.aiCopied = true
    else {
      anchor.agentSignals.cliInvoked = true
      if (event.agentInvoker) {
        if (event.agentId) {
          const existingName = anchor.agentSignals.agents.get(event.agentId)
          if (!anchor.agentSignals.agents.has(event.agentId) || (!existingName && event.agentName))
            anchor.agentSignals.agents.set(event.agentId, event.agentName ?? '')
        }
        else {
          anchor.agentSignals.unknownAgentInvoked = true
        }
      }

      if (event.commandPath === 'init')
        anchor.signals.initRun = true
      else
        anchor.signals.otherCliRun = true
    }
  }

  return anchorsByPerson
}

function classifyFrontendOnboardingDailySetupCliAgentSignals(
  signals: FrontendOnboardingDailySetupCliAgentSignals,
): string {
  if (!signals.cliInvoked)
    return 'no_cli_invoked'
  if (signals.agents.size === 0)
    return signals.unknownAgentInvoked ? 'unknown_agent' : 'no_agent'
  if (signals.agents.size > 1 || signals.unknownAgentInvoked)
    return 'multiple_agents'

  return `agent:${signals.agents.keys().next().value}`
}

function createFrontendOnboardingDailySetupCliSignals(): FrontendOnboardingDailySetupCliSignals {
  return {
    cliCopied: false,
    aiCopied: false,
    initRun: false,
    otherCliRun: false,
  }
}

function createFrontendOnboardingDailySetupCliAgentSignals(): FrontendOnboardingDailySetupCliAgentSignals {
  return {
    cliInvoked: false,
    unknownAgentInvoked: false,
    agents: new Map(),
  }
}

function findLatestAnchorIndex(anchors: readonly FrontendOnboardingDailySetupCliAnchor[], timestampMs: number): number {
  for (let index = anchors.length - 1; index >= 0; index--) {
    if (anchors[index].timestampMs <= timestampMs)
      return index
  }

  return -1
}

function getUtcDate(timestampMs: number): string {
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime()))
    throw new RangeError('Frontend onboarding event timestampMs must be a valid UTC date')

  return date.toISOString().slice(0, 10)
}

function getUtcDayStart(timestampMs: number): number {
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime()))
    throw new RangeError('Bounds must be valid UTC dates')

  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}
