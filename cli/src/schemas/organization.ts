import { z } from 'zod'
import { optionsBaseSchema } from './base'

// ============================================================================
// Organization Command Options Schemas
// ============================================================================

export const organizationAddOptionsSchema = optionsBaseSchema.extend({
  name: z.string().optional(),
  email: z.string().optional(),
})

export type OrganizationAddOptions = z.infer<typeof organizationAddOptionsSchema>

export const organizationDeleteOptionsSchema = optionsBaseSchema.extend({
  autoConfirm: z.boolean().optional(),
})

export type OrganizationDeleteOptions = z.infer<typeof organizationDeleteOptionsSchema>

export const passwordPolicyConfigSchema = z.object({
  enabled: z.boolean(),
  min_length: z.number(),
  require_uppercase: z.boolean(),
  require_number: z.boolean(),
  require_special: z.boolean(),
})

export type PasswordPolicyConfig = z.infer<typeof passwordPolicyConfigSchema>

export const organizationSetOptionsSchema = optionsBaseSchema.extend({
  name: z.string().optional(),
  email: z.string().optional(),
  enforce2fa: z.boolean().optional(),
  passwordPolicy: z.boolean().optional(),
  minLength: z.number().optional(),
  requireUppercase: z.boolean().optional(),
  requireNumber: z.boolean().optional(),
  requireSpecial: z.boolean().optional(),
  requireApikeyExpiration: z.boolean().optional(),
  maxApikeyExpirationDays: z.number().nullable().optional(),
  enforceHashedApiKeys: z.boolean().optional(),
})

export type OrganizationSetOptions = z.infer<typeof organizationSetOptionsSchema>
