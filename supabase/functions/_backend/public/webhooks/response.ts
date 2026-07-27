import { z } from 'zod'

export const webhookPublicSelect = 'id, org_id, name, url, enabled, events, delivery_version, created_at, updated_at, created_by'
export const webhookCreatedSelect = `${webhookPublicSelect}, secret`

export const webhookPublicSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  events: z.array(z.string()),
  delivery_version: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
})

export const webhooksPublicSchema = z.array(webhookPublicSchema)
