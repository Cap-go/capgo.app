import { z } from 'zod'

export const invoiceEmailPreferencesSchema = z.object({
  enabled: z.boolean(),
  recipients: z.array(z.string().trim().email().max(254).transform(value => value.toLowerCase())).max(5),
}).strict().transform(value => ({ ...value, recipients: [...new Set(value.recipients)] }))

export interface InvoiceEmailPreferences {
  enabled: boolean
  recipients: string[]
  defaultEmail: string
}
