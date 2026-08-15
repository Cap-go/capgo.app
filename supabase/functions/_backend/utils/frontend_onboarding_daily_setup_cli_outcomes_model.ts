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

interface FrontendOnboardingDailySetupCliAnchor {
  personId: string
  timestampMs: number
  date: string
  lifecycle: FrontendOnboardingDailySetupCliLifecycle | undefined
  signals: FrontendOnboardingDailySetupCliSignals
}

const UTC_DAY_MS = 24 * 60 * 60 * 1000

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
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    throw new RangeError('startMs and endMs must be finite bounds with endMs greater than startMs')

  const normalizedEvents = events.map((event) => {
    const personId = event.personId?.trim()
    if (!personId)
      throw new Error('Frontend onboarding event personId must be a non-empty string')

    if (!Number.isFinite(event.timestampMs))
      throw new Error('Frontend onboarding event timestampMs must be finite')

    if (!['setup', 'cli_copy', 'ai_copy', 'cli_command'].includes(event.kind))
      throw new Error(`Unsupported frontend onboarding event kind: ${event.kind}`)

    const commandPath = event.commandPath?.trim()
    if (event.kind === 'cli_command' && !commandPath)
      throw new Error('CLI command event commandPath must be a non-empty string')

    return {
      ...event,
      personId,
      commandPath,
    }
  })

  const anchorsByPersonDate = new Map<string, FrontendOnboardingDailySetupCliAnchor>()
  for (const event of normalizedEvents) {
    if (event.kind !== 'setup')
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
    })
  }

  const tailEndMs = endMs + UTC_DAY_MS
  const anchorsByPerson = new Map<string, FrontendOnboardingDailySetupCliAnchor[]>()
  for (const anchor of anchorsByPersonDate.values()) {
    if (anchor.timestampMs < startMs || anchor.timestampMs >= tailEndMs)
      continue

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
    else if (event.commandPath === 'init')
      anchor.signals.initRun = true
    else
      anchor.signals.otherCliRun = true
  }

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

function createFrontendOnboardingDailySetupCliSignals(): FrontendOnboardingDailySetupCliSignals {
  return {
    cliCopied: false,
    aiCopied: false,
    initRun: false,
    otherCliRun: false,
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
