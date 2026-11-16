// Fallback while a plans response predates the observe_events column.
// The database value wins as soon as the API returns it.
export const OBSERVE_EVENTS_BY_PLAN: Record<string, number> = {
  Solo: 500_000,
  Maker: 3_000_000,
  Team: 20_000_000,
  Enterprise: 600_000_000,
}

export function observeEventsForPlan(plan: { name?: string | null, observe_events?: number | null }): number {
  if (typeof plan.observe_events === 'number' && Number.isFinite(plan.observe_events) && plan.observe_events > 0)
    return plan.observe_events
  return OBSERVE_EVENTS_BY_PLAN[plan.name ?? ''] ?? 0
}
