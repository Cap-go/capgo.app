import type { BundleDecryptOptions, DecryptResult } from '../schemas/bundle'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { parse } from '@std/semver'
import { trackEvent } from '../analytics/track'
import { decryptChecksum, decryptChecksumV3, decryptSource } from '../api/crypto'
import { checkAlerts } from '../api/update'
import { getChecksum } from '../checksum'
import { CliUserError } from '../shared/cli-user-error'
import { baseKeyPubV2, findRoot, formatError, getConfig, getInstalledVersion, isDeprecatedPluginVersion } from '../utils'
import { requireExistingZipPath, requireIvSessionKey, requireZipPath } from './validate-inputs'

export type { DecryptResult } from '../schemas/bundle'

// Minimum versions that support hex checksum format (V3)
const HEX_CHECKSUM_MIN_VERSION_V5 = '5.30.0'
const HEX_CHECKSUM_MIN_VERSION_V6 = '6.30.0'
const HEX_CHECKSUM_MIN_VERSION_V7 = '7.30.0'

function resolvePublicKey(options: BundleDecryptOptions, extConfig: Awaited<ReturnType<typeof getConfig>>) {
  const fallbackKeyPath = options.key || baseKeyPubV2
  let publicKey = extConfig.config.plugins?.CapacitorUpdater?.publicKey

  if (existsSync(fallbackKeyPath)) {
    publicKey = readFileSync(fallbackKeyPath, 'utf8')
  }
  else if (!publicKey && options.keyData) {
    publicKey = options.keyData
  }

  return { publicKey, fallbackKeyPath }
}

function toIvSessionKeyDecryptError(error: unknown): CliUserError | null {
  if (!(error instanceof Error))
    return null
  if (/RSA routines/i.test(error.message)) {
    return new CliUserError('Invalid ivSessionKey. The session key could not be decrypted with your public key.')
  }
  return null
}

export async function decryptZipInternal(
  zipPath: string,
  ivsessionKey: string,
  options: BundleDecryptOptions,
  silent = false,
): Promise<DecryptResult> {
  if (!silent)
    intro('Decrypt zip file')

  try {
    requireZipPath(zipPath)
    requireIvSessionKey(ivsessionKey)
    requireExistingZipPath(zipPath)

    if (!silent)
      await checkAlerts()

    const extConfig = await getConfig()

    if (!options.key && !existsSync(baseKeyPubV2) && !extConfig.config.plugins?.CapacitorUpdater?.publicKey) {
      const message = `Public Key not found at the path ${baseKeyPubV2} or in ${extConfig.path}`
      if (!silent)
        log.error(message)
      throw new Error(message)
    }

    const { publicKey, fallbackKeyPath } = resolvePublicKey(options, extConfig)

    if (!publicKey) {
      const message = `Cannot find public key ${fallbackKeyPath} or as keyData option or in ${extConfig.path}`
      if (!silent)
        log.error(message)
      throw new Error(message)
    }

    const zipFile = readFileSync(zipPath)

    let decodedZip: Buffer
    try {
      decodedZip = decryptSource(zipFile, ivsessionKey, options.keyData ?? publicKey)
    }
    catch (error) {
      const ivSessionKeyError = toIvSessionKeyDecryptError(error)
      if (ivSessionKeyError)
        throw ivSessionKeyError
      throw error
    }
    const outputPath = `${zipPath}_decrypted.zip`
    writeFileSync(outputPath, decodedZip)

    if (!silent)
      log.info(`Decrypted zip file at ${outputPath}`)

    let checksumMatches: boolean | undefined

    if (options.checksum) {
      const checksum = await getChecksum(decodedZip, 'sha256')

      // Determine which checksum decryption to use based on updater version
      const root = findRoot(cwd())
      const updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)
      let supportsV3Checksum = false
      let coerced
      try {
        coerced = updaterVersion ? parse(updaterVersion) : undefined
      }
      catch {
        coerced = undefined
      }

      if (coerced) {
        // Use V3 decryption for new plugin versions (5.30.0+, 6.30.0+, 7.30.0+)
        supportsV3Checksum = !isDeprecatedPluginVersion(coerced, HEX_CHECKSUM_MIN_VERSION_V5, HEX_CHECKSUM_MIN_VERSION_V6, HEX_CHECKSUM_MIN_VERSION_V7)
      }

      if (!silent)
        log.info(`Decrypting checksum with ${supportsV3Checksum ? 'V3' : 'V2'} (based on updater version ${updaterVersion || 'unknown'})`)

      const decryptedChecksum = supportsV3Checksum
        ? decryptChecksumV3(options.checksum, options.keyData ?? publicKey)
        : decryptChecksum(options.checksum, options.keyData ?? publicKey)
      checksumMatches = checksum === decryptedChecksum

      if (!checksumMatches) {
        const message = `Checksum does not match ${checksum} !== ${decryptedChecksum}`
        if (!silent)
          log.error(message)
        throw new Error(message)
      }

      if (!silent)
        log.info('Checksum matches')
    }

    void trackEvent({ channel: 'bundle', event: 'Bundle Decrypted', tags: {} })

    if (!silent)
      outro('✅ done')

    return { outputPath, checksumMatches }
  }
  catch (error) {
    if (error instanceof CliUserError) {
      if (!silent)
        log.error(`Error: ${error.message}`)
      throw error
    }

    if (!silent)
      log.error(`Error decrypting zip file ${formatError(error)}`)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function decryptZip(zipPath: string, ivsessionKey: string, options: BundleDecryptOptions) {
  await decryptZipInternal(zipPath, ivsessionKey, options, false)
}
