import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, triggerValidator } from '../utils/hono.ts'
import { removeImageFolder } from '../utils/image_storage.ts'
import { cloudlog } from '../utils/logging.ts'
import { cancelSubscription } from '../utils/stripe.ts'
import { BillingAccountUnavailableError } from '../utils/stripe_billing.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('orgs', 'DELETE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['orgs']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'no org id' })
    return c.json(BRES)
  }

  cloudlog({ requestId: c.get('requestId'), message: 'org delete', record })

  // Keep stripe_info when its Stripe account is unreachable: it is the only record of which account still bills this customer.
  let keepStripeInfo = false
  if (record.customer_id) {
    try {
      await cancelSubscription(c, record.customer_id)
    }
    catch (error) {
      keepStripeInfo = error instanceof BillingAccountUnavailableError
      cloudlog({ requestId: c.get('requestId'), message: 'failed to cancel Stripe subscriptions during org delete', error, customer_id: record.customer_id, keepStripeInfo })
    }
  }

  if (record.customer_id && !keepStripeInfo) {
    const { error: stripeInfoDeleteError } = await supabaseAdmin(c)
      .from('stripe_info')
      .delete()
      .eq('customer_id', record.customer_id)

    if (stripeInfoDeleteError) {
      cloudlog({ requestId: c.get('requestId'), message: 'failed to delete stripe_info during org delete', error: stripeInfoDeleteError, customer_id: record.customer_id })
    }
    else {
      cloudlog({ requestId: c.get('requestId'), message: 'deleted stripe_info during org delete', customer_id: record.customer_id })
    }
  }

  const pendingCustomerId = `pending_${record.id}`
  const { error: pendingStripeInfoDeleteError } = await supabaseAdmin(c)
    .from('stripe_info')
    .delete()
    .eq('customer_id', pendingCustomerId)

  if (pendingStripeInfoDeleteError) {
    cloudlog({ requestId: c.get('requestId'), message: 'failed to delete pending stripe_info during org delete', error: pendingStripeInfoDeleteError, customer_id: pendingCustomerId })
  }

  // Delete all organization images from image storage
  // Organization images are stored at: images/org/{org_id}/*
  try {
    const deleted = await removeImageFolder(c, `org/${record.id}`)
    cloudlog({ requestId: c.get('requestId'), message: 'deleted all org images', count: deleted, org_id: record.id })
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error deleting org images', error, org_id: record.id })
  }

  return c.json(BRES)
})
