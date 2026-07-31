import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { createCustomer } from './stripe.ts'
import { getDefaultPlan, getStripeCustomer, supabaseAdmin } from './supabase.ts'

/**
 * Org Stripe customer provisioning lives outside supabase.ts on purpose.
 * The plugin worker reaches supabase helpers via stats fallbacks; keeping
 * Stripe customer creation here prevents any Stripe SDK edge from entering
 * the plugin isolate graph.
 */
export async function createStripeCustomer(c: Context, org: Database['public']['Tables']['orgs']['Row']) {
  const customer = await createCustomer(c, org.management_email, org.created_by, org.id, org.name)
  const trial_at = new Date()
  trial_at.setDate(trial_at.getDate() + 15)
  const plan = org.customer_id?.startsWith('pending_')
    ? await getStripeCustomer(c, org.customer_id).then(async (pendingStripeInfo) => {
        if (!pendingStripeInfo?.product_id)
          return null
        const { data } = await supabaseAdmin(c)
          .from('plans')
          .select()
          .eq('stripe_id', pendingStripeInfo.product_id)
          .single()
        return data
      })
    : await getDefaultPlan(c)
  const selectedPlan = plan ?? await getDefaultPlan(c)
  if (!selectedPlan) {
    cloudlog({ requestId: c.get('requestId'), message: 'no default plan' })
    throw new Error('no default plan')
  }
  cloudlog({ requestId: c.get('requestId'), message: 'createInfo', plan: selectedPlan, customer })
  const { error: createInfoError } = await supabaseAdmin(c)
    .from('stripe_info')
    .insert({
      product_id: selectedPlan.stripe_id,
      customer_id: customer.id,
      trial_at: trial_at.toISOString(),
    })
  if (createInfoError) {
    cloudlog({ requestId: c.get('requestId'), message: 'createInfoError', createInfoError })
    return null
  }

  const { error: updateUserError } = await supabaseAdmin(c)
    .from('orgs')
    .update({
      customer_id: customer.id,
    })
    .eq('id', org.id)
  if (updateUserError) {
    cloudlog({ requestId: c.get('requestId'), message: 'updateUserError', updateUserError })
    return null
  }
  cloudlog({ requestId: c.get('requestId'), message: 'stripe_info done' })
  return selectedPlan.name
}

export async function finalizePendingStripeCustomer(c: Context, org: Database['public']['Tables']['orgs']['Row']) {
  const pendingCustomerId = org.customer_id
  if (!pendingCustomerId?.startsWith('pending_')) {
    cloudlog({ requestId: c.get('requestId'), message: 'finalizePendingStripeCustomer: not a pending customer_id', pendingCustomerId })
    return
  }

  const trialPlanName = await createStripeCustomer(c, org)

  const { data: updatedOrg } = await supabaseAdmin(c)
    .from('orgs')
    .select('customer_id')
    .eq('id', org.id)
    .single()

  if (!updatedOrg?.customer_id || updatedOrg.customer_id.startsWith('pending_')) {
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
