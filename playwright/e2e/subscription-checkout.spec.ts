import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/types/supabase.types'
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

interface StripePriceResponse {
  id: string
}

test.describe('Subscription Checkout', () => {
  let supabase: SupabaseClient<Database>

  let orgId = ''
  let appId = ''
  let customerId = ''
  let currentPlanStripeId = ''
  let planStripeId = ''

  test.beforeAll(() => {
    supabase = getSupabaseClient()
  })

  test.afterEach(async () => {
    if (appId)
      await resetAppData(appId)

    if (orgId) {
      const { error: orgUsersError } = await supabase.from('org_users').delete().eq('org_id', orgId)
      expect(orgUsersError).toBeNull()
      const { error: orgError } = await supabase.from('orgs').delete().eq('id', orgId)
      expect(orgError).toBeNull()
    }

    if (customerId) {
      const { error: stripeInfoError } = await supabase.from('stripe_info').delete().eq('customer_id', customerId)
      expect(stripeInfoError).toBeNull()
    }

    if (currentPlanStripeId) {
      const { error: currentPlanError } = await supabase.from('plans').delete().eq('stripe_id', currentPlanStripeId)
      expect(currentPlanError).toBeNull()
    }

    if (planStripeId) {
      const { error: planError } = await supabase.from('plans').delete().eq('stripe_id', planStripeId)
      expect(planError).toBeNull()
    }
  })

  test('opens the Stripe emulator checkout flow for a subscription plan', async ({ page }) => {
    const shortId = randomUUID().replaceAll('-', '').slice(0, 12)
    const currentPlanName = `Emulate Current ${shortId}`
    const planName = `Emulate Upgrade ${shortId}`
    orgId = randomUUID()
    appId = `com.subscription.e2e.${shortId}`

    const customer = await stripeCreate<{ id: string }>('/v1/customers', {
      email: `subscription-e2e-${shortId}@capgo.app`,
      name: 'Subscription E2E',
    })
    customerId = customer.id

    const currentPlanProduct = await stripeCreate<{ id: string }>('/v1/products', {
      name: currentPlanName,
      description: 'Emulated current subscription product',
    })
    currentPlanStripeId = currentPlanProduct.id

    const subscriptionProduct = await stripeCreate<{ id: string }>('/v1/products', {
      name: planName,
      description: 'Emulated upgraded subscription product',
    })
    planStripeId = subscriptionProduct.id

    const currentMonthlyPrice = await stripeCreate<StripePriceResponse>('/v1/prices', {
      product: currentPlanProduct.id,
      currency: 'usd',
      unit_amount: 100,
      recurring: {
        interval: 'month',
        usage_type: 'licensed',
      },
    })

    const currentYearlyPrice = await stripeCreate<StripePriceResponse>('/v1/prices', {
      product: currentPlanProduct.id,
      currency: 'usd',
      unit_amount: 960,
      recurring: {
        interval: 'year',
        usage_type: 'licensed',
      },
    })

    const upgradeMonthlyPrice = await stripeCreate<StripePriceResponse>('/v1/prices', {
      product: subscriptionProduct.id,
      currency: 'usd',
      unit_amount: 1000,
      recurring: {
        interval: 'month',
        usage_type: 'licensed',
      },
    })

    const upgradeYearlyPrice = await stripeCreate<StripePriceResponse>('/v1/prices', {
      product: subscriptionProduct.id,
      currency: 'usd',
      unit_amount: 9600,
      recurring: {
        interval: 'year',
        usage_type: 'licensed',
      },
    })

    const { error: currentPlanError } = await supabase.from('plans').insert({
      bandwidth: 1,
      build_time_unit: 60,
      credit_id: currentPlanProduct.id,
      description: 'plan.solo.desc',
      market_desc: 'Emulator current subscription plan',
      mau: 1000,
      name: currentPlanName,
      native_build_concurrency: 2,
      price_m: 1,
      price_m_id: currentMonthlyPrice.id,
      price_y: 10,
      price_y_id: currentYearlyPrice.id,
      storage: 0,
      stripe_id: currentPlanProduct.id,
    })

    expect(currentPlanError).toBeNull()

    const { error: planError } = await supabase.from('plans').insert({
      bandwidth: 10,
      build_time_unit: 3600,
      credit_id: subscriptionProduct.id,
      description: 'plan.solo.desc',
      market_desc: 'Emulator subscription plan',
      mau: 10000,
      name: planName,
      native_build_concurrency: 3,
      price_m: 10,
      price_m_id: upgradeMonthlyPrice.id,
      price_y: 96,
      price_y_id: upgradeYearlyPrice.id,
      storage: 10,
      stripe_id: subscriptionProduct.id,
    })

    expect(planError).toBeNull()

    await resetAndSeedAppData(appId, {
      orgId,
      userId: USER_ID,
      stripeCustomerId: customerId,
      planProductId: currentPlanProduct.id,
    })

    await page.addInitScript((nextOrgId) => {
      localStorage.setItem('capgo_current_org_id', nextOrgId)
    }, orgId)
    await page.login('test@capgo.app', USER_PASSWORD)
    await page.goto('/settings/organization/plans')

    const planCard = page.locator('[data-test="plan-card"]').filter({
      has: page.getByRole('heading', { name: planName }),
    })

    await expect(planCard).toHaveCount(1)
    await expect(planCard.getByText('3 concurrent native builds')).toBeVisible()
    await expect(planCard.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
    await planCard.locator('[data-test="plan-action-button"]').click()

    // Web checkout opens a confirm dialog with a real target=_blank link.
    const confirmLink = page.getByRole('link', { name: 'Confirm' })
    await expect(confirmLink).toBeVisible()

    const escapedStripeOrigin = STRIPE_EMULATOR_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const checkoutUrlPattern = new RegExp(`${escapedStripeOrigin}/checkout/`)

    const [checkoutPage] = await Promise.all([
      page.waitForEvent('popup'),
      confirmLink.click(),
    ])
    await checkoutPage.waitForLoadState('domcontentloaded')
    await expect(checkoutPage).toHaveURL(checkoutUrlPattern)
    await checkoutPage.getByRole('button', { name: /^Pay / }).click()

    await checkoutPage.waitForURL(/\/settings\/organization\/plans\?success=1/)
    await expect(checkoutPage.getByRole('heading', { name: 'Thank You for subscribing to Capgo' })).toBeVisible()
  })
})
