import type { Channel } from './api/channels'
import type { BuildRequestOptions as InternalBuildRequestOptions } from './build/request'
import type { DecryptResult } from './bundle/decrypt'
import type { EncryptResult } from './bundle/encrypt'
import type { ZipResult } from './bundle/zip'
import type { StarAllRepositoryResult } from './github'
import type { ProbeInternalResult } from './probe'
import type { AppOptions } from './schemas/app'
import type { OptionsUpload } from './schemas/bundle'
import type { OptionsSetChannel } from './schemas/channel'
import type {
  AccountIdOptions,
  AddAppOptions,
  AddChannelOptions,
  AddOrganizationOptions,
  AppInfo,
  BundleCompatibilityOptions,
  BundleInfo,
  CleanupOptions,
  CurrentBundleOptions,
  DecryptBundleOptions,
  DeleteOldKeyOptions,
  DeleteOrganizationOptions,
  DeviceStats,
  DoctorOptions,
  EncryptBundleOptions,
  GenerateKeyOptions,
  GetStatsOptions,
  ListOrganizationsOptions,
  LoginOptions,
  OrganizationInfo,
  ProbeOptions,
  RequestBuildOptions,
  SaveKeyOptions,
  SDKResult,
  SetSettingOptions,
  StarAllRepositoriesOptions,
  StarRepoOptions,
  UpdateAppOptions,
  UpdateChannelOptions,
  UpdateOrganizationOptions,
  UploadOptions,
  UploadResult,
  ZipBundleOptions,
} from './schemas/sdk'
import type { Organization } from './utils'
import { checkAppExistsAndHasPermissionOrgErr } from './api/app'
import { getActiveAppVersions } from './api/versions'
import { addAppInternal } from './app/add'
import { deleteAppInternal } from './app/delete'
import { getInfoInternal } from './app/info'
import { listAppInternal } from './app/list'
import { setAppInternal } from './app/set'
import { setSettingInternal } from './app/setting'
import { parseStoreReleaseNotesLocalizedJson, requestBuildInternal } from './build/request'
import { cleanupBundleInternal } from './bundle/cleanup'
import { checkCompatibilityInternal } from './bundle/compatibility'
import { decryptZipInternal } from './bundle/decrypt'
import { deleteBundleInternal } from './bundle/delete'
import { encryptZipInternal } from './bundle/encrypt'
import { uploadBundleInternal } from './bundle/upload'
import { zipBundleInternal } from './bundle/zip'
import { addChannelInternal } from './channel/add'
import { currentBundleInternal } from './channel/currentBundle'
import { deleteChannelInternal } from './channel/delete'
import { listChannelsInternal } from './channel/list'
import { setChannelInternal } from './channel/set'
import { resolveCapacitorConfigTargetPath, withConfigWriteTarget } from './config'
import { starAllRepositories as starAllRepositoriesInternal, starRepository } from './github'
import { createKeyInternal, deleteOldPrivateKeyInternal, saveKeyInternal } from './key'
import { loginInternal } from './login'
import { addOrganizationInternal } from './organization/add'
import { deleteOrganizationInternal } from './organization/delete'
import { listOrganizationsInternal } from './organization/list'
import { setOrganizationInternal } from './organization/set'
import { getUserIdInternal } from './user/account'
import { createSupabaseClient, findSavedKey, getConfig, getLocalConfig } from './utils'
import { parseSecurityPolicyError } from './utils/security_policy_errors'

export type DoctorInfo = Awaited<ReturnType<typeof getInfoInternal>>
type CompatibilityReport = Awaited<ReturnType<typeof checkCompatibilityInternal>>['finalCompatibility']
export type BundleCompatibilityEntry = CompatibilityReport[number]

// ============================================================================
// Re-export all SDK types from schemas
// ============================================================================

export type { UpdateProbeResult } from './app/updateProbe'

/**
 * Create an SDK error result from an error, with security policy awareness.
 * This parses the error to check if it's a security policy error and provides
 * human-readable messages for 2FA, password policy, and API key requirements.
 */
function createErrorResult<T = void>(error: unknown): SDKResult<T> {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const parsed = parseSecurityPolicyError(error)

  return {
    success: false,
    error: errorMessage,
    isSecurityPolicyError: parsed.isSecurityPolicyError,
    securityPolicyMessage: parsed.isSecurityPolicyError ? parsed.message : undefined,
  }
}

/**
 * Runs config-writing SDK methods against an app-specific source while Capacitor
 * continues to load the active root config in dynamic monorepos.
 */
async function withCapacitorConfigTarget<T>(capacitorConfig: string | undefined, action: () => Promise<T>): Promise<T> {
  if (capacitorConfig === undefined)
    return action()

  return withConfigWriteTarget(resolveCapacitorConfigTargetPath(capacitorConfig), action)
}

// ============================================================================
// SDK Class - Main Entry Point
// ============================================================================

/**
 * Capgo SDK for programmatic access to all CLI functionality.
 * Use this class to integrate Capgo operations directly into your application.
 * Config-writing methods accept `capacitorConfig` to target an app-specific
 * source config in a dynamic monorepo.
 *
 * @example
 * ```typescript
 * // Initialize SDK
 * const sdk = new CapgoSDK({ apikey: 'your-api-key' })
 *
 * // Upload a bundle
 * const result = await sdk.uploadBundle({
 *   appId: 'com.example.app',
 *   path: './dist',
 *   bundle: '1.0.0',
 *   channel: 'production'
 * })
 *
 * if (result.success) {
 *   console.log('Upload successful!')
 * }
 * ```
 */
export class CapgoSDK {
  private readonly apikey?: string
  private readonly supaHost?: string
  private readonly supaAnon?: string

  constructor(options?: {
    apikey?: string
    supaHost?: string
    supaAnon?: string
  }) {
    this.apikey = options?.apikey
    this.supaHost = options?.supaHost
    this.supaAnon = options?.supaAnon
  }

  // ==========================================================================
  // App Management Methods
  // ==========================================================================

  /**
   * Save an API key locally or in the home directory
   */
  async login(options: LoginOptions): Promise<SDKResult> {
    try {
      await loginInternal(options.apikey, {
        local: options.local ?? false,
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
      }, true)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Run Capgo Doctor diagnostics and return the report
   */
  async doctor(options?: DoctorOptions): Promise<SDKResult<DoctorInfo>> {
    try {
      const info = await getInfoInternal({ packageJson: options?.packageJson }, true)

      return {
        success: true,
        data: info,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Add a new app to Capgo Cloud
   *
   * @example
   * ```typescript
   * const result = await sdk.addApp({
   *   appId: 'com.example.app',
   *   name: 'My App',
   *   icon: './icon.png'
   * })
   * ```
   */
  async addApp(options: AddAppOptions): Promise<SDKResult> {
    try {
      const internalOptions: AppOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        name: options.name,
        icon: options.icon,
      }

      await addAppInternal(options.appId, internalOptions, undefined, true)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Update an existing app in Capgo Cloud
   *
   * Note: This method requires CLI function refactoring to work without exit().
   * Currently it will throw an error.
   *
   * @example
   * ```typescript
   * const result = await sdk.updateApp({
   *   appId: 'com.example.app',
   *   name: 'Updated App Name',
   *   retention: 30
   * })
   * ```
   */
  async updateApp(options: UpdateAppOptions): Promise<SDKResult> {
    try {
      const internalOptions: AppOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        name: options.name,
        icon: options.icon,
        retention: options.retention,
      }

      await setAppInternal(options.appId, internalOptions, true)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Delete an app from Capgo Cloud
   *
   * @param appId - The app ID to delete
   * @param skipConfirmation - Skip owner confirmation check (use with caution)
   *
   * @example
   * ```typescript
   * const result = await sdk.deleteApp('com.example.app')
   * ```
   */
  async deleteApp(appId: string, skipConfirmation = false): Promise<SDKResult> {
    try {
      const internalOptions = {
        apikey: this.apikey || findSavedKey(true),
        supaHost: this.supaHost,
        supaAnon: this.supaAnon,
      }

      await deleteAppInternal(appId, internalOptions, false, skipConfirmation)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * List all apps for the authenticated account
   *
   * @example
   * ```typescript
   * const result = await sdk.listApps()
   * if (result.success) {
   *   result.data?.forEach(app => {
   *     console.log(`${app.name} (${app.appId})`)
   *   })
   * }
   * ```
   */
  async listApps(): Promise<SDKResult<AppInfo[]>> {
    try {
      const internalOptions = {
        apikey: this.apikey || findSavedKey(true),
        supaHost: this.supaHost,
        supaAnon: this.supaAnon,
      }

      // silent=true: the SDK is a programmatic API and (via the MCP server) runs over
      // a stdio JSON-RPC channel — clack `intro`/`log` output on stdout corrupts the
      // protocol framing and drops the transport. Every other SDK method is silent too.
      const apps = await listAppInternal(internalOptions, true)

      const appInfos: AppInfo[] = apps.map(app => ({
        appId: app.app_id,
        name: app.name || 'Unknown',
        iconUrl: app.icon_url || undefined,
        createdAt: new Date(app.created_at || ''),
      }))

      return {
        success: true,
        data: appInfos,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Whether `appId` exists in Capgo Cloud AND the configured key has at least read
   * access to it. Uses the TARGETED existence+permission check (the same one
   * `app set` / `channel` / `bundle` use) — NOT listApps — so it never triggers the
   * full-table RBAC RLS scan that times out on large databases and falsely reports an
   * owned app as missing. Returns false for a missing app or one the key can't access.
   */
  async appHasAccess(appId: string): Promise<SDKResult<boolean>> {
    try {
      const apikey = this.apikey || findSavedKey(true)
      if (!apikey)
        return { success: true, data: false }
      const supabase = await createSupabaseClient(apikey, this.supaHost, this.supaAnon)
      // silent: no UI output (this runs over a stdio MCP channel). skip2FACheck: this
      // is a read-only "is it registered" probe — the real credential ops enforce 2FA.
      await checkAppExistsAndHasPermissionOrgErr(supabase, apikey, appId, 'app.read', true, true)
      return { success: true, data: true }
    }
    catch {
      return { success: true, data: false }
    }
  }

  /**
   * Retrieve the account ID associated with the configured API key
   */
  async getAccountId(options?: AccountIdOptions): Promise<SDKResult<string>> {
    try {
      const resolvedOptions = {
        apikey: options?.apikey || this.apikey || findSavedKey(true),
        supaHost: options?.supaHost || this.supaHost,
        supaAnon: options?.supaAnon || this.supaAnon,
      }

      const userId = await getUserIdInternal(resolvedOptions, true)

      return {
        success: true,
        data: userId,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Star the Capgo repository on GitHub
   *
   * @example
   * ```typescript
   * const result = await sdk.starRepo({ repository: 'Cap-go/capacitor-updater' })
   * if (result.success) {
   *   console.log(`${result.data?.repository} starred`)
   * }
   * ```
   */
  async starRepo(options?: StarRepoOptions): Promise<SDKResult<{ repository: string, alreadyStarred: boolean }>> {
    try {
      const { repository, alreadyStarred } = starRepository(options?.repository)
      return {
        success: true,
        data: { repository, alreadyStarred },
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Star the Capgo-related repositories on GitHub
   *
   * @example
   * ```typescript
   * const result = await sdk.starAllRepositories()
   * if (result.success) {
   *   for (const entry of result.data ?? []) {
   *     console.log(entry.repository, entry.status)
   *   }
   * }
   * ```
   */
  async starAllRepositories(options?: StarAllRepositoriesOptions): Promise<SDKResult<StarAllRepositoryResult[]>> {
    try {
      const data = await starAllRepositoriesInternal(options)
      return {
        success: true,
        data,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  // ==========================================================================
  // Bundle Management Methods
  // ==========================================================================

  async checkBundleCompatibility(options: BundleCompatibilityOptions): Promise<SDKResult<BundleCompatibilityEntry[]>> {
    try {
      const requestOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        channel: options.channel,
        text: options.textOutput ?? false,
        packageJson: options.packageJson,
        nodeModules: options.nodeModules,
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
      }

      const compatibility = await checkCompatibilityInternal(options.appId, requestOptions, true)

      return {
        success: true,
        data: compatibility.finalCompatibility,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  async encryptBundle(options: EncryptBundleOptions): Promise<SDKResult<EncryptResult>> {
    try {
      const result = await encryptZipInternal(options.zipPath, options.checksum, {
        key: options.keyPath,
        keyData: options.keyData,
        json: options.json,
        packageJson: options.packageJson,
      }, true)

      return {
        success: true,
        data: result,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  async decryptBundle(options: DecryptBundleOptions): Promise<SDKResult<DecryptResult>> {
    try {
      const result = await decryptZipInternal(options.zipPath, options.ivSessionKey, {
        key: options.keyPath,
        keyData: options.keyData,
        checksum: options.checksum,
        packageJson: options.packageJson,
      }, true)

      return {
        success: true,
        data: result,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  async zipBundle(options: ZipBundleOptions): Promise<SDKResult<ZipResult>> {
    try {
      const result = await zipBundleInternal(options.appId, {
        apikey: this.apikey || findSavedKey(true),
        path: options.path,
        bundle: options.bundle,
        name: options.name,
        codeCheck: options.codeCheck,
        json: options.json,
        keyV2: options.keyV2,
        packageJson: options.packageJson,
      }, true)

      return {
        success: true,
        data: result,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Upload a bundle to Capgo Cloud
   *
   * @example
   * ```typescript
   * const result = await sdk.uploadBundle({
   *   appId: 'com.example.app',
   *   path: './dist',
   *   bundle: '1.0.0',
   *   channel: 'production',
   *   comment: 'New features added'
   * })
   * ```
   */
  async uploadBundle(options: UploadOptions): Promise<UploadResult> {
    try {
      return await withCapacitorConfigTarget(options.capacitorConfig, async () => {
        // Convert SDK options to internal format
        const internalOptions: OptionsUpload = {
          apikey: options.apikey || this.apikey || findSavedKey(true),
          supaHost: options.supaHost || this.supaHost,
          supaAnon: options.supaAnon || this.supaAnon,
          path: options.path,
          bundle: options.bundle,
          channel: options.channel,
          rollout: options.rollout,
          rolloutPercentageBps: options.rolloutPercentageBps,
          rolloutCacheTtlSeconds: options.rolloutCacheTtlSeconds,
          external: options.external,
          key: options.encrypt !== false, // default true unless explicitly false
          keyV2: options.encryptionKey,
          timeout: options.timeout,
          tus: options.useTus,
          comment: options.comment,
          minUpdateVersion: options.minUpdateVersion,
          autoMinUpdateVersion: options.autoMinUpdateVersion,
          autoSetBundle: options.autoSetBundle,
          selfAssign: options.selfAssign,
          packageJson: options.packageJsonPaths,
          ignoreMetadataCheck: options.ignoreCompatibilityCheck,
          codeCheck: !options.disableCodeCheck, // disable if requested, otherwise check
          zip: options.useZip, // use legacy zip upload if requested
        }

        // Call internal upload function but suppress CLI behaviors
        const uploadResponse = await uploadBundleInternal(options.appId, internalOptions, true)

        return {
          success: uploadResponse.success,
          bundleId: uploadResponse.bundle,
          checksum: uploadResponse.checksum ?? null,
          encryptionMethod: uploadResponse.encryptionMethod,
          sessionKey: uploadResponse.sessionKey,
          ivSessionKey: uploadResponse.ivSessionKey,
          storageProvider: uploadResponse.storageProvider,
          skipped: uploadResponse.skipped,
          reason: uploadResponse.reason,
        }
      })
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * List bundles for an app
   *
   * @example
   * ```typescript
   * const result = await sdk.listBundles('com.example.app')
   * if (result.success) {
   *   result.data?.forEach(bundle => {
   *     console.log(`${bundle.version} - ${bundle.uploadedAt}`)
   *   })
   * }
   * ```
   */
  async listBundles(appId: string): Promise<SDKResult<BundleInfo[]>> {
    try {
      const apikey = this.apikey || findSavedKey(true)
      const supabase = await createSupabaseClient(apikey, this.supaHost, this.supaAnon)

      const versions = await getActiveAppVersions(supabase, appId)

      const bundles: BundleInfo[] = versions.map(bundle => ({
        id: bundle.id.toString(),
        version: bundle.name,
        uploadedAt: new Date(bundle.created_at || ''),
        size: 0, // Size not available in current schema
        encrypted: bundle.session_key !== null,
      }))

      return {
        success: true,
        data: bundles,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Delete a specific bundle
   *
   * Note: This method requires CLI function refactoring to work without exit().
   *
   * @example
   * ```typescript
   * const result = await sdk.deleteBundle('com.example.app', '1.0.0')
   * ```
   */
  async deleteBundle(appId: string, bundleId: string): Promise<SDKResult> {
    try {
      const internalOptions = {
        apikey: this.apikey || findSavedKey(true),
        supaHost: this.supaHost,
        supaAnon: this.supaAnon,
        bundle: bundleId,
      }

      await deleteBundleInternal(bundleId, appId, internalOptions, true)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Cleanup old bundles, keeping only recent versions
   *
   * @example
   * ```typescript
   * const result = await sdk.cleanupBundles({
   *   appId: 'com.example.app',
   *   keep: 5,
   *   force: true
   * })
   * ```
   */
  async cleanupBundles(options: CleanupOptions): Promise<SDKResult<{ removed: number, kept: number }>> {
    try {
      const internalOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        bundle: options.bundle || '',
        version: '',
        keep: options.keep || 4,
        force: options.force || false,
        ignoreChannel: options.ignoreChannel || false,
      }

      const result = await cleanupBundleInternal(options.appId, internalOptions, true)

      return {
        success: true,
        data: result,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Request a native build for your app with store publishing
   *
   * SECURITY GUARANTEE:
   * Credentials provided to this method are NEVER stored on Capgo servers.
   * They are used only during the build process and automatically deleted
   * after completion (maximum 24 hours retention). Build outputs may optionally
   * be uploaded for time-limited download links.
   *
   * @example
   * ```typescript
   * const result = await sdk.requestBuild({
   *   appId: 'com.example.app',
   *   path: './my-project',
   *   lane: 'ios', // Must be exactly "ios" or "android"
   *   credentials: {
   *     BUILD_CERTIFICATE_BASE64: 'base64-cert...',
   *     CAPGO_IOS_PROVISIONING_MAP: '{"com.example.app":{"profile":"base64...","name":"match AppStore com.example.app"}}',
   *     P12_PASSWORD: 'cert-password',
   *     APPLE_KEY_ID: 'KEY123',
   *     APPLE_ISSUER_ID: 'issuer-uuid',
   *     APPLE_KEY_CONTENT: 'base64-p8...',
   *     APP_STORE_CONNECT_TEAM_ID: 'team-id'
   *   }
   * })
   *
   * if (result.success) {
   *   console.log('Job ID:', result.data.jobId)
   * }
   * ```
   */
  async requestBuild(options: RequestBuildOptions): Promise<SDKResult<{ jobId: string, uploadUrl: string, status: string }>> {
    try {
      // Convert BuildCredentials object to flattened CLI-compatible format
      const creds = options.credentials
      const internalOptions: InternalBuildRequestOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        path: options.path,
        nodeModules: options.nodeModules,
        platform: options.platform,
        userId: options.userId,
        // Flatten BuildCredentials to individual fields
        buildCertificateBase64: creds?.BUILD_CERTIFICATE_BASE64,
        p12Password: creds?.P12_PASSWORD,
        appleKeyId: creds?.APPLE_KEY_ID,
        appleIssuerId: creds?.APPLE_ISSUER_ID,
        appleKeyContent: creds?.APPLE_KEY_CONTENT,
        appStoreConnectTeamId: creds?.APP_STORE_CONNECT_TEAM_ID,
        appleId: creds?.FASTLANE_USER,
        appleAppSpecificPassword: creds?.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD,
        appleAppId: creds?.APPLE_APP_ID,
        iosScheme: creds?.CAPGO_IOS_SCHEME,
        iosTarget: creds?.CAPGO_IOS_TARGET,
        iosDistribution: creds?.CAPGO_IOS_DISTRIBUTION as 'app_store' | 'ad_hoc' | undefined,
        iosProvisioningMap: creds?.CAPGO_IOS_PROVISIONING_MAP,
        androidKeystoreFile: creds?.ANDROID_KEYSTORE_FILE,
        keystoreKeyAlias: creds?.KEYSTORE_KEY_ALIAS,
        keystoreKeyPassword: creds?.KEYSTORE_KEY_PASSWORD,
        keystoreStorePassword: creds?.KEYSTORE_STORE_PASSWORD,
        playConfigJson: creds?.PLAY_CONFIG_JSON,
        submitToStoreReview: options.submitToStoreReview ?? (creds?.CAPGO_STORE_SUBMIT_REVIEW === undefined ? undefined : creds.CAPGO_STORE_SUBMIT_REVIEW === 'true'),
        storeReleaseName: options.storeReleaseName ?? creds?.CAPGO_STORE_RELEASE_NAME,
        storeReleaseNotes: options.storeReleaseNotes ?? creds?.CAPGO_STORE_RELEASE_NOTES,
        storeReleaseNotesLocalized: options.storeReleaseNotesLocalized ?? parseStoreReleaseNotesLocalizedJson(creds?.CAPGO_STORE_RELEASE_NOTES_LOCALIZED),
        iosTestflightGroups: options.iosTestflightGroups ?? creds?.CAPGO_IOS_TESTFLIGHT_GROUPS,
        iosAutomaticRelease: options.iosAutomaticRelease ?? (creds?.CAPGO_IOS_AUTOMATIC_RELEASE === undefined ? undefined : creds.CAPGO_IOS_AUTOMATIC_RELEASE === 'true'),
        // Prescan escape hatch: SDK callers own their output channel and cannot
        // pass CLI flags, so expose the gate controls directly.
        prescan: options.prescan,
        prescanIgnoreFatal: options.prescanIgnoreFatal,
      }

      const result = await requestBuildInternal(options.appId, internalOptions, true)

      if (result.success && result.jobId) {
        return {
          success: true,
          data: {
            jobId: result.jobId,
            uploadUrl: result.uploadUrl || '',
            status: result.status || 'unknown',
          },
        }
      }

      return {
        success: false,
        error: result.error || 'Unknown error during build request',
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  // ==========================================================================
  // Channel Management Methods
  // ==========================================================================

  async getCurrentBundle(appId: string, channelId: string, options?: CurrentBundleOptions): Promise<SDKResult<string>> {
    try {
      const requestOptions = {
        apikey: options?.apikey || this.apikey || findSavedKey(true),
        quiet: true,
        supaHost: options?.supaHost || this.supaHost,
        supaAnon: options?.supaAnon || this.supaAnon,
      }

      const bundle = await currentBundleInternal(channelId, appId, requestOptions as any, true)

      return {
        success: true,
        data: bundle,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Create a new channel for app distribution
   *
   * @example
   * ```typescript
   * const result = await sdk.addChannel({
   *   channelId: 'production',
   *   appId: 'com.example.app',
   *   default: true
   * })
   * ```
   */
  async addChannel(options: AddChannelOptions): Promise<SDKResult> {
    try {
      const internalOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        default: options.default,
        selfAssign: options.selfAssign,
      }

      await addChannelInternal(options.channelId, options.appId, internalOptions, true)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Update channel settings
   *
   * @example
   * ```typescript
   * const result = await sdk.updateChannel({
   *   channelId: 'production',
   *   appId: 'com.example.app',
   *   bundle: '1.0.0'
   * })
   * ```
   */
  async updateChannel(options: UpdateChannelOptions): Promise<SDKResult> {
    try {
      const internalOptions: OptionsSetChannel = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        bundle: options.bundle ?? undefined,
        state: options.state,
        downgrade: options.downgrade,
        ios: options.ios,
        android: options.android,
        selfAssign: options.selfAssign,
        disableAutoUpdate: options.disableAutoUpdate ?? undefined,
        dev: options.dev,
        emulator: options.emulator,
        device: options.device,
        prod: options.prod,
        rolloutBundle: options.rolloutBundle,
        rolloutPercentage: options.rolloutPercentage,
        rolloutPercentageBps: options.rolloutPercentageBps,
        rolloutEnable: options.rolloutEnable,
        rolloutDisable: options.rolloutDisable,
        rolloutPause: options.rolloutPause,
        rolloutResume: options.rolloutResume,
        rolloutRollback: options.rolloutRollback,
        rolloutPromote: options.rolloutPromote,
        rolloutCacheTtlSeconds: options.rolloutCacheTtlSeconds,
        autoPauseEnabled: options.autoPauseEnabled,
        autoPauseDisabled: options.autoPauseDisabled,
        autoPauseWindowMinutes: options.autoPauseWindowMinutes,
        autoPauseFailureRateBps: options.autoPauseFailureRateBps,
        autoPauseConfidence: options.autoPauseConfidence,
        autoPauseMinAttempts: options.autoPauseMinAttempts,
        autoPauseMinFailures: options.autoPauseMinFailures,
        autoPauseAction: options.autoPauseAction,
        autoPauseCooldownMinutes: options.autoPauseCooldownMinutes,
        latest: false,
        latestRemote: false,
        packageJson: undefined,
        ignoreMetadataCheck: false,
      }

      await setChannelInternal(options.channelId, options.appId, internalOptions, true)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Delete a channel
   *
   * @example
   * ```typescript
   * const result = await sdk.deleteChannel('staging', 'com.example.app')
   * ```
   */
  async deleteChannel(channelId: string, appId: string, deleteBundle = false): Promise<SDKResult> {
    try {
      const internalOptions = {
        apikey: this.apikey || findSavedKey(true),
        supaHost: this.supaHost,
        supaAnon: this.supaAnon,
        deleteBundle,
        successIfNotFound: false,
      }

      await deleteChannelInternal(channelId, appId, internalOptions, true)

      return { success: true }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * List all channels for an app
   *
   * @example
   * ```typescript
   * const result = await sdk.listChannels('com.example.app')
   * if (result.success) {
   *   result.data?.forEach(channel => {
   *     console.log(`${channel.name} - ${channel.isDefault ? 'default' : 'normal'}`)
   *   })
   * }
   * ```
   */
  async listChannels(appId: string): Promise<SDKResult<Channel[]>> {
    try {
      const internalOptions = {
        apikey: this.apikey || findSavedKey(true),
        supaHost: this.supaHost,
        supaAnon: this.supaAnon,
      }

      const channels = await listChannelsInternal(appId, internalOptions, true)

      return {
        success: true,
        data: channels,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  // ==========================================================================
  // Organization Management Methods
  // ==========================================================================

  /**
   * Generate Capgo encryption keys (private/public pair)
   */
  async generateEncryptionKeys(options?: GenerateKeyOptions): Promise<SDKResult> {
    try {
      return await withCapacitorConfigTarget(options?.capacitorConfig, async () => {
        await createKeyInternal({
          force: options?.force,
          setupChannel: options?.setupChannel,
        }, true)

        return { success: true }
      })
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Save a public encryption key into the Capacitor config
   */
  async saveEncryptionKey(options?: SaveKeyOptions): Promise<SDKResult> {
    try {
      return await withCapacitorConfigTarget(options?.capacitorConfig, async () => {
        await saveKeyInternal({
          key: options?.keyPath,
          keyData: options?.keyData,
          setupChannel: options?.setupChannel,
        }, true)

        return { success: true }
      })
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  /**
   * Delete legacy (v1) encryption keys from the project
   */
  async deleteLegacyEncryptionKey(options?: DeleteOldKeyOptions): Promise<SDKResult<{ deleted: boolean }>> {
    try {
      return await withCapacitorConfigTarget(options?.capacitorConfig, async () => {
        const deleted = await deleteOldPrivateKeyInternal({
          force: options?.force,
          setupChannel: options?.setupChannel,
        }, true)

        return {
          success: true,
          data: { deleted },
        }
      })
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  async listOrganizations(options?: ListOrganizationsOptions): Promise<SDKResult<OrganizationInfo[]>> {
    try {
      const requestOptions = {
        apikey: options?.apikey || this.apikey || findSavedKey(true),
        supaHost: options?.supaHost || this.supaHost,
        supaAnon: options?.supaAnon || this.supaAnon,
      }

      const organizations = await listOrganizationsInternal(requestOptions, true)

      const data: OrganizationInfo[] = organizations.map((org: Organization) => ({
        id: String((org as any).id ?? (org as any).gid ?? ''),
        name: (org as any).name ?? 'Unknown',
        role: (org as any).role ?? undefined,
        appCount: typeof (org as any).app_count === 'number' ? (org as any).app_count : undefined,
        email: (org as any).management_email ?? undefined,
        createdAt: (org as any).created_at ? new Date((org as any).created_at) : undefined,
      }))

      return {
        success: true,
        data,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  async addOrganization(options: AddOrganizationOptions): Promise<SDKResult<OrganizationInfo>> {
    try {
      const requestOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        name: options.name,
        email: options.email,
      }

      const org = await addOrganizationInternal(requestOptions, true)

      const info: OrganizationInfo = {
        id: String((org as any).id ?? (org as any).gid ?? ''),
        name: (org as any).name ?? options.name,
        role: 'owner',
        appCount: 0,
        email: (org as any).management_email ?? options.email,
        createdAt: (org as any).created_at ? new Date((org as any).created_at) : undefined,
      }

      return {
        success: true,
        data: info,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  async updateOrganization(options: UpdateOrganizationOptions): Promise<SDKResult<OrganizationInfo>> {
    try {
      const requestOptions = {
        apikey: options.apikey || this.apikey || findSavedKey(true),
        supaHost: options.supaHost || this.supaHost,
        supaAnon: options.supaAnon || this.supaAnon,
        name: options.name,
        email: options.email,
      }

      const updated = await setOrganizationInternal(options.orgId, requestOptions, true)

      const info: OrganizationInfo = {
        id: updated.orgId,
        name: updated.name,
        email: updated.email,
      }

      return {
        success: true,
        data: info,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  async deleteOrganization(orgId: string, options?: DeleteOrganizationOptions): Promise<SDKResult<{ deleted: boolean }>> {
    try {
      const requestOptions = {
        apikey: options?.apikey || this.apikey || findSavedKey(true),
        supaHost: options?.supaHost || this.supaHost,
        supaAnon: options?.supaAnon || this.supaAnon,
        autoConfirm: options?.autoConfirm ?? true,
      }

      const deleted = await deleteOrganizationInternal(orgId, requestOptions, true)

      return {
        success: true,
        data: { deleted },
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  // ==========================================================================
  // Device Stats & Debugging
  // ==========================================================================

  /**
   * Get device statistics/logs from Capgo backend
   *
   * This method works similarly to waitLog, allowing you to poll for device activity.
   * Use the `after` parameter to get only new stats since a previous call.
   *
   * @example
   * ```typescript
   * // Get recent stats for an app
   * const result = await sdk.getStats({
   *   appId: 'com.example.app',
   *   rangeStart: new Date().toISOString(),
   *   limit: 100
   * })
   *
   * if (result.success && result.data) {
   *   result.data.forEach(stat => {
   *     console.log(`${stat.deviceId}: ${stat.action}`)
   *   })
   * }
   *
   * // Poll for new stats (similar to waitLog)
   * let after = new Date().toISOString()
   * const poll = async () => {
   *   const result = await sdk.getStats({
   *     appId: 'com.example.app',
   *     after
   *   })
   *
   *   if (result.success && result.data && result.data.length > 0) {
   *     // Update 'after' to newest timestamp
   *     const newest = result.data.reduce((max, d) => {
   *       const t = new Date(d.createdAt).getTime()
   *       return Math.max(max, t)
   *     }, new Date(after).getTime())
   *     after = new Date(newest).toISOString()
   *
   *     // Process new stats
   *     result.data.forEach(stat => console.log(stat))
   *   }
   * }
   * ```
   */
  async getStats(options: GetStatsOptions): Promise<SDKResult<DeviceStats[]>> {
    try {
      const apikey = options.apikey || this.apikey || findSavedKey(true)
      const localConfig = await getLocalConfig()

      const query = {
        appId: options.appId,
        devicesId: options.deviceIds,
        search: options.search,
        order: options.order,
        rangeStart: options.after || options.rangeStart,
        rangeEnd: options.rangeEnd,
        limit: options.limit,
      }

      const response = await fetch(`${localConfig.hostApi}/private/stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'capgkey': apikey,
        },
        body: JSON.stringify(query),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json() as Array<{
        app_id: string
        device_id: string
        action: string
        version_id: number
        version?: number
        created_at: string
      }>

      const stats: DeviceStats[] = data.map(d => ({
        appId: d.app_id,
        deviceId: d.device_id,
        action: d.action,
        versionId: d.version_id,
        version: d.version,
        createdAt: d.created_at,
      }))

      return {
        success: true,
        data: stats,
      }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  // ==========================================================================
  // Miscellaneous Helpers
  // ==========================================================================

  async setAppSetting(path: string, options: SetSettingOptions): Promise<SDKResult> {
    try {
      return await withCapacitorConfigTarget(options.capacitorConfig, async () => {
        await setSettingInternal(path, {
          apikey: options.apikey || this.apikey || findSavedKey(true),
          bool: options.bool,
          string: options.string,
        }, true)

        return { success: true }
      })
    }
    catch (error) {
      return createErrorResult(error)
    }
  }

  // ==========================================================================
  // Probe (no auth required - hits public /updates endpoint)
  // ==========================================================================

  async probe(options: ProbeOptions): Promise<SDKResult<ProbeInternalResult>> {
    try {
      const { probeInternal } = await import('./probe')
      const result = await probeInternal({ platform: options.platform })
      if (result.error) {
        return { success: false, error: result.error }
      }
      return { success: true, data: result }
    }
    catch (error) {
      return createErrorResult(error)
    }
  }
}

// ============================================================================
// Functional API - Convenience Wrappers
// ============================================================================

/**
 * Upload a bundle to Capgo Cloud (functional API)
 *
 * @example
 * ```typescript
 * const result = await uploadBundle({
 *   appId: 'com.example.app',
 *   path: './dist',
 *   bundle: '1.0.0',
 *   apikey: 'your-api-key'
 * })
 * ```
 */
export async function uploadBundle(options: UploadOptions): Promise<UploadResult> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.uploadBundle(options)
}

export async function login(options: LoginOptions): Promise<SDKResult> {
  const sdk = new CapgoSDK({
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.login(options)
}

export async function doctor(options?: DoctorOptions): Promise<SDKResult<DoctorInfo>> {
  const sdk = new CapgoSDK()
  return sdk.doctor(options)
}

export async function checkBundleCompatibility(options: BundleCompatibilityOptions): Promise<SDKResult<BundleCompatibilityEntry[]>> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.checkBundleCompatibility(options)
}

export async function encryptBundle(options: EncryptBundleOptions): Promise<SDKResult<EncryptResult>> {
  const sdk = new CapgoSDK()
  return sdk.encryptBundle(options)
}

export async function decryptBundle(options: DecryptBundleOptions): Promise<SDKResult<DecryptResult>> {
  const sdk = new CapgoSDK()
  return sdk.decryptBundle(options)
}

export async function zipBundle(options: ZipBundleOptions): Promise<SDKResult<ZipResult>> {
  const sdk = new CapgoSDK()
  return sdk.zipBundle(options)
}

export async function starRepo(options?: StarRepoOptions): Promise<SDKResult<{ repository: string, alreadyStarred: boolean }>> {
  const sdk = new CapgoSDK()
  return sdk.starRepo(options)
}

export async function starAllRepositories(options?: StarAllRepositoriesOptions): Promise<SDKResult<StarAllRepositoryResult[]>> {
  const sdk = new CapgoSDK()
  return sdk.starAllRepositories(options)
}

export async function generateEncryptionKeys(options?: GenerateKeyOptions): Promise<SDKResult> {
  const sdk = new CapgoSDK()
  return sdk.generateEncryptionKeys(options)
}

export async function saveEncryptionKey(options?: SaveKeyOptions): Promise<SDKResult> {
  const sdk = new CapgoSDK()
  return sdk.saveEncryptionKey(options)
}

export async function deleteLegacyEncryptionKey(options?: DeleteOldKeyOptions): Promise<SDKResult<{ deleted: boolean }>> {
  const sdk = new CapgoSDK()
  return sdk.deleteLegacyEncryptionKey(options)
}

export async function getCurrentBundle(appId: string, channelId: string, options?: CurrentBundleOptions): Promise<SDKResult<string>> {
  const sdk = new CapgoSDK({
    apikey: options?.apikey,
    supaHost: options?.supaHost,
    supaAnon: options?.supaAnon,
  })
  return sdk.getCurrentBundle(appId, channelId, options)
}

export async function updateAppSetting(path: string, options: SetSettingOptions): Promise<SDKResult> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
  })
  return sdk.setAppSetting(path, options)
}

export async function getAccountId(options?: AccountIdOptions): Promise<SDKResult<string>> {
  const sdk = new CapgoSDK({
    apikey: options?.apikey,
    supaHost: options?.supaHost,
    supaAnon: options?.supaAnon,
  })
  return sdk.getAccountId(options)
}

export async function listOrganizations(options?: ListOrganizationsOptions): Promise<SDKResult<OrganizationInfo[]>> {
  const sdk = new CapgoSDK({
    apikey: options?.apikey,
    supaHost: options?.supaHost,
    supaAnon: options?.supaAnon,
  })
  return sdk.listOrganizations(options)
}

export async function addOrganization(options: AddOrganizationOptions): Promise<SDKResult<OrganizationInfo>> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.addOrganization(options)
}

export async function updateOrganization(options: UpdateOrganizationOptions): Promise<SDKResult<OrganizationInfo>> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.updateOrganization(options)
}

export async function deleteOrganization(orgId: string, options?: DeleteOrganizationOptions): Promise<SDKResult<{ deleted: boolean }>> {
  const sdk = new CapgoSDK({
    apikey: options?.apikey,
    supaHost: options?.supaHost,
    supaAnon: options?.supaAnon,
  })
  return sdk.deleteOrganization(orgId, options)
}

/**
 * Add a new app to Capgo Cloud (functional API)
 *
 * @example
 * ```typescript
 * const result = await addApp({
 *   appId: 'com.example.app',
 *   name: 'My App',
 *   apikey: 'your-api-key'
 * })
 * ```
 */
export async function addApp(options: AddAppOptions): Promise<SDKResult> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.addApp(options)
}

/**
 * List bundles for an app (functional API)
 *
 * @example
 * ```typescript
 * const result = await listBundles('com.example.app', { apikey: 'your-api-key' })
 * ```
 */
export async function listBundles(
  appId: string,
  options?: { apikey?: string, supaHost?: string, supaAnon?: string },
): Promise<SDKResult<BundleInfo[]>> {
  const sdk = new CapgoSDK(options)
  return sdk.listBundles(appId)
}

/**
 * Add a new channel (functional API)
 *
 * @example
 * ```typescript
 * const result = await addChannel({
 *   channelId: 'production',
 *   appId: 'com.example.app',
 *   apikey: 'your-api-key'
 * })
 * ```
 */
export async function addChannel(options: AddChannelOptions): Promise<SDKResult> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.addChannel(options)
}

/**
 * Request a native build for your app (functional API)
 *
 * SECURITY GUARANTEE:
 * Credentials are NEVER stored on Capgo servers. They are used only during
 * the build process and automatically deleted after completion.
 * Build outputs may optionally be uploaded for time-limited download links.
 *
 * @example
 * ```typescript
 * const result = await requestBuild({
 *   appId: 'com.example.app',
 *   path: './my-project',
 *   lane: 'ios', // Must be exactly "ios" or "android"
 *   credentials: {
 *     // iOS credentials (use standard environment variable names)
 *     BUILD_CERTIFICATE_BASE64: 'base64-encoded-cert',
 *     BUILD_PROVISION_PROFILE_BASE64: 'base64-encoded-profile',
 *     P12_PASSWORD: 'cert-password',
 *     APPLE_KEY_ID: 'KEY123',
 *     APPLE_ISSUER_ID: 'issuer-uuid',
 *     APPLE_KEY_CONTENT: 'base64-encoded-p8',
 *     APP_STORE_CONNECT_TEAM_ID: 'team-id',
 *     // Android credentials (use standard environment variable names)
 *     ANDROID_KEYSTORE_FILE: 'base64-encoded-keystore',
 *     KEYSTORE_KEY_ALIAS: 'my-key-alias',
 *     KEYSTORE_KEY_PASSWORD: 'key-password',
 *     KEYSTORE_STORE_PASSWORD: 'store-password',
 *     PLAY_CONFIG_JSON: 'base64-encoded-service-account-json'
 *   },
 *   apikey: 'your-api-key'
 * })
 *
 * if (result.success) {
 *   console.log('Job ID:', result.data.jobId)
 *   console.log('Status:', result.data.status)
 * }
 * ```
 */
export async function requestBuild(options: RequestBuildOptions): Promise<SDKResult<{ jobId: string, uploadUrl: string, status: string }>> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.requestBuild(options)
}

/**
 * Get device statistics/logs from Capgo backend (functional API)
 *
 * This function works similarly to waitLog, allowing you to poll for device activity.
 *
 * @example
 * ```typescript
 * // Get recent stats for an app
 * const result = await getStats({
 *   appId: 'com.example.app',
 *   apikey: 'your-api-key',
 *   rangeStart: new Date().toISOString(),
 *   limit: 100
 * })
 *
 * if (result.success && result.data) {
 *   result.data.forEach(stat => {
 *     console.log(`${stat.deviceId}: ${stat.action}`)
 *   })
 * }
 * ```
 */
export async function getStats(options: GetStatsOptions): Promise<SDKResult<DeviceStats[]>> {
  const sdk = new CapgoSDK({
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  return sdk.getStats(options)
}

export async function probeUpdates(options: ProbeOptions): Promise<SDKResult<ProbeInternalResult>> {
  const sdk = new CapgoSDK()
  return sdk.probe(options)
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get Capacitor configuration
 *
 * @example
 * ```typescript
 * const config = await getCapacitorConfig()
 * if (config) {
 *   console.log(config.appId)
 * }
 * ```
 */
export async function getCapacitorConfig() {
  try {
    return await getConfig()
  }
  catch {
    return null
  }
}

// ============================================================================
// Re-export useful types
// ============================================================================

export type { BuildCredentials } from './build/request'
export type { CapacitorConfig } from './config'
export type { ProbeInternalResult } from './probe'
export type {
  AccountIdOptions,
  AddAppOptions,
  AddChannelOptions,
  AddOrganizationOptions,
  AppInfo,
  BundleCompatibilityOptions,
  BundleInfo,
  CleanupOptions,
  CurrentBundleOptions,
  DecryptBundleOptions,
  DeleteOldKeyOptions,
  DeleteOrganizationOptions,
  DeviceStats,
  DoctorOptions,
  EncryptBundleOptions,
  GenerateKeyOptions,
  GetStatsOptions,
  ListOrganizationsOptions,
  LoginOptions,
  OrganizationInfo,
  ProbeOptions,
  RequestBuildOptions,
  SaveKeyOptions,
  SDKResult,
  SetSettingOptions,
  StarAllRepositoriesOptions,
  StarRepoOptions,
  StatsOrder,
  UpdateAppOptions,
  UpdateChannelOptions,
  UpdateOrganizationOptions,
  UploadOptions,
  UploadResult,
  ZipBundleOptions,
} from './schemas/sdk'
export type { Database } from './types/supabase.types'
export { createSupabaseClient } from './utils'
export {
  formatApiErrorForCli,
  getSecurityPolicyMessage,
  isSecurityPolicyError,
  parseSecurityPolicyError,
  SECURITY_POLICY_ERRORS,
  SECURITY_POLICY_MESSAGES,
} from './utils/security_policy_errors'
export type { ParsedSecurityError, SecurityPolicyErrorCode } from './utils/security_policy_errors'
