import type { Context } from 'hono'
import { quickError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { planProductIdOrFilter } from './stripe.ts'
import { getCurrentPlanNameOrg, supabaseAdmin } from './supabase.ts'

function isActivePlanStatus(status: string | null | undefined): boolean {
  return status === 'succeeded'
}

async function getActivePlanNameOrg(c: Context, orgId: string): Promise<string | null> {
  const { data: org, error: orgError } = await supabaseAdmin(c)
    .from('orgs')
    .select('customer_id')
    .eq('id', orgId)
    .single()
  if (orgError || !org?.customer_id) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unable to load org customer for active plan check',
      orgId,
      error: orgError,
    })
    return null
  }

  const { data: stripeInfo, error: stripeError } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('status, is_good_plan, product_id')
    .eq('customer_id', org.customer_id)
    .single()
  if (stripeError || !stripeInfo?.product_id) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unable to load stripe info for active plan check',
      orgId,
      customerId: org.customer_id,
      error: stripeError,
    })
    return null
  }

  if (!isActivePlanStatus(stripeInfo.status) || stripeInfo.is_good_plan !== true)
    return null

  const { data: plan, error: planError } = await supabaseAdmin(c)
    .from('plans')
    .select('name')
    .or(planProductIdOrFilter(stripeInfo.product_id))
    .single()
  if (planError || !plan?.name) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unable to load active plan name',
      orgId,
      productId: stripeInfo.product_id,
      error: planError,
    })
    return null
  }

  return plan.name
}

/**
 * Validates that an organization has an Enterprise plan.
 * Throws a 403 error if the org is not on Enterprise plan.
 *
 * @param c - Hono context
 * @param orgId - Organization ID to validate
 * @throws {HTTPException} 403 if org is not on Enterprise plan
 */
export async function requireEnterprisePlan(c: Context, orgId: string): Promise<void> {
  try {
    const planName = await getActivePlanNameOrg(c, orgId)

    if (planName !== 'Enterprise') {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Active Enterprise plan required',
        orgId,
        activePlan: planName,
      })
      return quickError(403, 'enterprise_plan_required', 'SSO requires an active Enterprise plan', {
        activePlan: planName,
      })
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Enterprise plan verified',
      orgId,
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Error checking Enterprise plan',
      orgId,
      error,
    })
    throw error
  }
}

/**
 * Checks if an organization has a specific feature enabled.
 * Currently only supports 'sso' feature for Enterprise plan.
 * Extensible for future feature flags.
 *
 * @param c - Hono context
 * @param orgId - Organization ID
 * @param feature - Feature name to check (e.g., 'sso')
 * @returns true if org has the feature, false otherwise
 */
export async function hasFeature(c: Context, orgId: string, feature: string): Promise<boolean> {
  try {
    const currentPlanName = await getCurrentPlanNameOrg(c, orgId)

    // Map features to required plans
    const featureRequirements: Record<string, string[]> = {
      sso: ['Enterprise'],
    }

    const requiredPlans = featureRequirements[feature]
    if (!requiredPlans) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Unknown feature',
        orgId,
        feature,
      })
      return false
    }

    const activePlanName = await getActivePlanNameOrg(c, orgId)
    const hasFeature = requiredPlans.includes(activePlanName ?? '')

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Feature check',
      orgId,
      feature,
      currentPlan: currentPlanName,
      activePlan: activePlanName,
      hasFeature,
    })

    return hasFeature
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Error checking feature',
      orgId,
      feature,
      error,
    })
    return false
  }
}
