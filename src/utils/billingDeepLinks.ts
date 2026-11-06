import type { LocationQuery } from 'vue-router'

// Console links that open a billing step directly (the CLI gives them to AI agents).
// Each param is read once and then removed from the URL.
export const TRIAL_CARD_PARAM = 'trial_card'
export const PLAN_CHECKOUT_PARAM = 'plan'

const CHECKOUT_PLAN_NAMES = new Map([['solo', 'Solo'], ['maker', 'Maker'], ['team', 'Team']])

/** `?trial_card=1&oid=<org>`: open the trial "add a card" prompt for that org (current org without `oid`). */
export function readTrialCardDeepLink(query: LocationQuery): { orgId: string | null } | null {
  const oid = query.oid
  // A malformed `oid` must not fall back to whichever org happens to be current.
  if (query[TRIAL_CARD_PARAM] !== '1' || (oid !== undefined && (typeof oid !== 'string' || !oid)))
    return null
  return { orgId: oid ?? null }
}

/** `?plan=<solo|maker|team>`: name of the plan whose checkout starts right away. */
export function readPlanCheckoutParam(query: LocationQuery): string | null {
  const plan = query[PLAN_CHECKOUT_PARAM]
  return typeof plan === 'string' ? CHECKOUT_PLAN_NAMES.get(plan.toLowerCase()) ?? null : null
}
