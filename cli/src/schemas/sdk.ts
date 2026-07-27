import { z } from 'zod'
import { buildCredentialsSchema } from './build'
import { localizedReleaseNotesSchema, rejectConflictingBooleanGroup } from './common'

export const capacitorConfigOptionSchema = z.string().min(1).describe('Capacitor config source to update')

// ============================================================================
// SDK Result Schema
// ============================================================================

// Note: SDKResult<T> is generic and kept as interface for generic parameter support
export interface SDKResult<T = void> {
  success: boolean
  data?: T
  error?: string
  securityPolicyMessage?: string
  isSecurityPolicyError?: boolean
  warnings?: string[]
}

// ============================================================================
// SDK App Schemas
// ============================================================================

export const addAppOptionsSchema = z.object({
  appId: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type AddAppOptions = z.infer<typeof addAppOptionsSchema>

export const updateAppOptionsSchema = z.object({
  appId: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
  retention: z.number().optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type UpdateAppOptions = z.infer<typeof updateAppOptionsSchema>

export const appInfoSchema = z.object({
  appId: z.string(),
  name: z.string(),
  iconUrl: z.string().optional(),
  createdAt: z.date(),
})

export type AppInfo = z.infer<typeof appInfoSchema>

export const starRepoOptionsSchema = z.object({
  repository: z.string().optional(),
})

export type StarRepoOptions = z.infer<typeof starRepoOptionsSchema>

export const starAllRepositoriesOptionsSchema = z.object({
  repositories: z.array(z.string().min(1)).optional(),
  minDelayMs: z.number().int().min(0).optional(),
  maxDelayMs: z.number().int().min(0).optional(),
  maxConcurrency: z.number().int().min(1).max(16).optional(),
})

export type StarAllRepositoriesOptions = z.infer<typeof starAllRepositoriesOptionsSchema>

// ============================================================================
// SDK Bundle Schemas
// ============================================================================

export const uploadOptionsSchema = z.object({
  appId: z.string(),
  path: z.string(),
  bundle: z.string().optional(),
  channel: z.string().optional(),
  rollout: z.number().min(0).max(100).optional(),
  rolloutPercentageBps: z.number().int().min(0).max(10000).optional(),
  rolloutCacheTtlSeconds: z.number().int().min(60).max(31536000).optional(),
  apikey: z.string().optional(),
  external: z.string().optional(),
  encrypt: z.boolean().optional(),
  encryptionKey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
  timeout: z.number().optional(),
  useTus: z.boolean().optional(),
  comment: z.string().optional(),
  minUpdateVersion: z.string().optional(),
  autoMinUpdateVersion: z.boolean().optional(),
  autoSetBundle: z.boolean().optional(),
  selfAssign: z.boolean().optional(),
  packageJsonPaths: z.string().optional(),
  ignoreCompatibilityCheck: z.boolean().optional(),
  disableCodeCheck: z.boolean().optional(),
  useZip: z.boolean().optional(),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export type UploadOptions = z.infer<typeof uploadOptionsSchema>

export const uploadResultSchema = z.object({
  success: z.boolean(),
  bundleId: z.string().optional(),
  bundleUrl: z.string().optional(),
  checksum: z.string().nullable().optional(),
  encryptionMethod: z.enum(['none', 'v1', 'v2']).optional(),
  sessionKey: z.string().optional(),
  ivSessionKey: z.string().nullable().optional(),
  storageProvider: z.string().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).optional(),
})

export type UploadResult = z.infer<typeof uploadResultSchema>

export const bundleInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  channel: z.string().optional(),
  uploadedAt: z.date(),
  size: z.number(),
  encrypted: z.boolean(),
})

export type BundleInfo = z.infer<typeof bundleInfoSchema>

export const cleanupOptionsSchema = z.object({
  appId: z.string(),
  keep: z.number().optional(),
  bundle: z.string().optional(),
  force: z.boolean().optional(),
  ignoreChannel: z.boolean().optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type CleanupOptions = z.infer<typeof cleanupOptionsSchema>

// ============================================================================
// SDK Key Schemas
// ============================================================================

export const generateKeyOptionsSchema = z.object({
  force: z.boolean().optional().describe('Overwrite existing keys if they exist'),
  setupChannel: z.boolean().optional(),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export type GenerateKeyOptions = z.infer<typeof generateKeyOptionsSchema>

export const saveKeyOptionsSchema = z.object({
  keyPath: z.string().optional(),
  keyData: z.string().optional(),
  setupChannel: z.boolean().optional(),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export type SaveKeyOptions = z.infer<typeof saveKeyOptionsSchema>

export const deleteOldKeyOptionsSchema = z.object({
  force: z.boolean().optional(),
  setupChannel: z.boolean().optional(),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export type DeleteOldKeyOptions = z.infer<typeof deleteOldKeyOptionsSchema>

// ============================================================================
// SDK Channel Schemas
// ============================================================================

export const addChannelOptionsSchema = z.object({
  channelId: z.string().describe('Channel name'),
  appId: z.string(),
  default: z.boolean().optional(),
  selfAssign: z.boolean().optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type AddChannelOptions = z.infer<typeof addChannelOptionsSchema>

export const updateChannelOptionsBaseSchema = z.object({
  channelId: z.string().describe('Channel name'),
  appId: z.string(),
  bundle: z.string().optional(),
  state: z.string().optional(),
  downgrade: z.boolean().optional(),
  ios: z.boolean().optional(),
  android: z.boolean().optional(),
  selfAssign: z.boolean().optional(),
  disableAutoUpdate: z.string().optional(),
  dev: z.boolean().optional(),
  emulator: z.boolean().optional(),
  device: z.boolean().optional(),
  prod: z.boolean().optional(),
  rolloutBundle: z.string().optional(),
  rolloutPercentage: z.number().min(0).max(100).optional(),
  rolloutPercentageBps: z.number().int().min(0).max(10000).optional(),
  rolloutEnable: z.boolean().optional(),
  rolloutDisable: z.boolean().optional(),
  rolloutPause: z.boolean().optional(),
  rolloutResume: z.boolean().optional(),
  rolloutRollback: z.boolean().optional(),
  rolloutPromote: z.boolean().optional(),
  rolloutCacheTtlSeconds: z.number().int().min(60).max(31536000).optional(),
  autoPauseEnabled: z.boolean().optional(),
  autoPauseDisabled: z.boolean().optional(),
  autoPauseWindowMinutes: z.number().int().min(1).max(10080).optional(),
  autoPauseFailureRateBps: z.number().int().min(0).max(10000).nullable().optional(),
  autoPauseConfidence: z.number().gt(0).lt(1).optional(),
  autoPauseMinAttempts: z.number().int().min(0).nullable().optional(),
  autoPauseMinFailures: z.number().int().min(0).nullable().optional(),
  autoPauseAction: z.enum(['pause', 'rollback', 'notify']).optional(),
  autoPauseCooldownMinutes: z.number().int().min(0).max(10080).optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export const updateChannelOptionsSchema = updateChannelOptionsBaseSchema.superRefine((value, ctx) => {
  rejectConflictingBooleanGroup(value, ctx, ['rolloutEnable', 'rolloutDisable'])
  rejectConflictingBooleanGroup(value, ctx, ['rolloutPause', 'rolloutResume', 'rolloutRollback', 'rolloutPromote'])
  rejectConflictingBooleanGroup(value, ctx, ['autoPauseEnabled', 'autoPauseDisabled'])
})

export type UpdateChannelOptions = z.infer<typeof updateChannelOptionsSchema>

// ============================================================================
// SDK Organization Schemas
// ============================================================================

export const accountIdOptionsSchema = z.object({
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type AccountIdOptions = z.infer<typeof accountIdOptionsSchema>

export const listOrganizationsOptionsSchema = accountIdOptionsSchema

export type ListOrganizationsOptions = z.infer<typeof listOrganizationsOptionsSchema>

export const addOrganizationOptionsSchema = accountIdOptionsSchema.extend({
  name: z.string(),
  email: z.string(),
})

export type AddOrganizationOptions = z.infer<typeof addOrganizationOptionsSchema>

export const updateOrganizationOptionsSchema = accountIdOptionsSchema.extend({
  orgId: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
})

export type UpdateOrganizationOptions = z.infer<typeof updateOrganizationOptionsSchema>

export const organizationInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().optional(),
  appCount: z.number().optional(),
  email: z.string().optional(),
  createdAt: z.date().optional(),
})

export type OrganizationInfo = z.infer<typeof organizationInfoSchema>

export const deleteOrganizationOptionsSchema = accountIdOptionsSchema.extend({
  autoConfirm: z.boolean().optional(),
})

export type DeleteOrganizationOptions = z.infer<typeof deleteOrganizationOptionsSchema>

// ============================================================================
// SDK Login & Doctor Schemas
// ============================================================================

export const loginOptionsSchema = z.object({
  apikey: z.string(),
  local: z.boolean().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type LoginOptions = z.infer<typeof loginOptionsSchema>

export const doctorOptionsSchema = z.object({
  packageJson: z.string().optional(),
})

export type DoctorOptions = z.infer<typeof doctorOptionsSchema>

// ============================================================================
// SDK Bundle Compatibility Schemas
// ============================================================================

export const bundleCompatibilityOptionsSchema = z.object({
  appId: z.string(),
  channel: z.string(),
  packageJson: z.string().optional(),
  nodeModules: z.string().optional(),
  textOutput: z.boolean().optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type BundleCompatibilityOptions = z.infer<typeof bundleCompatibilityOptionsSchema>

// ============================================================================
// SDK Encrypt/Decrypt/Zip Schemas
// ============================================================================

export const encryptBundleOptionsSchema = z.object({
  zipPath: z.string(),
  checksum: z.string(),
  keyPath: z.string().optional(),
  keyData: z.string().optional(),
  json: z.boolean().optional(),
  packageJson: z.string().optional(),
})

export type EncryptBundleOptions = z.infer<typeof encryptBundleOptionsSchema>

export const decryptBundleOptionsSchema = z.object({
  zipPath: z.string(),
  ivSessionKey: z.string(),
  keyPath: z.string().optional(),
  keyData: z.string().optional(),
  checksum: z.string().optional(),
  packageJson: z.string().optional(),
})

export type DecryptBundleOptions = z.infer<typeof decryptBundleOptionsSchema>

export const zipBundleOptionsSchema = z.object({
  appId: z.string(),
  path: z.string(),
  bundle: z.string().optional(),
  name: z.string().optional(),
  codeCheck: z.boolean().optional(),
  json: z.boolean().optional(),
  keyV2: z.boolean().optional(),
  packageJson: z.string().optional(),
})

export type ZipBundleOptions = z.infer<typeof zipBundleOptionsSchema>

// ============================================================================
// SDK Build Schemas
// ============================================================================

export const requestBuildOptionsSchema = z.object({
  appId: z.string(),
  path: z.string().optional(),
  nodeModules: z.string().optional(),
  platform: z.enum(['ios', 'android']),
  credentials: buildCredentialsSchema.optional(),
  submitToStoreReview: z.boolean().optional(),
  storeReleaseName: z.string().min(1).optional(),
  storeReleaseNotes: z.string().min(1).optional(),
  storeReleaseNotesLocalized: localizedReleaseNotesSchema.optional(),
  iosTestflightGroups: z.string().min(1).optional(),
  iosAutomaticRelease: z.boolean().optional(),
  userId: z.string().optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
  prescan: z.boolean().optional(),
  prescanIgnoreFatal: z.boolean().optional(),
})

export type RequestBuildOptions = z.infer<typeof requestBuildOptionsSchema>

export const currentBundleOptionsSchema = accountIdOptionsSchema

export type CurrentBundleOptions = z.infer<typeof currentBundleOptionsSchema>

// ============================================================================
// SDK Settings Schemas
// ============================================================================

export const setSettingOptionsSchema = z.object({
  apikey: z.string().optional(),
  bool: z.string().optional(),
  string: z.string().optional(),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export type SetSettingOptions = z.infer<typeof setSettingOptionsSchema>

// ============================================================================
// SDK Stats Schemas
// ============================================================================

export const statsOrderSchema = z.object({
  key: z.string(),
  sortable: z.enum(['asc', 'desc']).optional(),
})

export type StatsOrder = z.infer<typeof statsOrderSchema>

export const getStatsOptionsSchema = z.object({
  appId: z.string(),
  deviceIds: z.array(z.string()).optional(),
  search: z.string().optional(),
  order: z.array(statsOrderSchema).optional(),
  rangeStart: z.string().optional(),
  rangeEnd: z.string().optional(),
  limit: z.number().optional(),
  after: z.string().nullable().optional(),
  apikey: z.string().optional(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type GetStatsOptions = z.infer<typeof getStatsOptionsSchema>

export const deviceStatsSchema = z.object({
  appId: z.string(),
  deviceId: z.string(),
  action: z.string(),
  versionId: z.number(),
  version: z.number().optional(),
  createdAt: z.string(),
})

export type DeviceStats = z.infer<typeof deviceStatsSchema>

// ============================================================================
// SDK Probe Schemas
// ============================================================================

export const probeOptionsSchema = z.object({
  platform: z.enum(['ios', 'android']),
})

export type ProbeOptions = z.infer<typeof probeOptionsSchema>
