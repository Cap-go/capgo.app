import { z } from 'zod'

const deviceIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const reverseDomainRegex = /^[a-z0-9]+(\.[\w-]+)+$/i
const commonSemverRegex = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

export const updateRequestSchemaZod = z.object({
  app_id: z.string().regex(reverseDomainRegex),
  device_id: z.string().max(36).regex(deviceIdRegex),
  version_name: z.string().min(1),
  version_build: z.string().min(1),
  is_emulator: z.boolean(),
  is_prod: z.boolean(),
  platform: z.enum(['ios', 'android', 'electron']),
  plugin_version: z.string().regex(commonSemverRegex),
  defaultChannel: z.string().optional(),
  install_source: z.string().max(64).optional(),
  key_id: z.string().max(20).optional(),
})
