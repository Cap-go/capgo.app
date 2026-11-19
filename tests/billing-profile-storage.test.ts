import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from './sql-data-client'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)
const customerId = `cus_billing_profile_test_${randomUUID().replaceAll('-', '')}`
afterAll(async () => {
  await admin.from('stripe_info').delete().eq('customer_id', customerId)
})

describe('billing profile database mirror', () => {
  it('stores corrected address and currency, rejects malformed currencies and hides billing data from outsiders', async () => {
    const plan = await admin.from('plans').select('stripe_id').eq('name', 'Solo').single()
    expect(plan.error).toBeNull()
    const { error } = await admin.from('stripe_info').insert({ customer_id: customerId, product_id: plan.data!.stripe_id!, billing_account: 'ee', billing_address: { country: 'AR', city: 'Example City' }, billing_currency: 'ars', customer_country: 'AR' })
    expect(error).toBeNull()
    const update = await admin.from('stripe_info').update({ billing_address: { country: 'DE', city: 'Berlin' }, customer_country: 'DE' }).eq('customer_id', customerId).select('billing_address,billing_currency,customer_country').single()
    expect(update.error).toBeNull()
    expect(update.data).toEqual({ billing_address: { country: 'DE', city: 'Berlin' }, billing_currency: 'ars', customer_country: 'DE' })
    const invalid = await admin.from('stripe_info').update({ billing_currency: 'INVALID' }).eq('customer_id', customerId)
    expect(invalid.error?.code).toBe('23514')
    const hidden = await anon.from('stripe_info').select('billing_address,billing_currency').eq('customer_id', customerId)
    expect(hidden.error).toBeNull()
    expect(hidden.data).toEqual([])
  })
})
