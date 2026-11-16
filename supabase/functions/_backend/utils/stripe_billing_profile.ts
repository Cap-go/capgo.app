import type Stripe from 'stripe'
import type { BillingDetails, BillingProfile, BillingTaxId } from '../../shared/billing-profile.ts'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { z } from 'zod'
import { BILLING_COUNTRIES, BILLING_TAX_ID_TYPES } from '../../shared/billing-profile.ts'
import { simpleError } from './hono.ts'

const field = z.string().trim().max(200)
const detailsSchema = z.object({
  name: field.min(1),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(20),
  address: z.object({
    line1: field.min(1),
    line2: field,
    city: field,
    state: field,
    postal_code: z.string().trim().max(20),
    country: z.string().trim().refine(value => BILLING_COUNTRIES.includes(value)),
  }).strict(),
}).strict()

export function parseBillingDetails(value: unknown): BillingDetails {
  const result = detailsSchema.safeParse(value)
  if (!result.success)
    throw simpleError('invalid_billing_details', 'Enter a name, valid billing email and billing address')
  return result.data
}

function toDetails(customer: Stripe.Customer): BillingDetails {
  return {
    name: customer.name ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    address: {
      line1: customer.address?.line1 ?? '',
      line2: customer.address?.line2 ?? '',
      city: customer.address?.city ?? '',
      state: customer.address?.state ?? '',
      postal_code: customer.address?.postal_code ?? '',
      country: customer.address?.country ?? '',
    },
  }
}

function toTaxId(taxId: Stripe.TaxId): BillingTaxId {
  return { id: taxId.id, type: taxId.type, value: taxId.value, status: taxId.verification?.status ?? 'unavailable' }
}

export async function getBillingProfile(ctx: InAppBillingContext): Promise<BillingProfile> {
  const [customer, taxIds] = await Promise.all([
    ctx.stripe.customers.retrieve(ctx.customerId),
    ctx.stripe.customers.listTaxIds(ctx.customerId, { limit: 100 }),
  ])
  if (customer.deleted)
    throw simpleError('no_customer', 'No customer')
  return { ...toDetails(customer), currency: customer.currency?.toLowerCase() ?? null, taxIds: taxIds.data.map(toTaxId) }
}

export async function updateBillingDetails(ctx: InAppBillingContext, value: unknown): Promise<BillingDetails> {
  const details = parseBillingDetails(value)
  // Explicit fields only: never let the caller change balances, discounts or tax exemptions.
  const customer = await ctx.stripe.customers.update(ctx.customerId, details)
  return toDetails(customer)
}

export async function addBillingTaxId(ctx: InAppBillingContext, value: unknown): Promise<BillingTaxId> {
  const result = z.object({ type: z.enum(BILLING_TAX_ID_TYPES), value: z.string().trim().min(1).max(100) }).strict().safeParse(value)
  if (!result.success)
    throw simpleError('invalid_tax_id', 'Enter a supported tax ID type and value')
  // The customer-scoped API prevents access to another organization's tax IDs.
  const taxId = await ctx.stripe.customers.createTaxId(ctx.customerId, result.data)
  return toTaxId(taxId)
}

export async function removeBillingTaxId(ctx: InAppBillingContext, id: unknown) {
  if (typeof id !== 'string' || !/^txi_[a-zA-Z0-9]+$/.test(id))
    throw simpleError('invalid_tax_id', 'Invalid tax ID')
  await ctx.stripe.customers.deleteTaxId(ctx.customerId, id)
}
