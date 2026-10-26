import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/types/database.types'
import { randomUUID } from 'node:crypto'
import { getSupabaseClient, resetAndSeedAppData, resetAppData, USER_ID, USER_PASSWORD } from '../../tests/test-utils'
import { expect, test } from '../support/commands'

const STRIPE_EMULATOR_URL = process.env.STRIPE_API_BASE_URL ?? `http://localhost:${process.env.STRIPE_EMULATOR_PORT ?? '4510'}`
const STRIPE_EMULATOR_HEADERS = {
  'Authorization': 'Bearer playwright-stripe',
  'Content-Type': 'application/json',
}

async function stripeCreate<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${STRIPE_EMULATOR_URL}${path}`, {
    method: 'POST',
    headers: STRIPE_EMULATOR_HEADERS,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Stripe emulator request failed for ${path}: ${response.status} ${await response.text()}`)
  }

  return await response.json() as T
}

test.describe('Credit Top-Up', () => {
  let capgo: SupabaseClient<Database>

  let orgId = ''
  let appId = ''
  let customerId = ''
  let planStripeId = ''

  test.beforeAll(() => {
    capgo = getSupabaseClient()
  })

  test.afterEach(async () => {
    if (appId)
      await resetAppData(appId)

    if (orgId) {
      const { error: orgUsersError } = await capgo.from('org_users').delete().eq('org_id', orgId)
      expect(orgUsersError).toBeNull()
      const { error: orgError } = await capgo.from('orgs').delete().eq('id', orgId)
      expect(orgError).toBeNull()
    }

    if (customerId) {
      const { error: stripeInfoError } = await capgo.from('stripe_info').delete().eq('customer_id', customerId)
      expect(stripeInfoError).toBeNull()
    }

    if (planStripeId) {
      const { error: planError } = await capgo.from('plans').delete().eq('stripe_id', planStripeId)
      expect(planError).toBeNull()
    }
  })

  test('completes a credit purchase through the Stripe emulator checkout flow', async ({ page }) => {
    const uniqueId = randomUUID()
    const shortId = uniqueId.replaceAll('-', '').slice(0, 12)
    orgId = randomUUID()
    appId = `com.credits.e2e.${shortId}`

    const customer = await stripeCreate<{ id: string }>('/v1/customers', {
      email: `credits-e2e-${shortId}@capgo.app`,
      name: 'Credits E2E',
    })
    customerId = customer.id

    const creditProduct = await stripeCreate<{ id: string }>('/v1/products', {
      name: `Credits ${shortId}`,
      description: 'Emulated credit product',
    })

    await stripeCreate('/v1/prices', {
      product: creditProduct.id,
      currency: 'usd',
      unit_amount: 100,
    })

    planStripeId = `prod_emulate_plan_${shortId}`
    const priceMonthlyId = `price_emulate_monthly_${shortId}`
    const priceYearlyId = `price_emulate_yearly_${shortId}`

    const { error: planError } = await capgo.from('plans').insert({
      bandwidth: 1,
      build_time_unit: 60,
      credit_id: creditProduct.id,
      description: 'plan.solo.desc',
      market_desc: 'Emulator credits plan',
      mau: 1000,
      name: `Emulate Plan ${shortId}`,
      price_m: 1,
      price_m_id: priceMonthlyId,
      price_y: 12,
      price_y_id: priceYearlyId,
      storage: 1,
      stripe_id: planStripeId,
    })

    expect(planError).toBeNull()

    await resetAndSeedAppData(appId, {
      orgId,
      userId: USER_ID,
      stripeCustomerId: customerId,
      planProductId: planStripeId,
    })

    await page.addInitScript((nextOrgId) => {
      localStorage.setItem('capgo_current_org_id', nextOrgId)
    }, orgId)

    await page.login('test@capgo.app', USER_PASSWORD)

    await page.goto('/settings/organization/credits')
    await page.getByRole('button', { name: '$50', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: 'Credits to purchase' })).toHaveValue('50')

    const escapedStripeOrigin = STRIPE_EMULATOR_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await page.click('[data-test="credits-top-up-submit"]')
    await expect(page).toHaveURL(new RegExp(`${escapedStripeOrigin}/checkout/`))
    await page.getByRole('button', { name: /^Pay / }).click()

    await page.waitForURL(/\/settings\/organization\/credits/)
    await expect(page.locator('[data-test="toast"]')).toContainText('Credits purchased successfully.')

    await expect.poll(async () => {
      const { data, error } = await capgo
        .from('usage_credit_transactions')
        .select('amount, source_ref')
        .eq('org_id', orgId)
        .eq('transaction_type', 'purchase')
        .order('occurred_at', { ascending: false })
        .limit(1)

      if (error)
        throw error

      return data?.[0] ?? null
    }).toMatchObject({
      amount: 50,
      source_ref: expect.objectContaining({
        sessionId: expect.stringMatching(/^cs_/),
      }),
    })
  })
})
