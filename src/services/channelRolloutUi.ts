export function shouldShowRolloutSettings(rolloutVersion: number | null | undefined) {
  return rolloutVersion != null
}

export function shouldShowRolloutEnableRow(
  rolloutVersion: number | null | undefined,
  rolloutEnabled: boolean,
) {
  return rolloutVersion == null && !rolloutEnabled
}

export function rolloutPercentageDraftFromBps(rolloutPercentageBps: number | null | undefined) {
  return String((rolloutPercentageBps ?? 0) / 100)
}
