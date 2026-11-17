export type InvoiceBillingDetails = 'issued' | 'current'

export interface InvoiceDocument {
  number: string
  issued: string
  due: string | null
  status: string
  summary: string
  seller: string[]
  customer: string[]
  fields: { name: string, value: string }[]
  description: string | null
  lines: { description: string, period: string, quantity: string, unitPrice: string, amount: string, tax?: string }[]
  totals: { label: string, amount: string, strong?: boolean }[]
  notes: string[]
}
