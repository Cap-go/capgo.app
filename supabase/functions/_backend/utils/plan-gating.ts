import type { Context } from 'hono'
import { quickError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { servicePrincipal, withRlsContext } from './pg_rls.ts'
import { getSubscriptionData, planProductIdOrFilter } from './stripe.ts'
import { getCurrentPlanNameOrg } from './supabase.ts'

function isActivePlanStatus(status: string | null | undefined): boolean {
  return status === 'succeeded'
}

// supabase-js `.single()`: `{ data, error }`, with an error unless exactly one row matched.
async function selectSingle<T>(c: Context, text: string, values: unknown[]): Promise<{ data: T | null, error: unknown }> {
  try {
    const rows = await withRlsContext(c, servicePrincipal, async client => (await client.query(text, values)).rows as T[])
    if (rows.length !== 1)
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    return { data: rows[0], error: null }
  }
  catch (error) {
    return { data: null, error }
  }
}

async function getActivePlanNameOrg(c: Context, orgId: string, requirePaid = false): Promise<string | null> {
  const { data: org, error: orgError } = await selectSingle<{ customer_id: string | null }>(c, 'SELECT customer_id FROM public.orgs WHERE id = $1 LIMIT 2', [orgId])
  if (orgError || !org?.customer_id) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unable to load org customer for active plan check',
      orgId,
      error: orgError,
    })
    return null
  }

  const { data: stripeInfo, error: stripeError } = await selectSingle<{ status: string | null, is_good_plan: boolean | null, product_id: string | null, subscription_id: string | null, past_due_at: unknown }>(
    c,
    'SELECT status, is_good_plan, product_id, subscription_id, past_due_at FROM public.stripe_info WHERE customer_id = $1 LIMIT 2',
    [org.customer_id],
  )
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

  if (requirePaid) {
    const subscription = await getSubscriptionData(c, org.customer_id, stripeInfo.subscription_id)
    if (stripeInfo.past_due_at || subscription?.status !== 'active' || subscription.productId !== stripeInfo.product_id)
      return null
  }

  planProductIdOrFilter(stripeInfo.product_id)
  const { data: plan, error: planError } = await selectSingle<{ name: string }>(
    c,
    'SELECT name FROM public.plans WHERE stripe_id = $1 OR stripe_id_us = $1 LIMIT 2',
    [stripeInfo.product_id],
  )
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
 * @param feature Feature name for the permission error
 * @param requirePaid Also verify the live Stripe subscription is active, with the same product and no past-due balance
 * @throws {HTTPException} 403 if org is not on Enterprise plan
 */
export async function requireEnterprisePlan(c: Context, orgId: string, feature = 'SSO', requirePaid = false): Promise<void> {
  try {
    const planName = await getActivePlanNameOrg(c, orgId, requirePaid)

    if (planName !== 'Enterprise') {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Active Enterprise plan required',
        orgId,
        activePlan: planName,
      })
      return quickError(403, 'enterprise_plan_required', `${feature} requires an active Enterprise plan`, {
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
