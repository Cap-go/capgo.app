import { z } from 'zod'
import { optionsBaseSchema } from './base'

// ============================================================================
// Bundle Upload Options Schema
// ============================================================================

export const optionsUploadSchema = optionsBaseSchema.extend({
  bundle: z.string().optional(),
  path: z.string().optional(),
  channel: z.string().optional(),
  rollout: z.number().min(0).max(100).optional(),
  rolloutPercentageBps: z.number().int().min(0).max(10000).optional(),
  rolloutCacheTtlSeconds: z.number().int().min(60).max(31536000).optional(),
  displayIvSession: z.boolean().optional(),
  external: z.string().optional(),
  key: z.boolean().optional(),
  keyV2: z.string().optional(),
  keyDataV2: z.string().optional(),
  ivSessionKey: z.string().optional(),
  s3Region: z.string().optional(),
  s3Apikey: z.string().optional(),
  s3Apisecret: z.string().optional(),
  s3BucketName: z.string().optional(),
  s3Port: z.number().optional(),
  s3SSL: z.boolean().optional(),
  s3Endpoint: z.string().optional(),
  bundleUrl: z.boolean().optional(),
  codeCheck: z.boolean().optional(),
  oldEncryption: z.boolean().optional(),
  minUpdateVersion: z.string().optional(),
  autoMinUpdateVersion: z.boolean().optional(),
  autoSetBundle: z.boolean().optional(),
  ignoreMetadataCheck: z.boolean().optional(),
  failOnIncompatible: z.boolean().optional(),
  ignoreChecksumCheck: z.boolean().optional(),
  forceCrc32Checksum: z.boolean().optional(),
  timeout: z.number().optional(),
  multipart: z.boolean().optional(),
  partial: z.boolean().optional(),
  partialOnly: z.boolean().optional(),
  delta: z.boolean().optional(),
  deltaOnly: z.boolean().optional(),
  tus: z.boolean().optional(),
  encryptedChecksum: z.string().optional(),
  packageJson: z.string().optional(),
  dryUpload: z.boolean().optional(),
  nodeModules: z.string().optional(),
  encryptPartial: z.boolean().optional(),
  deleteLinkedBundleOnUpload: z.boolean().optional(),
  tusChunkSize: z.number().optional(),
  zip: z.boolean().optional(),
  link: z.string().optional(),
  comment: z.string().optional(),
  noBrotliPatterns: z.string().optional(),
  disableBrotli: z.boolean().optional(),
  versionExistsOk: z.boolean().optional(),
  selfAssign: z.boolean().optional(),
  sendUpdateNotification: z.boolean().optional(),
  verbose: z.boolean().optional(),
  showReplicationProgress: z.boolean().optional(),
  qrPreview: z.boolean().optional(),
})

export type OptionsUpload = z.infer<typeof optionsUploadSchema>

// ============================================================================
// Bundle Result Schemas
// ============================================================================

export const zipResultSchema = z.object({
  bundle: z.string(),
  filename: z.string(),
  checksum: z.string(),
})

export type ZipResult = z.infer<typeof zipResultSchema>

export const encryptResultSchema = z.object({
  checksum: z.string(),
  filename: z.string(),
  ivSessionKey: z.string(),
})

export type EncryptResult = z.infer<typeof encryptResultSchema>

export const decryptResultSchema = z.object({
  outputPath: z.string(),
  checksumMatches: z.boolean().optional(),
})

export type DecryptResult = z.infer<typeof decryptResultSchema>

export const uploadBundleResultSchema = z.object({
  success: z.boolean(),
  appId: z.string().optional(),
  bundle: z.string(),
  updatedChannels: z.array(z.string()).optional(),
  checksum: z.string().nullable().optional(),
  encryptionMethod: z.enum(['none', 'v1', 'v2']),
  sessionKey: z.string().optional(),
  ivSessionKey: z.string().nullable().optional(),
  storageProvider: z.string().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  builderAction: z.enum(['launch-onboarding', 'launch-build']).optional(),
})

export type UploadBundleResult = z.infer<typeof uploadBundleResultSchema>

// ============================================================================
// Bundle Command Options Schemas
// ============================================================================

export const bundleZipOptionsSchema = optionsBaseSchema.extend({
  bundle: z.string().optional(),
  path: z.string().optional(),
  codeCheck: z.boolean().optional(),
  name: z.string().optional(),
  json: z.boolean().optional(),
  keyV2: z.boolean().optional(),
  packageJson: z.string().optional(),
})

export type BundleZipOptions = z.infer<typeof bundleZipOptionsSchema>

export const bundleDeleteOptionsSchema = optionsBaseSchema.extend({
  bundle: z.string(),
})

export type BundleDeleteOptions = z.infer<typeof bundleDeleteOptionsSchema>

export const bundleCompatibilityOptionsSchema = optionsBaseSchema.extend({
  channel: z.string().optional(),
  text: z.boolean().optional(),
  packageJson: z.string().optional(),
  nodeModules: z.string().optional(),
})

export type BundleCompatibilityOptions = z.infer<typeof bundleCompatibilityOptionsSchema>

export const bundleReleaseTypeOptionsSchema = optionsBaseSchema.extend({
  channel: z.string().optional(),
  packageJson: z.string().optional(),
  nodeModules: z.string().optional(),
})

export type BundleReleaseTypeOptions = z.infer<typeof bundleReleaseTypeOptionsSchema>

export const bundleCleanupOptionsSchema = optionsBaseSchema.extend({
  version: z.string(),
  bundle: z.string(),
  keep: z.number(),
  force: z.boolean(),
  ignoreChannel: z.boolean(),
})

export type BundleCleanupOptions = z.infer<typeof bundleCleanupOptionsSchema>

export const bundleEncryptOptionsSchema = z.object({
  key: z.string().optional(),
  keyData: z.string().optional(),
  json: z.boolean().optional(),
  packageJson: z.string().optional(),
})

export type BundleEncryptOptions = z.infer<typeof bundleEncryptOptionsSchema>

export const bundleDecryptOptionsSchema = z.object({
  key: z.string().optional(),
  keyData: z.string().optional(),
  checksum: z.string().optional(),
  packageJson: z.string().optional(),
})

export type BundleDecryptOptions = z.infer<typeof bundleDecryptOptionsSchema>
