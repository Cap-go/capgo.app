export interface AppOnboardingMethodTrendPoint {
  date: string
  manual: number
  cli: number
  mcp: number
  ai: number
}

export interface AppOnboardingOutcomeTrendPoint {
  date: string
  completed: number
  skipped: number
  switched_to_manual: number
  in_progress: number
}

export interface AppOnboardingMethodTotals {
  manual: number
  cli: number
  mcp: number
  ai: number
}

export interface AppOnboardingOutcomeTotals {
  completed: number
  skipped: number
  switchedToManual: number
  inProgress: number
}

export function aggregateAppOnboardingMethodTotals(trend: readonly AppOnboardingMethodTrendPoint[]): AppOnboardingMethodTotals {
  return trend.reduce((totals, item) => ({
    manual: totals.manual + (Number(item.manual) || 0),
    cli: totals.cli + (Number(item.cli) || 0),
    mcp: totals.mcp + (Number(item.mcp) || 0),
    ai: totals.ai + (Number(item.ai) || 0),
  }), {
    manual: 0,
    cli: 0,
    mcp: 0,
    ai: 0,
  })
}

export function aggregateAppOnboardingOutcomeTotals(trend: readonly AppOnboardingOutcomeTrendPoint[]): AppOnboardingOutcomeTotals {
  return trend.reduce((totals, item) => ({
    completed: totals.completed + (Number(item.completed) || 0),
    skipped: totals.skipped + (Number(item.skipped) || 0),
    switchedToManual: totals.switchedToManual + (Number(item.switched_to_manual) || 0),
    inProgress: totals.inProgress + (Number(item.in_progress) || 0),
  }), {
    completed: 0,
    skipped: 0,
    switchedToManual: 0,
    inProgress: 0,
  })
}
