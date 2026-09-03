/** Org with credits but no active paid plan and no trial left. */
export function isCreditsOnlyOrg(org: {
  paying?: boolean | null
  trial_left?: number | null
  credit_available?: number | null
} | null | undefined): boolean {
  if (!org)
    return false
  return !org.paying && (org.trial_left ?? 0) <= 0 && Number(org.credit_available ?? 0) > 0
}

export type OrgBillingStatusKind
  = 'hidden'
    | 'trial'
    | 'trial_over'
    | 'plan_active'
    | 'using_credits'
    | 'limit_reached'
    | 'limit_reached_credits'

export type OrgBillingStatusTone = 'warning' | 'success' | 'neutral' | 'trial'
export type OrgBillingStatusCta = 'go_plans' | 'go_credits' | 'none'

export interface OrgBillingOrg {
  paying?: boolean | null
  trial_left?: number | null
  credit_available?: number | null
  can_use_more?: boolean | null
}

export interface OrgBillingStatus {
  kind: OrgBillingStatusKind
  trialDaysLeft: number
  tone: OrgBillingStatusTone
  cta: OrgBillingStatusCta
}

const HIDDEN_STATUS: OrgBillingStatus = {
  kind: 'hidden',
  trialDaysLeft: 0,
  tone: 'neutral',
  cta: 'none',
}

/**
 * Navbar billing state.
 *
 * Trial orgs are stored with stripe_info.status = canceled until they subscribe,
 * so is_canceled must not override an active trial.
 */
export function resolveOrgBillingStatus(
  org: OrgBillingOrg | null | undefined,
  options: {
    stripeEnabled: boolean
    lacksSecurityAccess: boolean
    organizationFailed: boolean
  },
): OrgBillingStatus {
  if (!options.stripeEnabled || options.lacksSecurityAccess || !org)
    return HIDDEN_STATUS

  const trialDaysLeft = Math.max(org.trial_left ?? 0, 0)
  const paying = !!org.paying

  if (isCreditsOnlyOrg(org)) {
    return {
      kind: 'using_credits',
      trialDaysLeft,
      tone: 'success',
      cta: 'go_credits',
    }
  }

  if (!paying && trialDaysLeft > 0) {
    return {
      kind: 'trial',
      trialDaysLeft,
      tone: 'trial',
      cta: 'go_plans',
    }
  }

  if (options.organizationFailed) {
    return {
      kind: 'trial_over',
      trialDaysLeft,
      tone: 'warning',
      cta: 'go_plans',
    }
  }

  if (paying && !org.can_use_more) {
    const hasCredits = Number(org.credit_available ?? 0) > 0
    return {
      kind: hasCredits ? 'limit_reached_credits' : 'limit_reached',
      trialDaysLeft,
      tone: 'warning',
      cta: hasCredits ? 'go_credits' : 'go_plans',
    }
  }

  if (paying) {
    return {
      kind: 'plan_active',
      trialDaysLeft,
      tone: 'success',
      cta: 'none',
    }
  }

  return {
    kind: 'trial_over',
    trialDaysLeft,
    tone: 'warning',
    cta: 'go_plans',
  }
}
