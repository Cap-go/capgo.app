import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { createCustomer } from './stripe.ts'
import { getDefaultPlan, getStripeCustomer, supabaseAdmin } from './supabase.ts'

type OrgRow = Database['public']['Tables']['orgs']['Row']

/**
 * Org Stripe customer provisioning lives outside supabase.ts on purpose.
 * The plugin worker reaches supabase helpers via stats fallbacks; keeping
 * Stripe customer creation here prevents any Stripe SDK edge from entering
 * the plugin isolate graph.
 */
export function isPendingStripeCustomerId(customerId: string | null | undefined) {
  return Boolean(customerId?.startsWith('pending_'))
}

export function isProvisionedStripeCustomerId(customerId: string | null | undefined) {
  return Boolean(customerId) && !isPendingStripeCustomerId(customerId)
}

function isUniqueViolation(error: { code?: string, message?: string } | null | undefined) {
  if (!error)
    return false
  return error.code === '23505' || Boolean(error.message?.toLowerCase().includes('duplicate'))
}

async function loadOrg(c: Context, orgId: string, fallback: OrgRow) {
  const { data, error } = await supabaseAdmin(c)
    .from('orgs')
    .select('*')
    .eq('id', orgId)
    .single()
  if (error || !data) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer org reload failed',
      orgId,
      error: error?.message,
    })
    return fallback
  }
  return data
}

async function resolveTrialPlan(c: Context, org: OrgRow) {
  const pendingPlan = isPendingStripeCustomerId(org.customer_id)
    ? await getStripeCustomer(c, org.customer_id!).then(async (pendingStripeInfo) => {
        if (!pendingStripeInfo?.product_id)
          return null
        const { data } = await supabaseAdmin(c)
          .from('plans')
          .select()
          .eq('stripe_id', pendingStripeInfo.product_id)
          .single()
        return data
      })
    : null
  return pendingPlan ?? await getDefaultPlan(c)
}

async function trialPlanNameForCustomer(c: Context, customerId: string, fallbackPlanName?: string | null) {
  const stripeInfo = await getStripeCustomer(c, customerId)
  if (stripeInfo?.product_id) {
    const { data } = await supabaseAdmin(c)
      .from('plans')
      .select('name')
      .eq('stripe_id', stripeInfo.product_id)
      .maybeSingle()
    if (data?.name)
      return data.name
  }
  if (fallbackPlanName)
    return fallbackPlanName
  const plan = await getDefaultPlan(c)
  return plan?.name ?? null
}

export async function createStripeCustomer(c: Context, org: OrgRow) {
  const current = await loadOrg(c, org.id, org)

  if (isProvisionedStripeCustomerId(current.customer_id)) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer already provisioned',
      orgId: current.id,
      customer_id: current.customer_id,
    })
    return await trialPlanNameForCustomer(c, current.customer_id!)
  }

  const selectedPlan = await resolveTrialPlan(c, current)
  if (!selectedPlan) {
    cloudlog({ requestId: c.get('requestId'), message: 'no default plan' })
    throw new Error('no default plan')
  }

  const customer = await createCustomer(c, current.management_email, current.created_by, current.id, current.name)
  const trial_at = new Date()
  trial_at.setDate(trial_at.getDate() + 15)
  cloudlog({ requestId: c.get('requestId'), message: 'createInfo', plan: selectedPlan, customer })

  const { error: createInfoError } = await supabaseAdmin(c)
    .from('stripe_info')
    .insert({
      product_id: selectedPlan.stripe_id,
      customer_id: customer.id,
      trial_at: trial_at.toISOString(),
    })
  if (createInfoError && !isUniqueViolation(createInfoError)) {
    cloudlog({ requestId: c.get('requestId'), message: 'createInfoError', createInfoError })
    return null
  }

  const latest = await loadOrg(c, current.id, current)
  if (isProvisionedStripeCustomerId(latest.customer_id) && latest.customer_id !== customer.id) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer keeping existing customer_id',
      orgId: latest.id,
      customer_id: latest.customer_id,
      created_customer_id: customer.id,
    })
    return await trialPlanNameForCustomer(c, latest.customer_id!, selectedPlan.name)
  }

  const { error: updateUserError } = await supabaseAdmin(c)
    .from('orgs')
    .update({
      customer_id: customer.id,
    })
    .eq('id', current.id)
  if (updateUserError) {
    cloudlog({ requestId: c.get('requestId'), message: 'updateUserError', updateUserError })
    return null
  }
  cloudlog({ requestId: c.get('requestId'), message: 'stripe_info done' })
  return selectedPlan.name
}

export async function finalizePendingStripeCustomer(c: Context, org: OrgRow) {
  const pendingCustomerId = org.customer_id
  if (!pendingCustomerId || !isPendingStripeCustomerId(pendingCustomerId)) {
    cloudlog({ requestId: c.get('requestId'), message: 'finalizePendingStripeCustomer: not a pending customer_id', pendingCustomerId })
    return
  }

  const trialPlanName = await createStripeCustomer(c, org)

  const { data: updatedOrg } = await supabaseAdmin(c)
    .from('orgs')
    .select('customer_id')
    .eq('id', org.id)
    .single()

  if (!isProvisionedStripeCustomerId(updatedOrg?.customer_id)) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'finalizePendingStripeCustomer: org still has pending customer_id, skipping delete' })
    return
  }

  const { error: deleteError } = await supabaseAdmin(c)
    .from('stripe_info')
    .delete()
    .eq('customer_id', pendingCustomerId)
  if (deleteError)
    cloudlogErr({ requestId: c.get('requestId'), message: 'finalizePendingStripeCustomer: orphan pending stripe_info', deleteError })

  return trialPlanName
}
