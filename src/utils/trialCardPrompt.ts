import { parseAppOnboardingLedger } from '~/utils/appOnboardingProgress'

// Activation milestones that trigger the "add a card" prompt during the trial:
// ota = first device installed an update, builder = first successful native build.
export const TRIAL_CARD_MILESTONES = ['ota', 'builder'] as const
export type TrialCardMilestone = typeof TRIAL_CARD_MILESTONES[number]

export interface ReachedTrialCardMilestone {
  milestone: TrialCardMilestone
  reachedAt: string
}

const STORAGE_PREFIX = 'capgo-trial-card-prompt:'

// Earliest success per milestone across the org's apps.
export function getReachedTrialCardMilestones(apps: ReadonlyArray<{ onboarding?: unknown }>): ReachedTrialCardMilestone[] {
  const reached = new Map<TrialCardMilestone, string>()
  for (const app of apps) {
    const features = parseAppOnboardingLedger(app.onboarding).features ?? {}
    for (const milestone of TRIAL_CARD_MILESTONES) {
      const succeededAt = features[milestone]?.succeeded_at
      if (!succeededAt || !Number.isFinite(Date.parse(succeededAt)))
        continue
      const current = reached.get(milestone)
      if (!current || Date.parse(succeededAt) < Date.parse(current))
        reached.set(milestone, succeededAt)
    }
  }
  return [...reached].map(([milestone, reachedAt]) => ({ milestone, reachedAt }))
}

// The most recent milestone the user was not asked about yet. Milestones reached
// together (e.g. before this prompt shipped) produce a single prompt.
export function pickTrialCardMilestone(
  reached: ReadonlyArray<ReachedTrialCardMilestone>,
  handled: ReadonlyArray<TrialCardMilestone>,
): TrialCardMilestone | null {
  const pending = reached
    .filter(entry => !handled.includes(entry.milestone))
    .sort((a, b) => Date.parse(b.reachedAt) - Date.parse(a.reachedAt))
  return pending[0]?.milestone ?? null
}

export function readHandledTrialCardMilestones(orgId: string): TrialCardMilestone[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_PREFIX + orgId) ?? '[]')
    if (!Array.isArray(parsed))
      return []
    return parsed.filter((value): value is TrialCardMilestone => (TRIAL_CARD_MILESTONES as readonly unknown[]).includes(value))
  }
  catch {
    return []
  }
}

export function markTrialCardMilestonesHandled(orgId: string, milestones: ReadonlyArray<TrialCardMilestone>) {
  const handled = new Set([...readHandledTrialCardMilestones(orgId), ...milestones])
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + orgId, JSON.stringify([...handled]))
  }
  catch {
    // Storage can be unavailable (private mode); the prompt then shows again next session.
  }
}
