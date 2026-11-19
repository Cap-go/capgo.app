import { z } from 'zod'

export const webhookPublicSelect = 'id, org_id, name, url, enabled, events, delivery_version, created_at, updated_at, created_by, source, expires_at, mcp_event, mcp_arguments, mcp_verified_at'
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
  source: z.string().optional(),
  expires_at: z.string().nullable().optional(),
  mcp_event: z.string().nullable().optional(),
  mcp_arguments: z.record(z.string(), z.unknown()).nullable().optional(),
  mcp_verified_at: z.string().nullable().optional(),
})

export const webhooksPublicSchema = z.array(webhookPublicSchema)
