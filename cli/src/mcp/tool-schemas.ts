import { z } from 'zod'
import { CLI_PROJECT_MODES } from '../framework/mode'
import { buildCacheKeyOptionSchema, buildCacheOptionSchema } from '../schemas/build'
import {
  capacitorConfigOptionSchema,
  getAccountOptionsSchema,
  observeOptionsObjectSchema,
  organizationMemberRoleOptionsSchema,
  organizationMemberSdkOptionsSchema,
  refineObserveDeviceId,
  updateAccountOptionsSchema,
  updateAppOptionsSchema,
  updateChannelOptionsBaseSchema,
  updateOrganizationOptionsSchema,
} from '../schemas/sdk'
import { DOCS_SEARCH_MAX_RESULTS } from '../shared/docs-search'

// Host fields stay out of MCP inputs so an agent cannot send the saved key to a host it chooses.
const sdkAuthFields = { apikey: true, apiHost: true, filesHost: true } as const

export const mcpAddAppInputSchema = z.object({
  appId: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
})

export const mcpUpdateAppInputSchema = updateAppOptionsSchema.omit(sdkAuthFields)

export const mcpDeleteAppInputSchema = z.object({
  appId: z.string().describe('App ID to delete'),
})

export const mcpUploadBundleInputSchema = z.object({
  appId: z.string(),
  path: z.string(),
  mode: z.enum(CLI_PROJECT_MODES).optional().describe('Project framework mode. Use cordova for Cordova apps without capacitor.config'),
  bundle: z.string().optional(),
  channel: z.string().optional(),
  rollout: z.number().min(0).max(100).optional(),
  rolloutPercentageBps: z.number().int().min(0).max(10000).optional(),
  rolloutCacheTtlSeconds: z.number().int().min(60).max(31536000).optional(),
  comment: z.string().optional(),
  minUpdateVersion: z.string().optional(),
  autoMinUpdateVersion: z.boolean().optional(),
  autoSetBundle: z.boolean().optional(),
  autoBump: z.enum(['major', 'minor', 'patch', 'metadata', 'ai']).optional().describe('Semver part to bump from latest remote version (default minor when set via CLI without value); ai classifies via Capgo Workers AI'),
  encrypt: z.boolean().optional(),
  acceptIncompatible: z.boolean().optional().describe('Accept native-package incompatibility as handled (still checks and warns, continues, skips the crash-warning email)'),
  delta: z.boolean().optional().describe('Also upload the per-file manifest for delta (differential) updates'),
  deltaOnly: z.boolean().optional().describe('Upload only the delta manifest files, without the full zip'),
  encryptDelta: z.boolean().optional().describe('Encrypt delta manifest files (auto-enabled for updater >= 6.14.4)'),
  apikey: z.string().optional().describe('API key to use instead of the saved one, e.g. from the hosted Capgo MCP tool capgo_get_upload_command'),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export const mcpListBundlesInputSchema = z.object({
  appId: z.string().describe('App ID to list bundles for'),
})

export const mcpDeleteBundleInputSchema = z.object({
  appId: z.string().describe('App ID'),
  bundleId: z.string().describe('Bundle version to delete'),
})

export const mcpCleanupBundlesInputSchema = z.object({
  appId: z.string(),
  keep: z.number().optional(),
  bundle: z.string().optional(),
  force: z.boolean().optional(),
  ignoreChannel: z.boolean().optional(),
})

export const mcpCheckCompatibilityInputSchema = z.object({
  appId: z.string().describe('App ID to check'),
  channel: z.string().describe('Channel to check compatibility with'),
  packageJson: z.string().describe('Path to package.json for monorepos').optional(),
})

export const mcpListChannelsInputSchema = z.object({
  appId: z.string().describe('App ID to list channels for'),
})

export const mcpAddChannelInputSchema = z.object({
  appId: z.string().describe('App ID'),
  channelId: z.string().describe('Channel name to create'),
  default: z.boolean().describe('Set as default channel').optional(),
  selfAssign: z.boolean().describe('Allow devices to self-assign to this channel').optional(),
})

export const mcpUpdateChannelInputSchema = z.object({
  channelId: z.string().describe('Channel name'),
  appId: z.string(),
  bundle: z.string().optional(),
  state: z.string().optional(),
  downgrade: z.boolean().optional(),
  ios: z.boolean().optional(),
  android: z.boolean().optional(),
  electron: z.boolean().optional(),
  pause: z.boolean().optional().describe('Pause every update on this channel; devices stay on their current bundle'),
  resume: z.boolean().optional().describe('Resume updates on a paused channel'),
  selfAssign: z.boolean().optional(),
  disableAutoUpdate: z.string().optional(),
  updatePackage: updateChannelOptionsBaseSchema.shape.updatePackage.describe('Which update package types devices may download'),
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
  acceptIncompatible: z.boolean().optional().describe('Accept native-package incompatibility as handled (still checks and warns, sets the channel instead of failing)'),
})

export const mcpDeleteChannelInputSchema = z.object({
  appId: z.string().describe('App ID'),
  channelId: z.string().describe('Channel name to delete'),
  deleteBundle: z.boolean().describe('Also delete the bundle linked to this channel').optional(),
})

export const mcpGetCurrentBundleInputSchema = z.object({
  appId: z.string().describe('App ID'),
  channelId: z.string().describe('Channel name'),
})

export const mcpPromoteChannelInputSchema = z.object({
  appId: z.string().describe('App ID'),
  fromChannel: z.string().describe('Channel to copy the current bundle from, for example staging'),
  toChannel: z.string().describe('Channel to link that bundle to, for example production'),
  acceptIncompatible: z.boolean().describe('Link the bundle even if its native packages do not match the target channel').optional(),
  ignoreMetadataCheck: z.boolean().describe('Skip the native package compatibility check. Cannot be combined with acceptIncompatible').optional(),
  sendUpdateNotification: z.boolean().describe('Send a native update-check notification to devices on the target channel after linking').optional(),
})

export const mcpAddOrganizationInputSchema = z.object({
  name: z.string().describe('Organization name'),
  email: z.string().describe('Management email for the organization'),
})

export const mcpOrgIdInputSchema = z.object({
  orgId: z.string().describe('Organization ID (use capgo_list_organizations to find it)'),
})

export const mcpUpdateOrganizationInputSchema = updateOrganizationOptionsSchema.omit(sdkAuthFields)

export const mcpOrganizationMemberRoleInputSchema = organizationMemberRoleOptionsSchema.omit(sdkAuthFields)

export const mcpRemoveOrganizationMemberInputSchema = organizationMemberSdkOptionsSchema.omit(sdkAuthFields)

export const mcpGetAccountInputSchema = getAccountOptionsSchema.omit(sdkAuthFields)

export const mcpUpdateAccountInputSchema = updateAccountOptionsSchema.omit(sdkAuthFields)

export const mcpSearchDocsInputSchema = z.object({
  query: z.string().trim().min(1).max(200).describe('Search terms, e.g. "progressive rollout" or "encryption key"'),
  limit: z.number().int().min(1).max(DOCS_SEARCH_MAX_RESULTS).optional().describe('Maximum results, default 8'),
})

export const mcpSetProjectDirInputSchema = z.object({
  path: z.string().min(1).describe('Absolute path to the Capacitor app folder (with capacitor.config.* and its package.json), or a workspace containing exactly one Capacitor app. Multiple apps require an explicit app path. Relative paths resolve from the current project directory.'),
})

export const mcpProjectDirOptionSchema = z.string().trim().min(1).optional().describe('Absolute path of the agent\'s Capacitor app or workspace. Selects the project for this and subsequent calls on every tool. Omit to use MCP roots or the previously selected project.')

export const mcpDoctorInputSchema = z.object({
  packageJson: z.string().describe('Path to package.json for monorepos').optional(),
})

export const mcpGetStatsInputSchema = z.object({
  appId: z.string(),
  deviceIds: z.array(z.string()).optional(),
  limit: z.number().optional(),
  rangeStart: z.string().optional(),
  rangeEnd: z.string().optional(),
})

export const mcpObserveInputSchema = observeOptionsObjectSchema.omit(sdkAuthFields).superRefine(refineObserveDeviceId)

export const mcpRequestBuildInputSchema = z.object({
  appId: z.string(),
  platform: z.enum(['ios', 'android']),
  path: z.string().optional(),
  nodeModules: z.string().optional(),
  useStoredCredentials: z.boolean().optional().describe('Use the signing credentials stored on Capgo for this app (saved with "build credentials push"; needs app admin rights) instead of only the locally saved ones'),
  cache: buildCacheOptionSchema.describe('When false, disables compilation cache for this build. Omit or true to use the default (cache enabled).'),
  cacheKey: buildCacheKeyOptionSchema.describe('Custom compilation cache key (e.g. rc, prod) to share or isolate cache between environments.'),
})

export const mcpGenerateEncryptionKeysInputSchema = z.object({
  force: z.boolean().describe('Overwrite existing keys if they exist').optional(),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export const mcpProbeInputSchema = z.object({
  platform: z.enum(['ios', 'android']).describe('Target platform to probe'),
})
