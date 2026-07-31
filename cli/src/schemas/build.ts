import { z } from 'zod'
import { localizedReleaseNotesSchema } from './common'
import { optionsBaseSchema } from './base'

const inAppUpdatePrioritySchema = z.union([
  z.number().int().min(0).max(5),
  // Reject blank strings (Number('') === 0); match arktype string.numeric.parse.
  z.string().regex(/^[+-]?\d+$/).transform((value, ctx) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
      ctx.addIssue({ code: 'custom', message: 'must be an integer between 0 and 5' })
      return z.NEVER
    }
    return parsed
  }),
])

// ============================================================================
// Build Credentials Schema
// ============================================================================

export const buildCredentialsSchema = z.object({
  BUILD_CERTIFICATE_BASE64: z.string().optional(),
  BUILD_PROVISION_PROFILE_BASE64: z.string().optional(),
  P12_PASSWORD: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_ISSUER_ID: z.string().optional(),
  APPLE_KEY_CONTENT: z.string().optional(),
  APP_STORE_CONNECT_TEAM_ID: z.string().optional(),
  FASTLANE_USER: z.string().optional(),
  FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: z.string().optional(),
  APPLE_APP_ID: z.string().optional(),
  CAPGO_IOS_PROVISIONING_MAP: z.string().optional(),
  CAPGO_STORE_SUBMIT_REVIEW: z.string().optional(),
  CAPGO_STORE_RELEASE_NAME: z.string().optional(),
  CAPGO_STORE_RELEASE_NOTES: z.string().optional(),
  CAPGO_STORE_RELEASE_NOTES_LOCALIZED: z.string().optional(),
  CAPGO_IOS_TESTFLIGHT_GROUPS: z.string().optional(),
  CAPGO_IOS_AUTOMATIC_RELEASE: z.string().optional(),
  ANDROID_KEYSTORE_FILE: z.string().optional(),
  KEYSTORE_KEY_ALIAS: z.string().optional(),
  KEYSTORE_KEY_PASSWORD: z.string().optional(),
  KEYSTORE_STORE_PASSWORD: z.string().optional(),
  PLAY_CONFIG_JSON: z.string().optional(),
  PLAY_STORE_IN_APP_UPDATE_PRIORITY: z.string().optional(),
}).catchall(z.string().optional())

export type BuildCredentials = z.infer<typeof buildCredentialsSchema>

// ============================================================================
// Build Request Options Schema
// ============================================================================

export const buildRequestOptionsSchema = optionsBaseSchema.extend({
  path: z.string().optional(),
  nodeModules: z.string().optional(),
  platform: z.enum(['ios', 'android']).optional(),
  buildMode: z.enum(['debug', 'release']).optional(),
  userId: z.string().optional(),
  buildCertificateBase64: z.string().optional(),
  p12Password: z.string().optional(),
  appleKeyId: z.string().optional(),
  appleIssuerId: z.string().optional(),
  appleKeyContent: z.string().optional(),
  appStoreConnectTeamId: z.string().optional(),
  appleId: z.string().optional(),
  appleAppSpecificPassword: z.string().optional(),
  appleAppId: z.string().optional(),
  iosScheme: z.string().optional(),
  iosTarget: z.string().optional(),
  iosDistribution: z.enum(['app_store', 'ad_hoc']).optional(),
  iosProvisioningProfile: z.array(z.string()).optional(),
  iosProvisioningMap: z.string().optional(),
  androidKeystoreFile: z.string().optional(),
  keystoreKeyAlias: z.string().optional(),
  keystoreKeyPassword: z.string().optional(),
  keystoreStorePassword: z.string().optional(),
  playConfigJson: z.string().optional(),
  androidFlavor: z.string().min(1).optional(),
  inAppUpdatePriority: inAppUpdatePrioritySchema.optional(),
  storeReleaseNotesLocale: z.array(z.string().min(1)).optional(),
  iosAutomaticRelease: z.boolean().optional(),
  outputUpload: z.boolean().optional(),
  outputRetention: z.string().optional(),
  outputRecord: z.string().optional(),
  skipBuildNumberBump: z.boolean().optional(),
  skipMarketingVersionBump: z.boolean().optional(),
  syncIosVersion: z.boolean().optional(),
  playstoreUpload: z.boolean().optional(),
  submitToStoreReview: z.boolean().optional(),
  storeReleaseName: z.string().min(1).optional(),
  storeReleaseNotes: z.string().min(1).optional(),
  storeReleaseNotesLocalized: localizedReleaseNotesSchema.optional(),
  iosTestflightGroups: z.string().min(1).optional(),
  verbose: z.boolean().optional(),
  aiAnalytics: z.boolean().optional(),
  sendLogsToSupport: z.boolean().optional(),
  sendLogs: z.boolean().optional(),
  aiAnalysisMode: z.enum(['auto-prompt', 'caller-handled', 'skip']).optional(),
  prescan: z.boolean().optional(),
  prescanIgnoreFatal: z.boolean().optional(),
  failOnWarnings: z.boolean().optional(),
  builderJourneyId: z.string().optional(),
})

export type BuildRequestOptions = z.infer<typeof buildRequestOptionsSchema>

export const buildNeededOptionsSchema = optionsBaseSchema.extend({
  channel: z.string().optional(),
  packageJson: z.string().optional(),
  nodeModules: z.string().optional(),
  verbose: z.boolean().optional(),
})

export type BuildNeededOptions = z.infer<typeof buildNeededOptionsSchema>

// ============================================================================
// Build Response Schemas
// ============================================================================

export const buildRequestResultSchema = z.object({
  success: z.boolean(),
  jobId: z.string().optional(),
  uploadUrl: z.string().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
  aiAnalysis: z.object({
    jobId: z.string(),
    capturedLogPath: z.string(),
    ready: z.boolean(),
  }).optional(),
})

export type BuildRequestResult = z.infer<typeof buildRequestResultSchema>

// ============================================================================
// Build Options Payload Schema (sent to server as buildOptions)
// ============================================================================

export const buildOptionsPayloadSchema = z.object({
  platform: z.enum(['ios', 'android']),
  buildMode: z.enum(['debug', 'release']),
  cliVersion: z.string(),
  iosScheme: z.string().optional(),
  iosTarget: z.string().optional(),
  iosDistribution: z.enum(['app_store', 'ad_hoc']).optional(),
  iosSourceDir: z.string().optional(),
  iosAppDir: z.string().optional(),
  iosProjectDir: z.string().optional(),
  storeReleaseNotesLocalized: localizedReleaseNotesSchema.optional(),
  iosAutomaticRelease: z.boolean().optional(),
  androidSourceDir: z.string().optional(),
  androidAppDir: z.string().optional(),
  androidProjectDir: z.string().optional(),
  androidFlavor: z.string().min(1).optional(),
  outputUploadEnabled: z.boolean(),
  outputRetentionSeconds: z.number(),
  skipBuildNumberBump: z.boolean(),
  skipMarketingVersionBump: z.boolean(),
  submitToStoreReview: z.boolean(),
  storeReleaseName: z.string().optional(),
  storeReleaseNotes: z.string().optional(),
  iosTestflightGroups: z.string().optional(),
})

export type BuildOptionsPayload = z.infer<typeof buildOptionsPayloadSchema>

// ============================================================================
// Credential File Schemas
// ============================================================================

export const credentialFileSchema = z.object({
  BUILD_CERTIFICATE_FILE: z.string().optional(),
  APPLE_KEY_FILE: z.string().optional(),
  ANDROID_KEYSTORE_PATH: z.string().optional(),
  PLAY_CONFIG_JSON_PATH: z.string().optional(),
})

export type CredentialFile = z.infer<typeof credentialFileSchema>

export const savedCredentialsSchema = z.object({
  ios: buildCredentialsSchema.partial().optional(),
  android: buildCredentialsSchema.partial().optional(),
})

export type SavedCredentials = z.infer<typeof savedCredentialsSchema>

export const allCredentialsSchema = z.record(z.string(), savedCredentialsSchema)

export type AllCredentials = z.infer<typeof allCredentialsSchema>
