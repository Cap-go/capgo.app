import { z } from 'zod'
import { capacitorConfigOptionSchema } from '../schemas/sdk'

export const mcpAddAppInputSchema = z.object({
  appId: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
})

export const mcpUpdateAppInputSchema = z.object({
  appId: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
  retention: z.number().optional(),
})

export const mcpDeleteAppInputSchema = z.object({
  appId: z.string().describe('App ID to delete'),
})

export const mcpUploadBundleInputSchema = z.object({
  appId: z.string(),
  path: z.string(),
  bundle: z.string().optional(),
  channel: z.string().optional(),
  rollout: z.number().min(0).max(100).optional(),
  rolloutPercentageBps: z.number().int().min(0).max(10000).optional(),
  rolloutCacheTtlSeconds: z.number().int().min(60).max(31536000).optional(),
  comment: z.string().optional(),
  minUpdateVersion: z.string().optional(),
  autoMinUpdateVersion: z.boolean().optional(),
  autoSetBundle: z.boolean().optional(),
  encrypt: z.boolean().optional(),
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

export const mcpAddOrganizationInputSchema = z.object({
  name: z.string().describe('Organization name'),
  email: z.string().describe('Management email for the organization'),
})

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

export const mcpRequestBuildInputSchema = z.object({
  appId: z.string(),
  platform: z.enum(['ios', 'android']),
  path: z.string().optional(),
  nodeModules: z.string().optional(),
})

export const mcpGenerateEncryptionKeysInputSchema = z.object({
  force: z.boolean().describe('Overwrite existing keys if they exist').optional(),
  capacitorConfig: capacitorConfigOptionSchema.optional(),
})

export const mcpProbeInputSchema = z.object({
  platform: z.enum(['ios', 'android']).describe('Target platform to probe'),
})
