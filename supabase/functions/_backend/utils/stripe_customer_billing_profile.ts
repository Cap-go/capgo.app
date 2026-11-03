import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { simpleError } from './hono.ts'
import { cloudlogErr } from './logging.ts'
import { isDeterministicStripeCustomerUpdateError, normalizeStripeCountryCode, syncStripeCustomerCountry } from './stripe.ts'

export const STRIPE_TAX_ID_TYPES = [
  'eu_vat',
  'gb_vat',
  'ch_vat',
  'no_vat',
  'au_abn',
  'ca_bn',
  'ca_qst',
  'us_ein',
  'nz_gst',
  'in_gst',
  'kr_brn',
] as const satisfies readonly Stripe.TaxIdCreateParams.Type[]

export type StripeTaxIdType = typeof STRIPE_TAX_ID_TYPES[number]

export interface CustomerBillingProfileAddress {
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  country: string | null
}

export interface CustomerBillingProfileTaxId {
  id: string
  type: StripeTaxIdType
  value: string
}

export interface CustomerBillingProfile {
  address: CustomerBillingProfileAddress
  taxId: CustomerBillingProfileTaxId | null
}

export interface CustomerBillingProfileUpdate {
  address: {
    line1: string
    line2?: string | null
    city?: string | null
    state?: string | null
    postalCode?: string | null
    country: string
  }
  taxId?: {
    type: StripeTaxIdType
    value: string
  } | null
}

function mapAddress(address: Stripe.Address | null | undefined): CustomerBillingProfileAddress {
  return {
    line1: address?.line1 ?? null,
    line2: address?.line2 ?? null,
    city: address?.city ?? null,
    state: address?.state ?? null,
    postalCode: address?.postal_code ?? null,
    country: normalizeStripeCountryCode(address?.country ?? null),
  }
}

function isAllowedTaxIdType(value: string): value is StripeTaxIdType {
  return (STRIPE_TAX_ID_TYPES as readonly string[]).includes(value)
}

function pickPrimaryTaxId(taxIds: Stripe.TaxId[]): CustomerBillingProfileTaxId | null {
  const taxId = taxIds.find(entry => isAllowedTaxIdType(entry.type)) ?? taxIds[0]
  if (!taxId || !isAllowedTaxIdType(taxId.type))
    return null
  return { id: taxId.id, type: taxId.type, value: taxId.value }
}

function normalizeOptionalString(value: string | null | undefined) {
  if (value == null)
    return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function normalizeTaxIdValue(value: string) {
  return value.replace(/\s+/g, '').toUpperCase()
}

function stripeOptionalAddressField(value: string | null | undefined) {
  return normalizeOptionalString(value) ?? ''
}

export async function getCustomerBillingProfile(c: Context, ctx: InAppBillingContext): Promise<CustomerBillingProfile> {
  const customer = await ctx.stripe.customers.retrieve(ctx.customerId)
  if (customer.deleted)
    throw simpleError('no_customer', 'No customer')

  const listed = await ctx.stripe.customers.listTaxIds(ctx.customerId, { limit: 10 })
  return {
    address: mapAddress(customer.address),
    taxId: pickPrimaryTaxId(listed.data),
  }
}

function stripeCustomerUpdateError(
  c: Context,
  ctx: InAppBillingContext,
  message: string,
  error: unknown,
  moreInfo: Record<string, unknown> = {},
): never {
  cloudlogErr({ requestId: c.get('requestId'), message, customerId: ctx.customerId, error })
  if (isDeterministicStripeCustomerUpdateError(error)) {
    const stripeError = error as { message?: string }
    throw simpleError('stripe_customer_update_failed', stripeError.message ?? 'Stripe rejected the billing update', {
      stripeCode: (error as { code?: string }).code ?? null,
      ...moreInfo,
    })
  }
  throw error
}

function parseBillingProfileUpdate(body: CustomerBillingProfileUpdate) {
  const line1 = body.address.line1?.trim()
  if (!line1)
    throw simpleError('invalid_address', 'Billing address line 1 is required')

  const country = normalizeStripeCountryCode(body.address.country)
  if (!country)
    throw simpleError('invalid_address', 'Billing country must be a two-letter ISO code')

  let taxId: CustomerBillingProfileUpdate['taxId'] | undefined
  if (body.taxId === null)
    taxId = null
  else if (body.taxId) {
    if (!isAllowedTaxIdType(body.taxId.type))
      throw simpleError('invalid_tax_id_type', 'Unsupported tax ID type')
    const value = normalizeTaxIdValue(body.taxId.value)
    if (!value)
      throw simpleError('invalid_tax_id', 'Tax ID value is required')
    taxId = { type: body.taxId.type, value }
  }

  return {
    address: {
      line1,
      line2: stripeOptionalAddressField(body.address.line2),
      city: stripeOptionalAddressField(body.address.city),
      state: stripeOptionalAddressField(body.address.state),
      postal_code: stripeOptionalAddressField(body.address.postalCode),
      country,
    },
    taxId,
  }
}

async function syncTaxIds(c: Context, ctx: InAppBillingContext, desired: CustomerBillingProfileUpdate['taxId'] | undefined) {
  if (desired === undefined)
    return

  const existing = await ctx.stripe.customers.listTaxIds(ctx.customerId, { limit: 10 })
  const current = pickPrimaryTaxId(existing.data)

  if (desired === null) {
    for (const taxId of existing.data) {
      if (!isAllowedTaxIdType(taxId.type))
        continue
      await ctx.stripe.customers.deleteTaxId(ctx.customerId, taxId.id)
    }
    return
  }

  const normalizedDesired = { type: desired.type, value: normalizeTaxIdValue(desired.value) }
  if (current?.type === normalizedDesired.type && normalizeTaxIdValue(current.value) === normalizedDesired.value)
    return

  let created: Stripe.TaxId
  try {
    created = await ctx.stripe.customers.createTaxId(ctx.customerId, normalizedDesired)
  }
  catch (error) {
    stripeCustomerUpdateError(c, ctx, 'createTaxId failed', error)
  }

  for (const taxId of existing.data) {
    if (taxId.id === created.id)
      continue
    if (!isAllowedTaxIdType(taxId.type))
      continue
    await ctx.stripe.customers.deleteTaxId(ctx.customerId, taxId.id)
  }
}

export async function updateCustomerBillingProfile(
  c: Context,
  ctx: InAppBillingContext,
  body: CustomerBillingProfileUpdate,
): Promise<CustomerBillingProfile> {
  const parsed = parseBillingProfileUpdate(body)

  try {
    await ctx.stripe.customers.update(ctx.customerId, { address: parsed.address })
  }
  catch (error) {
    stripeCustomerUpdateError(c, ctx, 'customer address update failed', error)
  }

  try {
    await syncTaxIds(c, ctx, parsed.taxId)
  }
  catch (error) {
    stripeCustomerUpdateError(c, ctx, 'customer tax id update failed', error, { addressSaved: true })
  }

  await syncStripeCustomerCountry(c, ctx.customerId).catch((error) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'syncStripeCustomerCountry after billing profile update failed', customerId: ctx.customerId, error })
  })

  return await getCustomerBillingProfile(c, ctx)
}
