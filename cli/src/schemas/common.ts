import { z } from 'zod'

// ============================================================================
// Shared Validation Helpers
// ============================================================================

export function rejectConflictingBooleanGroup(
  data: Record<string, unknown>,
  ctx: z.RefinementCtx,
  keys: string[],
): void {
  const selected = keys.filter(key => data[key] === true)
  if (selected.length < 2)
    return

  const first = String(selected[0])
  for (const key of selected.slice(1)) {
    ctx.addIssue({
      code: 'custom',
      message: `not used together with "${first}"`,
      path: [key],
    })
  }
}

// ============================================================================
// Native Package Schema
// ============================================================================

export const nativePackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  requested_version: z.string().optional(),
  ios_checksum: z.string().optional(),
  android_checksum: z.string().optional(),
})

export type NativePackage = z.infer<typeof nativePackageSchema>

// ============================================================================
// Compatibility Schemas
// ============================================================================

export const incompatibilityReasonSchema = z.enum([
  'new_plugin',
  'removed_plugin',
  'version_mismatch',
  'requested_version_changed',
  'ios_code_changed',
  'android_code_changed',
  'both_platforms_changed',
])

export type IncompatibilityReason = z.infer<typeof incompatibilityReasonSchema>

export const compatibilitySchema = z.object({
  name: z.string(),
  localVersion: z.string().optional(),
  remoteVersion: z.string().optional(),
  localRequestedVersion: z.string().optional(),
  remoteRequestedVersion: z.string().optional(),
  localIosChecksum: z.string().optional(),
  remoteIosChecksum: z.string().optional(),
  localAndroidChecksum: z.string().optional(),
  remoteAndroidChecksum: z.string().optional(),
})

export type Compatibility = z.infer<typeof compatibilitySchema>

export const compatibilityDetailsSchema = z.object({
  compatible: z.boolean(),
  reasons: incompatibilityReasonSchema.array(),
  message: z.string(),
})

export type CompatibilityDetails = z.infer<typeof compatibilityDetailsSchema>

// ============================================================================
// Security Policy Error Schema
// ============================================================================

export const parsedSecurityErrorSchema = z.object({
  isSecurityPolicyError: z.boolean(),
  errorCode: z.string(),
  message: z.string(),
})

export type ParsedSecurityError = z.infer<typeof parsedSecurityErrorSchema>

// ============================================================================
// Localized Store Release Notes
// ============================================================================

export const localizedReleaseNotesSchema = z.record(z.string(), z.string()).transform((data, ctx) => {
  if (data === null || typeof data !== 'object' || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
    ctx.addIssue({ code: 'custom', message: 'a plain object of locale keys to release notes' })
    return z.NEVER
  }
  const out = Object.create(null) as Record<string, string>
  for (const [rawKey, rawValue] of Object.entries(data)) {
    const key = rawKey.trim()
    const value = rawValue.trim()
    if (!key) {
      ctx.addIssue({ code: 'custom', message: 'a non-empty locale key' })
      return z.NEVER
    }
    if (!value) {
      ctx.addIssue({ code: 'custom', message: 'a non-empty release note' })
      return z.NEVER
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      ctx.addIssue({ code: 'custom', message: `a unique locale key (duplicate after trim: "${key}")` })
      return z.NEVER
    }
    out[key] = value
  }
  return out
})
