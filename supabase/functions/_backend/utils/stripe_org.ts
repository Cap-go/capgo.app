import type { Context } from 'hono'
import type { BillingAccount } from './stripe.ts'
import type { Database } from './supabase.types.ts'
import { resolveNewOrgTrialEnd } from './direct_offer.ts'
import type { PgQueryClient } from './pg.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { queryJson, servicePrincipal, withRlsContext } from './pg_rls.ts'
import { createCustomer, getPlanProductId, normalizeBillingAccount, planProductIdOrFilter } from './stripe.ts'
import { queryPlanByProductId } from './stripe_billing.ts'
import { getDefaultPlan, getStripeCustomer, supabaseAdmin } from './supabase.ts'

type OrgRow = Database['public']['Tables']['orgs']['Row']

function adminQuery<T>(c: Context, run: (client: PgQueryClient) => Promise<T>) {
  return withRlsContext(c, servicePrincipal, run)
}

/**
 * Org Stripe customer provisioning lives outside supabase.ts on purpose.
 * The plugin worker reaches supabase helpers via stats fallbacks; keeping
 * Stripe customer creation here prevents any Stripe SDK edge from entering
 * the plugin isolate graph.
 */
export function isPendingStripeCustomerId(customerId: string | null | undefined) {
  return Boolean(customerId?.startsWith('pending_'))
}

// Production (pre-this-PR) generateFakeCustomerId used
// `cus_${randomUUID().replaceAll('-', '').slice(0, 24)}` — 24 lowercase hex.
// This PR briefly used the full 32-hex uuid without dashes.
// Real Stripe ids are mixed-case ~14 chars (e.g. cus_VAgMn1agG4iQSC), not 24/32 hex.
const LEGACY_FAKE_STRIPE_CUSTOMER_ID_RE = /^cus_[0-9a-f]{24}$/
const INTERMEDIATE_FAKE_STRIPE_CUSTOMER_ID_RE = /^cus_[0-9a-f]{32}$/

export function isLocalStripeCustomerId(customerId: string | null | undefined) {
  if (!customerId)
    return false
  return customerId.startsWith('cus_local_')
    || LEGACY_FAKE_STRIPE_CUSTOMER_ID_RE.test(customerId)
    || INTERMEDIATE_FAKE_STRIPE_CUSTOMER_ID_RE.test(customerId)
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
  let data: OrgRow | null = null
  let errorMessage: string | undefined
  try {
    data = (await adminQuery(c, client => queryJson<OrgRow>(client, 'SELECT * FROM public.orgs WHERE id = $1', [orgId])))[0] ?? null
  }
  catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
  }
  if (!data) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer org reload failed',
      orgId,
      error: errorMessage,
    })
    throw new Error('createStripeCustomer org reload failed')
  }
  return data
}

// Compare-and-set on the customer_id we read, so a concurrent link wins cleanly.
async function linkOrgCustomer(c: Context, orgId: string, observedCustomerId: string | null, customerId: string): Promise<{ data: { customer_id: string | null } | null, error: unknown }> {
  try {
    const result = await adminQuery(c, client => client.query<{ customer_id: string | null }>(
      'UPDATE public.orgs SET customer_id = $2 WHERE id = $1 AND customer_id IS NOT DISTINCT FROM $3 RETURNING customer_id',
      [orgId, customerId, observedCustomerId],
    ))
    return { data: result.rows[0] ?? null, error: null }
  }
  catch (error) {
    return { data: null, error }
  }
}

async function deleteStripeInfo(c: Context, customerId: string) {
  try {
    await adminQuery(c, client => client.query('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId]))
    return null
  }
  catch (error) {
    return error
  }
}

async function deleteUnusedStripeInfo(c: Context, customerId: string) {
  const error = await deleteStripeInfo(c, customerId)
  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'createStripeCustomer unused stripe_info delete failed',
      customerId,
      error,
    })
  }
}

async function resolveTrialPlan(c: Context, org: OrgRow, billingAccount: BillingAccount) {
  const existingStripeInfoPlan = org.customer_id && !isProvisionedStripeCustomerId(org.customer_id)
    ? await getStripeCustomer(c, org.customer_id).then(async (stripeInfo) => {
        if (!stripeInfo?.product_id)
          return null
        const productId = stripeInfo.product_id
        return await adminQuery(c, client => queryPlanByProductId(client, productId))
      })
    : null
  const plan = existingStripeInfoPlan ?? await getDefaultPlan(c)
  if (!plan)
    return null
  return {
    ...plan,
    stripe_id: getPlanProductId(plan, billingAccount),
  }
}

async function resolveBillingAccountForCreate(c: Context, org: OrgRow): Promise<BillingAccount> {
  if (org.customer_id && !isProvisionedStripeCustomerId(org.customer_id)) {
    const stripeInfo = await getStripeCustomer(c, org.customer_id)
    if (stripeInfo?.billing_account)
      return normalizeBillingAccount(stripeInfo.billing_account)
  }
  return 'ee'
}

async function trialPlanNameForCustomer(c: Context, customerId: string, fallbackPlanName?: string | null) {
  const stripeInfo = await getStripeCustomer(c, customerId)
  if (stripeInfo?.product_id) {
    const productId = stripeInfo.product_id
    // An invalid product id threw before; only lookup errors fall through to the fallback.
    planProductIdOrFilter(productId)
    const data = await adminQuery(c, client => queryPlanByProductId(client, productId)).catch(() => null)
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

  const billingAccount = await resolveBillingAccountForCreate(c, current)
  const selectedPlan = await resolveTrialPlan(c, current, billingAccount)
  if (!selectedPlan) {
    cloudlog({ requestId: c.get('requestId'), message: 'no default plan' })
    throw new Error('no default plan')
  }

  // Direct-offer (paid ads) creators get no trial; everyone else gets the standard trial.
  // Resolve before creating the Stripe customer so a failed lookup retries cleanly.
  const trial_at = await resolveNewOrgTrialEnd(c, supabaseAdmin(c), current.created_by)
  const customer = await createCustomer(c, current.management_email, current.created_by, current.id, current.name, billingAccount)
  cloudlog({ requestId: c.get('requestId'), message: 'createInfo', plan: selectedPlan, customer, billingAccount })

  let createInfoError: { code?: string, message?: string } | null = null
  try {
    await adminQuery(c, client => client.query(
      'INSERT INTO public.stripe_info (product_id, customer_id, trial_at, billing_account) VALUES ($1, $2, $3, $4)',
      [selectedPlan.stripe_id, customer.id, trial_at.toISOString(), billingAccount],
    ))
  }
  catch (error) {
    createInfoError = error as { code?: string, message?: string }
  }
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

  const updatedOrg = await adminQuery(c, client => client.query<{ customer_id: string | null }>('SELECT customer_id FROM public.orgs WHERE id = $1', [org.id]))
    .then(result => result.rows[0] ?? null, () => null)

  const linkedCustomerId = updatedOrg?.customer_id
  if (!isProvisionedStripeCustomerId(linkedCustomerId) && !isLocalStripeCustomerId(linkedCustomerId)) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'finalizePendingStripeCustomer: org customer_id not finalized, skipping delete',
      linkedCustomerId,
    })
    return
  }

  const deleteError = await deleteStripeInfo(c, pendingCustomerId)
  if (deleteError)
    cloudlogErr({ requestId: c.get('requestId'), message: 'finalizePendingStripeCustomer: orphan pending stripe_info', deleteError })

  return trialPlanName
}
