import type { UploadOptions } from '@capgo/cli/sdk'
import type { Database } from '../src/types/supabase.types'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { constants, createCipheriv, createHash, createPublicKey, privateEncrypt, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chdir, cwd, env } from 'node:process'
import { CapgoSDK } from '@capgo/cli/sdk'
import AdmZip from 'adm-zip'
import { getChannelsToAssignByChecksum, parseUploadChannels } from '../cli/src/bundle/upload-channels'
import { BASE_DEPENDENCIES, BASE_DEPENDENCIES_OLD, BASE_PACKAGE_JSON, TEMP_DIR_NAME } from './cli-utils'
import { APIKEY_TEST_ORG_SUPER_ADMIN, getSupabaseClient, USER_ID } from './test-utils'

const ROOT_DIR = cwd()

// Path to the project's capacitor.config.ts that the SDK modifies during key generation
const CAPACITOR_CONFIG_PATH = join(ROOT_DIR, 'capacitor.config.ts')

// Supabase base URL (not including /functions/v1)
const SUPABASE_URL = env.SUPABASE_URL || 'http://localhost:54321'
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

/**
 * SDK-based CLI test utilities
 * This replaces process spawning with direct SDK function calls for faster test execution
 */

// Cache for prepared apps to avoid repeated setup
const preparedApps = new Set<string>()
const knownApps = new Map<string, { app_id: string, owner_org: string | null, user_id: string | null }>()

// Key generation mutates repo-level files, so keep those operations serialized.
let keyGenerationQueue = Promise.resolve()

// Uploads temporarily change cwd, so serialize them within the current process.
let sdkCwdQueue = Promise.resolve()

export const tempFileFolder = (appId: string) => join(ROOT_DIR, TEMP_DIR_NAME, appId)

function generateDefaultJsonCliConfig(appId: string) {
  return {
    appId,
    appName: 'Test App',
    webDir: 'dist',
    plugins: {
      CapacitorUpdater: {
        autoUpdate: false,
        // Point TUS uploads to local Supabase instance for testing
        localApiFiles: `${SUPABASE_URL}/functions/v1/files`,
      },
    },
  }
}

/**
 * Create capacitor.config.json for test app
 */
async function createCapacitorConfig(appId: string, folderPath: string) {
  const capacitorConfigPath = join(folderPath, 'capacitor.config.json')
  const config = generateDefaultJsonCliConfig(appId)
  await writeFile(capacitorConfigPath, JSON.stringify(config, null, 2))
}

/**
 * Create package.json for test app
 */
async function createPackageJson(appId: string, folderPath: string, dependencies: Record<string, string> = BASE_DEPENDENCIES) {
  const packageJsonPath = join(folderPath, 'package.json')
  const packageJsonContent = BASE_PACKAGE_JSON
    .replace('%APPID%', appId)
    .replace('%DEPENDENCIES%', JSON.stringify(dependencies, null, 2))

  await writeFile(packageJsonPath, packageJsonContent)
}

/**
 * Create dist folder with a simple index.html
 */
async function createDistFolder(folderPath: string) {
  const distPath = join(folderPath, 'dist')
  await mkdir(distPath, { recursive: true })

  const indexHtmlPath = join(distPath, 'index.html')
  const indexHtmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Test App</title>
</head>
<body>
  <h1>Test App v1.0.0</h1>
  <script>
    // Call notifyAppReady() as required by Capgo
    if (window.CapacitorUpdater) {
      window.CapacitorUpdater.notifyAppReady();
    }
  </script>
</body>
</html>`

  await writeFile(indexHtmlPath, indexHtmlContent)
}

/**
 * Prepare a test app environment (creates folders and config files)
 * This is cached to avoid repeated setup
 */
export async function prepareCli(appId: string, dependencies?: Record<string, string>) {
  if (preparedApps.has(appId)) {
    return // Already prepared
  }

  const folderPath = tempFileFolder(appId)

  // Create app directory
  await mkdir(folderPath, { recursive: true })

  // Create necessary files
  await createCapacitorConfig(appId, folderPath)
  await createPackageJson(appId, folderPath, dependencies)
  await createDistFolder(folderPath)

  preparedApps.add(appId)
}

/**
 * Clean up test app directory
 */
export async function cleanupCli(appId: string) {
  const folderPath = tempFileFolder(appId)
  await rm(folderPath, { recursive: true, force: true })
  preparedApps.delete(appId)
}

async function getAppRecord(appId: string) {
  const cached = knownApps.get(appId)
  if (cached)
    return cached

  const { data } = await getSupabaseClient()
    .from('apps')
    .select('app_id, owner_org, user_id')
    .eq('app_id', appId)
    .maybeSingle()

  if (data)
    knownApps.set(appId, data)

  return data
}

async function getChannelRecord(appId: string, channelId: string) {
  const { data } = await getSupabaseClient()
    .from('channels')
    .select('id, version, public, disable_auto_update_under_native, disable_auto_update, allow_device_self_set, allow_emulator, allow_device, allow_dev, allow_prod, ios, android')
    .eq('app_id', appId)
    .eq('name', channelId)
    .maybeSingle()

  return data
}

async function getFirstVersionId(appId: string) {
  const { data } = await getSupabaseClient()
    .from('app_versions')
    .select('id')
    .eq('app_id', appId)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  return data?.id ?? null
}

async function getVersionId(appId: string, version: string) {
  const { data } = await getSupabaseClient()
    .from('app_versions')
    .select('id')
    .eq('app_id', appId)
    .eq('name', version)
    .maybeSingle()

  return data?.id ?? null
}

type ApiKeyRow = Pick<
  Database['public']['Tables']['apikeys']['Row'],
  'expires_at' | 'id' | 'key' | 'key_hash' | 'rbac_id' | 'user_id'
>
type RbacPermissionKey = string

interface NativePackage {
  name: string
  version: string
}

interface ChannelVersionRow {
  checksum: string | null
  id: number
  min_update_version: string | null
  name: string
  native_packages: NativePackage[] | null
}

interface CompatibilityEntry {
  localVersion: string | undefined
  name: string
  remoteVersion: string | undefined
}

function isApiKeyExpired(expiresAt: string | null) {
  return expiresAt != null && new Date(expiresAt).getTime() <= Date.now()
}

async function getApiKeyRecord(apikey: string) {
  const { data } = await getSupabaseClient().rpc('find_apikey_by_value' as any, {
    key_value: apikey,
  })
  const row = data?.[0] as ApiKeyRow | undefined

  if (!row || isApiKeyExpired(row.expires_at))
    return null

  return row
}

async function apiKeyHasAnyAppPermission(
  apikey: string,
  apiKey: ApiKeyRow,
  app: { app_id: string, owner_org: string | null },
  requiredPermissions: RbacPermissionKey[],
) {
  if (!app.owner_org)
    return false

  for (const permissionKey of Array.from(new Set(requiredPermissions))) {
    const { data, error } = await getSupabaseClient().rpc('rbac_check_permission_direct' as any, {
      p_permission_key: permissionKey,
      p_user_id: apiKey.user_id,
      p_org_id: app.owner_org,
      p_app_id: app.app_id,
      p_channel_id: null,
      p_apikey: apikey,
    })

    if (!error && data === true)
      return true
  }

  return false
}

async function apiKeyHasAnyChannelPermission(
  apikey: string,
  apiKey: ApiKeyRow,
  app: { app_id: string, owner_org: string | null },
  channelId: number,
  requiredPermissions: RbacPermissionKey[],
) {
  if (!app.owner_org)
    return false

  for (const permissionKey of Array.from(new Set(requiredPermissions))) {
    const { data, error } = await getSupabaseClient().rpc('rbac_check_permission_direct' as any, {
      p_permission_key: permissionKey,
      p_user_id: apiKey.user_id,
      p_org_id: app.owner_org,
      p_app_id: app.app_id,
      p_channel_id: channelId,
      p_apikey: apikey,
    })

    if (!error && data === true)
      return true
  }

  return false
}

async function getAuthorizedApp(
  apikey: string,
  appId: string,
  requiredPermissions: RbacPermissionKey[],
) {
  const apiKey = await getApiKeyRecord(apikey)
  if (!apiKey)
    return { error: 'Invalid API key or insufficient permissions.' as const }

  const app = await getAppRecord(appId)
  if (!app)
    return { error: `App ${appId} does not exist` as const }

  if (!(await apiKeyHasAnyAppPermission(apikey, apiKey, app, requiredPermissions)))
    return { error: 'Invalid API key or insufficient permissions.' as const }

  return { apiKey, app } as const
}

async function getAppsForApiKey(apikey: string, requiredPermissions: RbacPermissionKey[]) {
  const apiKey = await getApiKeyRecord(apikey)
  if (!apiKey)
    return { error: 'Invalid API key or insufficient permissions.' as const }

  const { data, error } = await getSupabaseClient()
    .from('apps')
    .select('app_id, created_at, icon_url, name, owner_org, user_id')
    .order('created_at', { ascending: true })

  if (error)
    return { error: error.message }

  const filteredApps = []
  for (const app of data ?? []) {
    if (await apiKeyHasAnyAppPermission(apikey, apiKey, app, requiredPermissions))
      filteredApps.push(app)
  }

  return {
    apiKey,
    apps: filteredApps,
  } as const
}

async function getChannelVersionRecord(appId: string, channelId: string) {
  const { data } = await getSupabaseClient()
    .from('channels')
    .select('version:app_versions!channels_version_fkey( id, checksum, min_update_version, name, native_packages )')
    .eq('app_id', appId)
    .eq('name', channelId)
    .maybeSingle()

  return (data?.version ?? null) as ChannelVersionRow | null
}

async function listFilesRecursive(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(folderPath, entry.name)
    if (entry.isDirectory())
      return listFilesRecursive(entryPath)

    return [entryPath]
  }))

  return nested.flat()
}

async function hasNotifyAppReady(distPath: string) {
  const files = await listFilesRecursive(distPath)

  for (const filePath of files) {
    if (!/\.(?:html|js|ts|tsx|jsx)$/i.test(filePath))
      continue

    const fileContent = await readFile(filePath, 'utf8')
    if (fileContent.includes('notifyAppReady'))
      return true
  }

  return false
}

function buildZipBuffer(distPath: string) {
  const zip = new AdmZip()
  zip.addLocalFolder(distPath)
  return zip.toBuffer()
}

function checksumHex(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function getPublicKeyFingerprint(publicKey: string) {
  return publicKey
    .replace(/-----BEGIN (RSA )?PUBLIC KEY-----/g, '')
    .replace(/-----END (RSA )?PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '')
    .substring(0, 20)
}

function getKeyIdFromPrivateKey(privateKey: string) {
  const publicKey = createPublicKey(privateKey).export({ type: 'pkcs1', format: 'pem' })
  return getPublicKeyFingerprint(publicKey.toString())
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function resolveInstalledVersion(packageName: string, nodeModulesPaths: string[]) {
  const parts = packageName.split('/')

  for (const nodeModulesPath of nodeModulesPaths) {
    try {
      const packageJsonPath = join(nodeModulesPath, ...parts, 'package.json')
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string }
      if (packageJson.version)
        return packageJson.version
    }
    catch {
      // Ignore missing dependency paths and keep searching fallback locations.
    }
  }

  return null
}

function splitPaths(value: string | undefined, fallback: string[]) {
  if (!value)
    return fallback

  return value
    .split(',')
    .map(path => path.trim())
    .filter(Boolean)
}

async function extractNativePackages(appId: string, packageJsonPath: string | undefined, nodeModulesPath: string | undefined) {
  const resolvedPackageJsonPath = splitPaths(packageJsonPath, [join(tempFileFolder(appId), 'package.json')])[0] ?? join(tempFileFolder(appId), 'package.json')
  const nodeModulesPaths = splitPaths(nodeModulesPath, [join(tempFileFolder(appId), 'node_modules'), join(ROOT_DIR, 'node_modules')])
  const packageJson = JSON.parse(await readFile(resolvedPackageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const dependencies = packageJson.dependencies ?? {}

  const nativePackages = await Promise.all(Object.entries(dependencies).map(async ([name, version]) => ({
    name,
    version: await resolveInstalledVersion(name, nodeModulesPaths) ?? version,
  })))

  return nativePackages
}

async function buildCompatibilityResult(appId: string, channel: string, packageJsonPath: string | undefined, nodeModulesPath: string | undefined) {
  const localDependencies = await extractNativePackages(appId, packageJsonPath, nodeModulesPath)
  const remoteVersion = await getChannelVersionRecord(appId, channel)
  const remoteDependencies = new Map((remoteVersion?.native_packages ?? []).map(pkg => [pkg.name, pkg]))

  const compatibility: CompatibilityEntry[] = localDependencies.map((pkg) => {
    const remotePackage = remoteDependencies.get(pkg.name)
    return {
      name: pkg.name,
      localVersion: pkg.version,
      remoteVersion: remotePackage?.version,
    }
  })

  for (const remotePackage of remoteVersion?.native_packages ?? []) {
    if (!localDependencies.find(pkg => pkg.name === remotePackage.name)) {
      compatibility.push({
        name: remotePackage.name,
        localVersion: undefined,
        remoteVersion: remotePackage.version,
      })
    }
  }

  return compatibility
}

async function uploadBufferToStorage(filePath: string, zipBuffer: Buffer) {
  const supabase = getSupabaseClient()
  const bucket = supabase.storage.from('capgo')

  await bucket.remove([filePath])

  const { data, error } = await bucket.createSignedUploadUrl(filePath)
  if (error || !data?.signedUrl)
    throw new Error(error?.message ?? 'Cannot get upload url')

  const uploadResponse = await fetch(data.signedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/zip',
    },
    body: new Uint8Array(zipBuffer),
  })

  if (!uploadResponse.ok)
    throw new Error(`Upload failed with status ${uploadResponse.status}`)
}

async function deleteBundleRecord(versionId: number) {
  const { error } = await getSupabaseClient()
    .from('app_versions')
    .delete()
    .eq('id', versionId)

  if (error)
    throw new Error(error.message)
}

async function createBundleRecord(
  appId: string,
  version: string,
  app: NonNullable<Awaited<ReturnType<typeof getAppRecord>>>,
  apiKey: ApiKeyRow,
  fields: {
    checksum: string
    comment?: string
    key_id?: string | null
    min_update_version?: string | null
    native_packages?: NativePackage[] | null
    r2_path: string
    session_key?: string | null
  },
) {
  if (!app.owner_org)
    throw new Error(`App ${appId} does not have an owner organization`)

  const { data, error } = await getSupabaseClient()
    .from('app_versions')
    .insert({
      app_id: appId,
      checksum: fields.checksum,
      comment: fields.comment ?? null,
      key_id: fields.key_id ?? null,
      min_update_version: fields.min_update_version ?? null,
      name: version,
      native_packages: fields.native_packages as any,
      owner_org: app.owner_org,
      r2_path: fields.r2_path,
      session_key: fields.session_key ?? null,
      storage_provider: 'r2-direct',
      user_id: apiKey.user_id,
    })
    .select('id')
    .single()

  if (error || !data)
    throw new Error(error?.message ?? 'Cannot create bundle')

  return data.id
}

async function resolveUploadMinUpdateVersion(
  appId: string,
  channel: string | undefined,
  autoMinUpdateVersion: boolean | undefined,
  explicitMinUpdateVersion: string | undefined,
) {
  if (explicitMinUpdateVersion)
    return { minUpdateVersion: explicitMinUpdateVersion, error: null as string | null }

  if (!autoMinUpdateVersion || !channel)
    return { minUpdateVersion: null, error: null as string | null }

  const remoteVersion = await getChannelVersionRecord(appId, channel)
  if (!remoteVersion || remoteVersion.native_packages == null)
    return { minUpdateVersion: null, error: null as string | null }

  if (!remoteVersion.min_update_version)
    return { minUpdateVersion: null, error: 'Invalid remote min update version' }

  return {
    minUpdateVersion: remoteVersion.min_update_version,
    error: null as string | null,
  }
}

async function buildUploadPayload(appId: string, options: UploadOptions) {
  const distPath = options.path
  const plainZipBuffer = buildZipBuffer(distPath)
  const nativePackages = options.ignoreCompatibilityCheck
    ? null
    : await extractNativePackages(appId, options.packageJsonPaths, undefined)

  if (options.encrypt) {
    if (!options.encryptionKey)
      return { error: 'Missing encryption key' as const }

    const privateKey = await readFile(options.encryptionKey, 'utf8')
    const keyId = getKeyIdFromPrivateKey(privateKey)
    const iv = randomBytes(16)
    const aesKey = randomBytes(16)
    const cipher = createCipheriv('aes-128-cbc', aesKey, iv)
    const encryptedZipBuffer = Buffer.concat([cipher.update(plainZipBuffer), cipher.final()])
    const encryptedSessionKey = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, aesKey).toString('base64')

    return {
      checksum: checksumHex(encryptedZipBuffer),
      keyId,
      nativePackages,
      sessionKey: `${iv.toString('base64')}:${encryptedSessionKey}`,
      zipBuffer: encryptedZipBuffer,
    } as const
  }

  return {
    checksum: checksumHex(plainZipBuffer),
    keyId: null,
    nativePackages,
    sessionKey: null,
    zipBuffer: plainZipBuffer,
  } as const
}

/**
 * Create an SDK instance with test credentials
 */
export function createTestSDK(apikey: string = APIKEY_TEST_ORG_SUPER_ADMIN) {
  const sdk = new CapgoSDK({
    apikey,
    supaHost: SUPABASE_URL,
    supaAnon: SUPABASE_ANON_KEY,
  })

  // Keep repo tests on repo-controlled RBAC checks while the published CLI SDK
  // still uses anonymous Supabase clients for direct table access.
  ;(sdk as any).addChannel = async ({ channelId, appId, default: isDefault, selfAssign }: {
    channelId: string
    appId: string
    default?: boolean
    selfAssign?: boolean
  }) => {
    const access = await getAuthorizedApp(apikey, appId, ['app.create_channel'])
    if ('error' in access)
      return { success: false, error: access.error }

    const { app } = access
    if (!app.owner_org)
      return { success: false, error: `App ${appId} does not have an owner organization` }

    if (await getChannelRecord(appId, channelId))
      return { success: false, error: `Channel ${channelId} already exists` }

    const versionId = await getFirstVersionId(appId)
    if (!versionId)
      return { success: false, error: 'Cannot find version' }

    const { error } = await getSupabaseClient()
      .from('channels')
      .insert({
        name: channelId,
        app_id: appId,
        version: versionId,
        owner_org: app.owner_org,
        created_by: app.user_id ?? USER_ID,
        public: isDefault ?? false,
        disable_auto_update_under_native: true,
        disable_auto_update: 'major',
        allow_device_self_set: selfAssign ?? false,
        allow_emulator: false,
        allow_device: false,
        allow_dev: false,
        allow_prod: false,
        ios: false,
        android: false,
      })

    if (error)
      return { success: false, error: error.message }

    return { success: true }
  }

  ;(sdk as any).listChannels = async (appId: string) => {
    const access = await getAuthorizedApp(apikey, appId, ['app.read_channels'])
    if ('error' in access)
      return { success: false, error: access.error }

    const { data, error } = await getSupabaseClient()
      .from('channels')
      .select('id, name, app_id, public, disable_auto_update_under_native, disable_auto_update, allow_device_self_set, allow_emulator, allow_device, allow_dev, allow_prod, ios, android, version')
      .eq('app_id', appId)
      .order('created_at', { ascending: true })

    if (error)
      return { success: false, error: error.message }

    return {
      success: true,
      data: data ?? [],
    }
  }

  ;(sdk as any).updateChannel = async ({
    channelId,
    appId,
    bundle,
    state,
    downgrade,
    ios,
    android,
    selfAssign,
    disableAutoUpdate,
    dev,
    emulator,
    device,
    prod,
  }: {
    channelId: string
    appId: string
    bundle?: string
    state?: string
    downgrade?: boolean
    ios?: boolean
    android?: boolean
    selfAssign?: boolean
    disableAutoUpdate?: Database['public']['Enums']['disable_update']
    dev?: boolean
    emulator?: boolean
    device?: boolean
    prod?: boolean
  }) => {
    const apiKey = await getApiKeyRecord(apikey)
    if (!apiKey)
      return { success: false, error: 'Invalid API key or insufficient permissions.' }

    const app = await getAppRecord(appId)
    if (!app)
      return { success: false, error: `App ${appId} does not exist` }

    const existingChannel = await getChannelRecord(appId, channelId)
    if (!existingChannel)
      return { success: false, error: 'Cannot find channel' }

    const hasBundlePromotion = bundle != null
    const hasSettingsUpdate = state != null
      || downgrade != null
      || ios != null
      || android != null
      || selfAssign != null
      || disableAutoUpdate != null
      || dev != null
      || emulator != null
      || device != null
      || prod != null

    if (hasSettingsUpdate && !(await apiKeyHasAnyChannelPermission(apikey, apiKey, app, existingChannel.id, ['channel.update_settings'])))
      return { success: false, error: 'Invalid API key or insufficient permissions.' }
    if (hasBundlePromotion && !(await apiKeyHasAnyChannelPermission(apikey, apiKey, app, existingChannel.id, ['channel.promote_bundle'])))
      return { success: false, error: 'Invalid API key or insufficient permissions.' }

    if (state && !['default', 'normal'].includes(state))
      return { success: false, error: 'Unknown state' }

    const versionId = bundle
      ? await getVersionId(appId, bundle)
      : existingChannel.version

    if (!versionId)
      return { success: false, error: 'Cannot find version' }

    const { error } = await getSupabaseClient()
      .from('channels')
      .update({
        version: versionId,
        ...(state === 'default' ? { public: true } : {}),
        ...(state === 'normal' ? { public: false } : {}),
        ...(typeof downgrade === 'boolean' ? { disable_auto_update_under_native: !downgrade } : {}),
        ...(typeof ios === 'boolean' ? { ios } : {}),
        ...(typeof android === 'boolean' ? { android } : {}),
        ...(typeof selfAssign === 'boolean' ? { allow_device_self_set: selfAssign } : {}),
        ...(disableAutoUpdate == null ? {} : { disable_auto_update: disableAutoUpdate }),
        ...(typeof dev === 'boolean' ? { allow_dev: dev } : {}),
        ...(typeof emulator === 'boolean' ? { allow_emulator: emulator } : {}),
        ...(typeof device === 'boolean' ? { allow_device: device } : {}),
        ...(typeof prod === 'boolean' ? { allow_prod: prod } : {}),
      })
      .eq('id', existingChannel.id)

    if (error)
      return { success: false, error: error.message }

    return { success: true }
  }

  ;(sdk as any).deleteChannel = async (channelId: string, appId: string) => {
    const apiKey = await getApiKeyRecord(apikey)
    if (!apiKey)
      return { success: false, error: 'Invalid API key or insufficient permissions.' }

    const app = await getAppRecord(appId)
    if (!app)
      return { success: false, error: `App ${appId} does not exist` }

    const existingChannel = await getChannelRecord(appId, channelId)
    if (!existingChannel)
      return { success: false, error: 'Channel not found' }

    if (!(await apiKeyHasAnyChannelPermission(apikey, apiKey, app, existingChannel.id, ['channel.delete'])))
      return { success: false, error: 'Invalid API key or insufficient permissions.' }

    const { error } = await getSupabaseClient()
      .from('channels')
      .delete()
      .eq('id', existingChannel.id)

    if (error)
      return { success: false, error: error.message }

    return { success: true }
  }

  ;(sdk as any).getCurrentBundle = async (appId: string, channelId: string) => {
    const apiKey = await getApiKeyRecord(apikey)
    if (!apiKey)
      return { success: false, error: 'Invalid API key or insufficient permissions.' }

    const app = await getAppRecord(appId)
    if (!app)
      return { success: false, error: `App ${appId} does not exist` }

    const channel = await getChannelRecord(appId, channelId)
    if (!channel)
      return { success: false, error: `Channel ${channelId} not found for app ${appId}` }

    if (!(await apiKeyHasAnyChannelPermission(apikey, apiKey, app, channel.id, ['channel.read'])))
      return { success: false, error: 'Invalid API key or insufficient permissions.' }

    const version = await getChannelVersionRecord(appId, channelId)
    if (!version)
      return { success: false, error: `Channel ${channelId} not found for app ${appId}` }

    return {
      success: true,
      data: version.name,
    }
  }

  ;(sdk as any).listApps = async () => {
    const access = await getAppsForApiKey(apikey, ['app.read'])
    if ('error' in access)
      return { success: false, error: access.error }

    return {
      success: true,
      data: access.apps.map(app => ({
        appId: app.app_id,
        name: app.name || 'Unknown',
        iconUrl: app.icon_url || undefined,
        createdAt: new Date(app.created_at || ''),
      })),
    }
  }

  ;(sdk as any).checkBundleCompatibility = async ({
    appId,
    channel,
    nodeModules,
    packageJson,
  }: {
    appId: string
    channel: string
    nodeModules?: string
    packageJson?: string
  }) => {
    const access = await getAuthorizedApp(apikey, appId, ['app.read_bundles'])
    if ('error' in access)
      return { success: false, error: access.error }

    try {
      const data = await buildCompatibilityResult(appId, channel, packageJson, nodeModules)
      return {
        success: true,
        data,
      }
    }
    catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  ;(sdk as any).uploadBundle = async (options: UploadOptions) => {
    const resolvedApiKey = options.apikey || apikey
    const access = await getAuthorizedApp(resolvedApiKey, options.appId, ['app.upload_bundle'])
    if ('error' in access)
      return { success: false, error: access.error }

    const { apiKey, app } = access
    const bundleVersion = options.bundle
    if (!bundleVersion)
      return { success: false, error: 'Missing bundle version' }

    const existingVersionId = await getVersionId(options.appId, bundleVersion)
    if (existingVersionId)
      return { success: false, error: `Version ${bundleVersion} already exists` }

    try {
      if (!options.disableCodeCheck && !(await hasNotifyAppReady(options.path)))
        return { success: false, error: 'Missing notifyAppReady in bundle code' }

      const uploadPayload = await buildUploadPayload(options.appId, options)
      if ('error' in uploadPayload)
        return { success: false, error: uploadPayload.error }

      const requestedChannels = parseUploadChannels(options.channel)
      if (options.channel !== undefined && requestedChannels.length === 0)
        return { success: false, error: 'Missing channel name' }

      const targetChannels = requestedChannels.length > 0 ? requestedChannels : parseUploadChannels('production')
      const remoteChecksums = new Map<string, string | null>()
      for (const targetChannel of targetChannels) {
        const currentChannelVersion = await getChannelVersionRecord(options.appId, targetChannel)
        remoteChecksums.set(targetChannel, currentChannelVersion?.checksum ?? null)
      }
      const { channelsToAssign } = getChannelsToAssignByChecksum(targetChannels, uploadPayload.checksum, remoteChecksums)

      if (channelsToAssign.length === 0) {
        return {
          success: false,
          error: 'Cannot upload the same bundle content',
        }
      }
      for (const targetChannel of channelsToAssign) {
        const channelRecord = await getChannelRecord(options.appId, targetChannel)
        if (channelRecord) {
          const canPromote = await apiKeyHasAnyChannelPermission(resolvedApiKey, apiKey, app, channelRecord.id, ['channel.promote_bundle'])
          if (!canPromote)
            return { success: false, error: 'Cannot set channel because this API key lacks channel.promote_bundle for the target channel' }
          if (options.selfAssign && !(await apiKeyHasAnyChannelPermission(resolvedApiKey, apiKey, app, channelRecord.id, ['channel.update_settings'])))
            return { success: false, error: 'Cannot enable device self-assign because this API key lacks channel.update_settings' }
          continue
        }

        if (!app.owner_org)
          return { success: false, error: 'App does not have an owner organization' }
        if (!(await apiKeyHasAnyAppPermission(resolvedApiKey, apiKey, app, ['app.create_channel'])))
          return { success: false, error: 'Cannot create target channel because this API key lacks app.create_channel' }
      }

      const minUpdateVersion = await resolveUploadMinUpdateVersion(
        options.appId,
        channelsToAssign[0] ?? targetChannels[0],
        options.autoMinUpdateVersion,
        options.minUpdateVersion,
      )
      if (minUpdateVersion.error)
        return { success: false, error: minUpdateVersion.error }

      const r2Path = `orgs/${app.owner_org}/apps/${options.appId}/${bundleVersion}.zip`
      const versionId = await createBundleRecord(options.appId, bundleVersion, app, apiKey, {
        checksum: uploadPayload.checksum,
        comment: options.comment,
        key_id: uploadPayload.keyId,
        min_update_version: minUpdateVersion.minUpdateVersion,
        native_packages: uploadPayload.nativePackages,
        r2_path: r2Path,
        session_key: uploadPayload.sessionKey,
      })

      try {
        await uploadBufferToStorage(r2Path, uploadPayload.zipBuffer)
      }
      catch (uploadError) {
        try {
          await deleteBundleRecord(versionId)
        }
        catch (cleanupError) {
          throw new Error(`Upload failed and cleanup failed: ${getErrorMessage(uploadError)}; cleanup error: ${getErrorMessage(cleanupError)}`)
        }

        throw uploadError
      }

      for (const targetChannel of channelsToAssign) {
        const channelRecord = await getChannelRecord(options.appId, targetChannel)
        if (channelRecord) {
          const { error } = await getSupabaseClient()
            .from('channels')
            .update({
              version: versionId,
              ...(typeof options.selfAssign === 'boolean' ? { allow_device_self_set: options.selfAssign } : {}),
            })
            .eq('id', channelRecord.id)
          if (error)
            return { success: false, error: error.message }
          continue
        }

        const { data: createdChannel, error: createError } = await getSupabaseClient()
          .from('channels')
          .insert({
            name: targetChannel,
            app_id: options.appId,
            owner_org: app.owner_org,
            created_by: app.user_id ?? USER_ID,
            version: null,
            allow_device_self_set: options.selfAssign ?? false,
          })
          .select('id')
          .single()
        if (createError || !createdChannel)
          return { success: false, error: createError?.message ?? 'Cannot create target channel' }

        const { error: promoteError } = await getSupabaseClient()
          .from('channels')
          .update({ version: versionId })
          .eq('id', createdChannel.id)
        if (promoteError)
          return { success: false, error: promoteError.message }
      }

      return {
        success: true,
        checksum: uploadPayload.checksum,
        sessionKey: uploadPayload.sessionKey,
        storageProvider: 'r2-direct',
      }
    }
    catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  return sdk
}

/**
 * Upload a bundle using the SDK with test-specific defaults
 * Provides: auto path calculation, disables code checks, uses zip format
 */
export async function uploadBundleSDK(
  appId: string,
  version: string,
  channel?: string,
  additionalOptions?: Partial<UploadOptions>,
) {
  const sdk = createTestSDK(additionalOptions?.apikey ?? APIKEY_TEST_ORG_SUPER_ADMIN)

  const options: UploadOptions = {
    appId,
    path: join(tempFileFolder(appId), 'dist'),
    bundle: version,
    channel,
    disableCodeCheck: true, // Skip notifyAppReady check for tests
    useZip: true,
    useTus: false,
    // TUS protocol uses localApiFiles from capacitor.config.json
    ...additionalOptions,
  }

  const previousOperation = sdkCwdQueue
  let operationComplete: () => void
  sdkCwdQueue = new Promise(resolve => operationComplete = resolve)

  await previousOperation
  const originalCwd = cwd()

  try {
    chdir(tempFileFolder(appId))
    return await sdk.uploadBundle(options)
  }
  finally {
    chdir(originalCwd)
    operationComplete!()
  }
}

// Note: Tests should use createTestSDK() directly for channel operations
// Example: const sdk = createTestSDK(); await sdk.addChannel({ channelId, appId })

/**
 * Generate encryption keys using the SDK
 * Uses a queue to serialize operations (prevent concurrent conflicts when creating keys in project root)
 *
 * IMPORTANT: The SDK's generateEncryptionKeys() modifies the project's capacitor.config.ts
 * to add the public key. This function backs up and restores the config file to prevent
 * test pollution.
 *
 * Since tests run concurrently but key generation is serialized via the queue, we:
 * 1. Back up the config at the start of each queued operation
 * 2. Restore it at the end of each queued operation (in finally block)
 * This ensures each test sees a clean config file.
 */
export async function generateEncryptionKeysSDK(appId: string, force = true) {
  const { existsSync, renameSync, readFileSync, writeFileSync } = await import('node:fs')

  // Queue this operation to run after previous key generations complete.
  let operationComplete: () => void
  const previousOperation = keyGenerationQueue
  keyGenerationQueue = new Promise(resolve => operationComplete = resolve)

  await previousOperation

  // Backup the capacitor.config.ts content AFTER waiting for the queue
  // This ensures we get a clean config (either original or restored by previous operation)
  let configBackup: string | null = null
  if (existsSync(CAPACITOR_CONFIG_PATH)) {
    configBackup = readFileSync(CAPACITOR_CONFIG_PATH, 'utf-8')
  }

  try {
    const folderPath = tempFileFolder(appId)
    const result = await new Promise<{ success: boolean, error?: string }>((resolve) => {
      const script = `
        import { CapgoSDK } from '@capgo/cli/sdk'

        const sdk = new CapgoSDK({
          supaHost: ${JSON.stringify(SUPABASE_URL)},
          supaAnon: ${JSON.stringify(SUPABASE_ANON_KEY)},
        })

        const result = await sdk.generateEncryptionKeys({ force: ${force ? 'true' : 'false'} })
        console.log(JSON.stringify(result))
        process.exit(result.success ? 0 : 1)
      `

      execFile('bun', ['-e', script], { cwd: ROOT_DIR }, (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim()
        if (error) {
          resolve({
            success: false,
            error: output || error.message,
          })
          return
        }

        const lines = output
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
        const jsonLine = [...lines].reverse().find(line => line.startsWith('{') && line.endsWith('}'))

        if (!jsonLine) {
          resolve({
            success: false,
            error: output || 'generateEncryptionKeys returned no result',
          })
          return
        }

        try {
          resolve(JSON.parse(jsonLine))
        }
        catch {
          resolve({
            success: false,
            error: output || 'generateEncryptionKeys returned invalid JSON',
          })
        }
      })
    })

    if (!result.success) {
      return result
    }

    // Find where the keys were actually created and move them to the test folder
    const privateKeySource = join(ROOT_DIR, '.capgo_key_v2')
    const publicKeySource = join(ROOT_DIR, '.capgo_key_v2.pub')
    const privateKeyDest = join(folderPath, '.capgo_key_v2')
    const publicKeyDest = join(folderPath, '.capgo_key_v2.pub')

    // Check if keys exist in project root
    if (existsSync(privateKeySource) && existsSync(publicKeySource)) {
      renameSync(privateKeySource, privateKeyDest)
      renameSync(publicKeySource, publicKeyDest)
    }
    else {
      // Keys might have been created in the test folder already
      // Check if they exist there
      if (!existsSync(privateKeyDest) || !existsSync(publicKeyDest)) {
        return {
          success: false,
          error: `Keys not found in expected locations. Checked:\n- ${privateKeySource}\n- ${privateKeyDest}`,
        }
      }
    }

    return result
  }
  finally {
    // Add a small delay to allow any async SDK operations to complete
    // The SDK may be writing to the config file asynchronously
    await new Promise(resolve => setTimeout(resolve, 100))

    // Restore the capacitor.config.ts from our backup (SDK modified it with the public key)
    if (configBackup !== null) {
      try {
        writeFileSync(CAPACITOR_CONFIG_PATH, configBackup)
      }
      catch {
        // Best effort cleanup - don't fail the test if restore fails
        console.warn('Warning: Failed to restore capacitor.config.ts from backup')
      }
    }

    // Signal that this operation is complete
    operationComplete!()
  }
}

// Export BASE_DEPENDENCIES for compatibility
export { BASE_DEPENDENCIES, BASE_DEPENDENCIES_OLD }
