// Import statements for Postgres and Stripe
// Ensure these are compatible with your environment.
import Stripe from 'stripe'
import { connectScriptDb } from './script_db.ts'

// Connect to the database
const databaseUrl = '****'
const db = await connectScriptDb(databaseUrl)

// Initialize Stripe client
const stripe = Stripe('****')

// create a function who loop on stripe_info 1000 by 1000 and return the complete list
async function getAllStripeInfos() {
  let stripeInfos: { subscription_id: string, customer_id: string, status: string, price_id: string }[] = []
  let offset = 0
  const limit = 1000
  let count = 0
  let total = 0
  do {
    const { rows: data } = await db.query(
      'SELECT subscription_id, customer_id, status, price_id FROM public.stripe_info ORDER BY id LIMIT $1 OFFSET $2',
      [limit, offset],
    ).catch((error) => {
      console.error('Error fetching data from Supabase:', error)
      return { rows: null }
    })
    if (!data)
      return []
    stripeInfos = stripeInfos.concat(data)
    total = data.length
    offset += limit
    count += total
  } while (total === limit)
  console.log('Total customers:', count)
  return stripeInfos
}

async function updateStripeStatus() {
  // Fetch all customer_ids from Supabase
  const stripeInfos = await getAllStripeInfos()
  if (!stripeInfos?.length) {
    console.error('Error fetching data from Supabase:')
    return
  }
  let count = 0

  for (const stripeInfo of stripeInfos) {
    // Retrieve subscription from Stripe
    if (!stripeInfo.subscription_id) {
      // skip this one
      continue
    }
    try {
      const subscription = await stripe.subscriptions.retrieve(stripeInfo.subscription_id)
      // console.log('subscription', subscription)
      // break;
      // Check if the subscription status is not succeeded
      if (subscription.status !== 'active' && stripeInfo.status === 'succeeded') {
        // Update the status in Supabase to canceled
        console.log('this customer is wrong status', stripeInfo.customer_id, subscription.status, stripeInfo.status)
        const updateError = await db.query('UPDATE public.stripe_info SET status = $1 WHERE customer_id = $2', ['canceled', stripeInfo.customer_id])
          .then(() => null, (error: unknown) => error)

        if (updateError)
          console.error('Error updating status in Supabase:', updateError)
        else
          console.log(`Updated status to canceled for customer_id: ${stripeInfo.customer_id}`)
      }
      else if (!subscription) {
        console.log('this customer is not found', stripeInfo.customer_id)
      }
      else if (subscription && stripeInfo.price_id && subscription.plan && subscription.plan.id !== stripeInfo.price_id) {
        console.log('this customer is wrong subscription', stripeInfo.customer_id, subscription.plan.id, stripeInfo.price_id)
      }
      else if (subscription && stripeInfo.price_id && !subscription.plan) {
        console.log('this customer don\'t have plan', stripeInfo.customer_id, subscription.status, subscription.id)
      }
      count++
    }
    catch (err) {
      console.log('err', err)
    }
  }
  console.log('Total count:', count)
}

// Run the function
await updateStripeStatus()
await db.end()
