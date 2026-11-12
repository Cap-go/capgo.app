import { z } from 'zod'
import { CLI_PROJECT_MODES } from '../framework/mode'
import { buildCacheKeyOptionSchema, buildCacheOptionSchema } from '../schemas/build'
import { capacitorConfigOptionSchema } from '../schemas/sdk'

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

export const mcpCheckCompatibilityInputSchema = z.object({
  appId: z.string().describe('App ID to check'),
  channel: z.string().describe('Channel to check compatibility with'),
  packageJson: z.string().describe('Path to package.json for monorepos').optional(),
})

export const mcpSetProjectDirInputSchema = z.object({
  path: z.string().min(1).describe('Absolute path to the Capacitor app folder (with capacitor.config.* and its package.json), or a workspace containing exactly one Capacitor app. Multiple apps require an explicit app path. Relative paths resolve from the current project directory.'),
})

export const mcpProjectDirOptionSchema = z.string().trim().min(1).optional().describe('Absolute path of the agent\'s Capacitor app or workspace. Selects the project for this and subsequent calls on every tool. Omit to use MCP roots or the previously selected project.')

export const mcpCwdOptionSchema = mcpProjectDirOptionSchema.describe('Alias for projectDir: the agent\'s working directory, not the MCP server\'s launch directory. Selects the app for this and subsequent calls. Relative tool paths resolve from the selected app.')

export const mcpDoctorInputSchema = z.object({
  packageJson: z.string().describe('Path to package.json for monorepos').optional(),
})

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
