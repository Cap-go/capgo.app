/**
 * Bundle artifact preparation shared by `bundle upload` and the offline
 * `bundle zip` packer. Everything here is local (no API key, no network): the
 * online upload wires its analytics through the optional hooks, so both
 * commands produce byte-for-byte the same zip, checksum, encryption metadata,
 * native package list and delta encryption settings.
 */
import type { Buffer } from 'node:buffer'
import type { getLocalDependencies } from '../utils'
import type { OptionsUpload } from './upload_interface'
import { existsSync, readFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { greaterOrEqual, parse } from '@std/semver'
import { calcKeyId, encryptChecksum, encryptChecksumV3, encryptSource, generateSessionKey } from '../api/crypto'
import { getChecksum } from '../checksum'
import { isCordovaMode } from '../framework/mode'
import { CliUserError } from '../shared/cli-user-error'
import { baseKeyV2, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7, findRoot, getInstalledVersion, isDeprecatedPluginVersion, zipFile } from '../utils'
import { getUploadReporter } from './reporter'

const log = {
  info: (message: string) => getUploadReporter().info(message),
  warn: (message: string) => getUploadReporter().warn(message),
  error: (message: string) => getUploadReporter().error(message),
}

// Same contract as upload.ts uploadFail: log, then throw a CliUserError.
function artifactFail(message: string): never {
  log.error(message)
  throw new CliUserError(message)
}

// Minimum versions that support hex checksum format
const HEX_CHECKSUM_MIN_VERSION_V5 = '5.30.0'
const HEX_CHECKSUM_MIN_VERSION_V6 = '6.30.0'
const HEX_CHECKSUM_MIN_VERSION_V7 = '7.30.0'

export type BundleArtifactOptions = Pick<OptionsUpload, 'mode' | 'keyV2' | 'keyDataV2' | 'key' | 'oldEncryption' | 'forceCrc32Checksum' | 'packageJson' | 'displayIvSession' | 'verbose'>

export interface BundleArtifactHooks {
  /** Called right before v2 encryption starts (the online upload sends its analytics event here). */
  onEncryptV2?: () => Promise<void>
}

const CORDOVA_UPDATER_PACKAGES = [
  '@capgo/cordova-updater',
  'cordova-plugin-capgo',
] as const

interface ResolvedUpdaterForUpload {
  packageName: string
  version: string
}

function isCordovaUpdaterPackage(packageName: string): boolean {
  return (CORDOVA_UPDATER_PACKAGES as readonly string[]).includes(packageName)
}

export async function resolveUpdaterForUpload(options: Pick<OptionsUpload, 'mode' | 'packageJson'>, root: string): Promise<ResolvedUpdaterForUpload | null> {
  if (!isCordovaMode(options.mode)) {
    const version = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)
    return version ? { packageName: '@capgo/capacitor-updater', version } : null
  }

  for (const packageName of CORDOVA_UPDATER_PACKAGES) {
    const version = await getInstalledVersion(packageName, root, options.packageJson)
    if (version)
      return { packageName, version }
  }
  return null
}


/**
 * Zip the web assets, compute the checksum and apply v2 encryption exactly as
 * `bundle upload` does (sha256/crc32 selection, .capgo_key_v2 default,
 * --key-v2/--key-data-v2/--no-key, V3 hex vs V2 base64 checksum signature).
 */
export async function prepareBundleArtifact(path: string, options: BundleArtifactOptions, publicKeyFromConfig?: string, hooks: BundleArtifactHooks = {}) {
  let ivSessionKey
  let sessionKey
  let checksum = ''
  let zipped: Buffer | null = null
  let encryptionMethod = 'none' as 'none' | 'v2' | 'v1'
  let finalKeyData = ''
  let keyId = ''
  let checksumEncryption: 'v2' | 'v3' | undefined
  const keyV2 = options.keyV2
  const noKey = options.key === false

  const s = getUploadReporter().spinner()
  s.start(`Zipping bundle from ${path}`)
  zipped = await zipFile(path)
  s.message(`Calculating checksum`)
  const root = findRoot(cwd())
  const resolvedUpdater = await resolveUpdaterForUpload(options, root)
  const updaterVersion = resolvedUpdater?.version
  const updaterPackageName = resolvedUpdater?.packageName
  let useSha256 = false
  let coerced
  try {
    coerced = updaterVersion ? parse(updaterVersion) : undefined
  }
  catch {
    coerced = undefined
  }
  if (!resolvedUpdater) {
    if (isCordovaMode(options.mode)) {
      log.warn('Cannot find a Capgo updater plugin in node_modules. Using SHA256 checksum for this Cordova upload.')
      useSha256 = true
    }
    else {
      artifactFail('Cannot find @capgo/capacitor-updater in node_modules, please install it first with your package manager')
    }
  }
  else if (updaterPackageName && isCordovaUpdaterPackage(updaterPackageName)) {
    useSha256 = true
  }
  else if (coerced) {
    // Use SHA256 for v5.10.0+, v6.25.0+ and v7.0.30+
    useSha256 = !isDeprecatedPluginVersion(coerced, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7)
  }
  else if (updaterVersion === 'link:@capgo/capacitor-updater' || updaterVersion === 'file:..' || updaterVersion === 'file:../') {
    log.warn(`Using local ${updaterPackageName ?? '@capgo/capacitor-updater'}. Assuming latest version for checksum calculation.`)
    useSha256 = true
  }
  const forceCrc32 = options.forceCrc32Checksum === true
  const shouldUseSha256 = !forceCrc32 && (((keyV2 || options.keyDataV2 || existsSync(baseKeyV2)) && !noKey) || useSha256)
  const checksumAlgorithm: 'sha256' | 'crc32' = shouldUseSha256 ? 'sha256' : 'crc32'
  checksum = await getChecksum(zipped, checksumAlgorithm)
  s.stop(`Checksum ${shouldUseSha256 ? 'SHA256' : 'CRC32'}${forceCrc32 ? ' (forced)' : ''}: ${checksum}`)
  // key should be undefined or a string if false it should ignore encryption DO NOT REPLACE key === false With !key it will not work
  if (noKey) {
    log.info(`Encryption ignored`)
  }
  else if ((keyV2 || existsSync(baseKeyV2) || options.keyDataV2) && !options.oldEncryption) {
    const privateKey = typeof keyV2 === 'string' ? keyV2 : baseKeyV2
    let keyDataV2 = options.keyDataV2 || ''
    if (!keyDataV2 && !existsSync(privateKey))
      artifactFail(`Cannot find private key ${privateKey}`)
    await hooks.onEncryptV2?.()
    if (!keyDataV2) {
      const keyFile = readFileSync(privateKey)
      keyDataV2 = keyFile.toString()
    }
    // Use V3 encryption for new plugin versions (5.30.0+, 6.30.0+, 7.30.0+)
    const supportsV3Checksum = coerced && !isDeprecatedPluginVersion(coerced, '5.30.0', '6.30.0', '7.30.0')
    log.info(`Encrypting your bundle with ${supportsV3Checksum ? 'V3' : 'V2'}`)
    const { sessionKey: sKey, ivSessionKey: ivKey } = generateSessionKey(keyDataV2)
    const encryptedData = encryptSource(zipped, sKey, ivKey)
    checksum = supportsV3Checksum
      ? encryptChecksumV3(checksum, keyDataV2)
      : encryptChecksum(checksum, keyDataV2)
    ivSessionKey = ivKey
    checksumEncryption = supportsV3Checksum ? 'v3' : 'v2'
    sessionKey = sKey
    encryptionMethod = 'v2'
    finalKeyData = keyDataV2
    // Calculate key_id from the public key in capacitor config
    // This matches the key_id sent by devices for verification
    if (publicKeyFromConfig) {
      keyId = calcKeyId(publicKeyFromConfig)
      if (options.verbose) {
        log.info(`[Verbose] Encryption key_id: ${keyId}`)
      }
    }
    if (options.displayIvSession) {
      log.info(`Your Iv Session key is ${ivSessionKey},
    keep it safe, you will need it to decrypt your bundle.
    It will be also visible in your dashboard\n`)
    }
    zipped = encryptedData
  }
  return { zipped, ivSessionKey, sessionKey, checksum, checksumAlgorithm, checksumEncryption, encryptionMethod, finalKeyData, keyId, updaterVersion, updaterPackageName }
}

type LocalDependencies = Awaited<ReturnType<typeof getLocalDependencies>>

/** native_packages payload stored on the bundle (same shape `bundle upload` sends). */
export function buildNativePackagesPayload(localDependencies: LocalDependencies | undefined, ignoreMetadataCheck?: boolean) {
  const hashedLocalDependencies = localDependencies
    ? new Map(localDependencies
        .filter(a => !!a.native && a.native !== undefined)
        .map(a => [a.name, a]))
    : new Map()

  const nativePackages = (hashedLocalDependencies.size > 0 || !ignoreMetadataCheck)
    ? Array.from(hashedLocalDependencies, ([name, value]) => ({
        name,
        version: value.version,
        requested_version: value.requested_version,
        ...(value.ios_checksum && { ios_checksum: value.ios_checksum }),
        ...(value.android_checksum && { android_checksum: value.android_checksum }),
      }))
    : undefined

  return nativePackages
}

/**
 * Resolve delta (manifest) encryption exactly like `bundle upload`: folds the
 * deprecated --encrypt-partial alias into options.encryptDelta, refuses explicit
 * delta encryption without v2, auto-enables it for updater >= 6.14.4 and picks
 * the hex (V3) checksum format when the updater supports it.
 */
export async function resolveDeltaEncryptionSettings(options: OptionsUpload, encryptionMethod: 'none' | 'v2' | 'v1'): Promise<{ supportsHexChecksum: boolean }> {
  // --encrypt-partial is the deprecated alias of --encrypt-delta
  options.encryptDelta = options.encryptDelta || options.encryptPartial

  // Never upload delta files unencrypted when encryption was explicitly requested
  if (options.encryptDelta && encryptionMethod !== 'v2')
    artifactFail('You cannot encrypt the delta update if you are not using the v2 encryption method')

  // Check if updater supports hex checksum format
  let supportsHexChecksum = false

  // Auto-encrypt delta updates for updater versions >= 6.14.4 if encryption method is v2
  if (options.delta && encryptionMethod === 'v2' && !options.encryptDelta) {
    // Check updater version
    const root = findRoot(cwd())
    const updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)
    let coerced
    try {
      coerced = updaterVersion ? parse(updaterVersion) : undefined
    }
    catch {
      coerced = undefined
    }

    if (updaterVersion && coerced && greaterOrEqual(coerced, parse('6.14.4'))) {
      log.info(`Auto-enabling delta update encryption for updater version ${coerced} (>= 6.14.4)`)
      if (options.verbose)
        log.info(`[Verbose] Delta encryption auto-enabled for updater >= 6.14.4`)
      options.encryptDelta = true
    }
  }

  // Check if updater supports hex checksum format (for delta updates with encryption)
  if (options.delta && (options.encryptDelta || encryptionMethod === 'v2')) {
    const root = findRoot(cwd())
    const updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)
    let coerced
    try {
      coerced = updaterVersion ? parse(updaterVersion) : undefined
    }
    catch {
      coerced = undefined
    }

    if (updaterVersion && coerced) {
      // Hex checksum is supported in versions >= 5.30.0, 6.30.0, 7.30.0
      supportsHexChecksum = !isDeprecatedPluginVersion(coerced, HEX_CHECKSUM_MIN_VERSION_V5, HEX_CHECKSUM_MIN_VERSION_V6, HEX_CHECKSUM_MIN_VERSION_V7)

      if (options.verbose && supportsHexChecksum)
        log.info(`[Verbose] Using hex checksum format for updater version ${coerced}`)
    }
  }

  return { supportsHexChecksum }
}
