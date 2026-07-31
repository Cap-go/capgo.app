import { z } from 'zod'
import { optionsBaseSchema } from './base'

// ============================================================================
// App Options Schemas
// ============================================================================

export const appOptionsSchema = optionsBaseSchema.extend({
  name: z.string().optional(),
  icon: z.string().optional(),
  retention: z.number().optional(),
  exposeMetadata: z.boolean().optional(),
  preview: z.boolean().optional(),
  allowDeviceCustomId: z.boolean().optional(),
  blockProviderInfraRequests: z.boolean().optional(),
  buildTimeoutMinutes: z.number().optional(),
  iosStoreUrl: z.string().optional(),
  androidStoreUrl: z.string().optional(),
  defaultUploadChannel: z.string().optional(),
  defaultDownloadChannel: z.string().optional(),
  disableDownloadChannels: z.boolean().optional(),
})

export type AppOptions = z.infer<typeof appOptionsSchema>

export const appDebugOptionsSchema = optionsBaseSchema.extend({
  device: z.string().optional(),
})

export type AppDebugOptions = z.infer<typeof appDebugOptionsSchema>

export const appSettingOptionsSchema = optionsBaseSchema.extend({
  bool: z.string().optional(),
  string: z.string().optional(),
})

export type AppSettingOptions = z.infer<typeof appSettingOptionsSchema>
