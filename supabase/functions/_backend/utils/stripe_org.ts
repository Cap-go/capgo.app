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

export function isLocalStripeCustomerId(customerId: string | null | undefined) {
  return Boolean(customerId?.startsWith('cus_local_') || (customerId && /^cus_[0-9a-f]{32}$/.test(customerId)))
}

export function isProvisionedStripeCustomerId(customerId: string | null | undefined) {
  return Boolean(customerId) && !isPendingStripeCustomerId(customerId) && !isLocalStripeCustomerId(customerId)
}

function isUniqueViolation(error: { code?: string, message?: string } | null | undefined) {
  if (!error)
    return false
  return error.code === '23505' || Boolean(error.message?.toLowerCase().includes('duplicate'))
}

async function requireOrg(c: Context, orgId: string) {
  const { data, error } = await supabaseAdmin(c)
    .from('orgs')
    .select('*')
    .eq('id', orgId)
    .single()
  if (error || !data) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer org reload failed',
      orgId,
      error: error?.message,
    })
    throw new Error('createStripeCustomer org reload failed')
  }
  return data
}

async function linkOrgCustomer(c: Context, orgId: string, observedCustomerId: string | null, customerId: string) {
  const query = supabaseAdmin(c)
    .from('orgs')
    .update({ customer_id: customerId })
    .eq('id', orgId)
  const filtered = observedCustomerId == null
    ? query.is('customer_id', null)
    : query.eq('customer_id', observedCustomerId)
  return await filtered.select('customer_id').maybeSingle()
}

async function deleteUnusedStripeInfo(c: Context, customerId: string) {
  const { error } = await supabaseAdmin(c)
    .from('stripe_info')
    .delete()
    .eq('customer_id', customerId)
  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer unused stripe_info delete failed',
      customerId,
      error,
    })
  }
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
  const current = await requireOrg(c, org.id)

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

  const { data: linked, error: updateUserError } = await linkOrgCustomer(
    c,
    current.id,
    current.customer_id,
    customer.id,
  )
  if (updateUserError) {
    cloudlog({ requestId: c.get('requestId'), message: 'updateUserError', updateUserError })
    return null
  }
  if (linked?.customer_id === customer.id) {
    if (current.customer_id && current.customer_id !== customer.id)
      await deleteUnusedStripeInfo(c, current.customer_id)
    cloudlog({ requestId: c.get('requestId'), message: 'stripe_info done' })
    return selectedPlan.name
  }

  const latest = await requireOrg(c, current.id)
  if (isProvisionedStripeCustomerId(latest.customer_id)) {
    if (latest.customer_id !== customer.id)
      await deleteUnusedStripeInfo(c, customer.id)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer keeping existing customer_id',
      orgId: latest.id,
      customer_id: latest.customer_id,
      created_customer_id: customer.id,
    })
    return await trialPlanNameForCustomer(c, latest.customer_id!, selectedPlan.name)
  }

  throw new Error('createStripeCustomer customer_id link raced')
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

  const linkedCustomerId = updatedOrg?.customer_id
  if (!isProvisionedStripeCustomerId(linkedCustomerId) && !isLocalStripeCustomerId(linkedCustomerId)) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'finalizePendingStripeCustomer: org customer_id not finalized, skipping delete',
      linkedCustomerId,
    })
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
