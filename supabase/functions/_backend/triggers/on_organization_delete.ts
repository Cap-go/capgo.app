import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { cancelSubscription } from '../utils/stripe.ts'
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

  if (record.customer_id) {
    try {
      await cancelSubscription(c, record.customer_id)
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'failed to cancel Stripe subscriptions during org delete', error, customer_id: record.customer_id })
    }

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

  // Delete all organization images from storage
  // Organization images are stored at: images/org/{org_id}/*
  try {
    // List all files under the org folder recursively
    const { data: folders } = await supabaseAdmin(c)
      .storage
      .from('images')
      .list(`org/${record.id}`)

    if (folders && folders.length > 0) {
      // For each subfolder (app_id), list and delete files
      for (const folder of folders) {
        if (folder.id === null) {
          // This is a directory (app folder), list its contents
          const { data: appFiles } = await supabaseAdmin(c)
            .storage
            .from('images')
            .list(`org/${record.id}/${folder.name}`)

          if (appFiles && appFiles.length > 0) {
            const filePaths = appFiles.map(file => `org/${record.id}/${folder.name}/${file.name}`)
            await supabaseAdmin(c)
              .storage
              .from('images')
              .remove(filePaths)
            cloudlog({ requestId: c.get('requestId'), message: 'deleted org app images', count: appFiles.length, folder: folder.name })
          }
        }
        else {
          // This is a file directly in the org folder
          await supabaseAdmin(c)
            .storage
            .from('images')
            .remove([`org/${record.id}/${folder.name}`])
        }
      }
      cloudlog({ requestId: c.get('requestId'), message: 'deleted all org images', org_id: record.id })
    }
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error deleting org images', error, org_id: record.id })
  }

  return c.json(BRES)
})
