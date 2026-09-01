import type { BundleEncryptOptions, EncryptResult } from '../schemas/bundle'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { parse } from '@std/semver'
import { trackEvent } from '../analytics/track'
import { encryptChecksum, encryptChecksumV3, encryptSource, generateSessionKey } from '../api/crypto'
import { checkAlerts } from '../api/update'
import { ensurePublicKeyFromPrivateKey, ensurePublicKeyInConfig } from '../recovery/public-key'
import { CliUserError } from '../shared/cli-user-error'
import { baseKeyV2, canPromptInteractively, findRoot, formatError, getConfigForWrite, getInstalledVersion, isDeprecatedPluginVersion } from '../utils'
import { requireChecksum, requireExistingZipPath, requireZipPath } from './validate-inputs'

export type { EncryptResult } from '../schemas/bundle'

// Minimum versions that support hex checksum format (V3)
const HEX_CHECKSUM_MIN_VERSION_V5 = '5.30.0'
const HEX_CHECKSUM_MIN_VERSION_V6 = '6.30.0'
const HEX_CHECKSUM_MIN_VERSION_V7 = '7.30.0'

function emitJsonError(error: unknown) {
  console.error(formatError(error))
}

function emitCliUserJsonError(error: CliUserError) {
  if (/^Zip not found at /i.test(error.message)) {
    emitJsonError({ error: 'zip_not_found', message: error.message })
    return
  }
  emitJsonError({ error: error.message })
}

export async function encryptZipInternal(
  zipPath: string,
  checksum: string,
  options: BundleEncryptOptions,
  silent = false,
): Promise<EncryptResult> {
  const { json } = options
  const shouldShowPrompts = !json && !silent

  if (shouldShowPrompts) {
    intro('Encryption')
    await checkAlerts()
  }

  try {
    requireZipPath(zipPath)
    checksum = requireChecksum(checksum)
    requireExistingZipPath(zipPath)

    const interactive = canPromptInteractively({ silent: json || silent })
    const userSuppliedPrivateKey = options.keyData !== undefined || options.key !== undefined
    const keyPath = options.key || baseKeyV2
    let privateKey = options.keyData || ''
    if (!privateKey && existsSync(keyPath))
      privateKey = readFileSync(keyPath, 'utf8')

    let extConfig = await getConfigForWrite()
    const hasPublicKeyInConfig = !!extConfig.config.plugins?.CapacitorUpdater?.publicKey

    if (!hasPublicKeyInConfig) {
      if (privateKey) {
        await ensurePublicKeyFromPrivateKey(privateKey, { silent: silent || json, json })
      }
      else if (!userSuppliedPrivateKey) {
        try {
          await ensurePublicKeyInConfig({ interactive, silent: silent || json, json })
        }
        catch (error) {
          if (!interactive && error instanceof Error)
            throw new CliUserError(error.message)
          throw error
        }
      }
      extConfig = await getConfigForWrite()
    }

    if (!privateKey && existsSync(keyPath))
      privateKey = readFileSync(keyPath, 'utf8')

    const hasPrivateKeyInConfig = !!extConfig.config.plugins?.CapacitorUpdater?.privateKey
    const refreshedHasPublicKey = !!extConfig.config.plugins?.CapacitorUpdater?.publicKey

    if (hasPrivateKeyInConfig && shouldShowPrompts)
      log.warning('There is still a privateKey in the config')

    if (!refreshedHasPublicKey && !(userSuppliedPrivateKey && !privateKey)) {
      if (!silent) {
        if (json)
          emitJsonError({ error: 'missing_public_key' })
        else
          log.warning('Warning: Missing Public Key in config')
      }
      throw new CliUserError('Missing public key in config')
    }

    if (!privateKey) {
      if (!silent) {
        if (json) {
          emitJsonError({ error: 'missing_key' })
        }
        else {
          log.warning(`Cannot find a private key at ${keyPath} or as a keyData option`)
          log.error('Error: Missing key')
        }
      }
      throw new Error('Missing private key')
    }

    if (privateKey && !privateKey.startsWith('-----BEGIN RSA PRIVATE KEY-----')) {
      if (!silent) {
        if (json)
          emitJsonError({ error: 'invalid_private_key' })
        else
          log.error('The private key provided is not a valid RSA Private key')
      }
      throw new Error('Invalid private key format')
    }

    const zipFile = readFileSync(zipPath)
    const { sessionKey, ivSessionKey } = generateSessionKey(privateKey)
    const encryptedData = encryptSource(zipFile, sessionKey, ivSessionKey)

    // Determine which checksum encryption to use based on updater version
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
      // Use V3 encryption for new plugin versions (5.30.0+, 6.30.0+, 7.30.0+)
      supportsV3Checksum = !isDeprecatedPluginVersion(coerced, HEX_CHECKSUM_MIN_VERSION_V5, HEX_CHECKSUM_MIN_VERSION_V6, HEX_CHECKSUM_MIN_VERSION_V7)
    }

    const encodedChecksum = supportsV3Checksum
      ? encryptChecksumV3(checksum, privateKey)
      : encryptChecksum(checksum, privateKey)

    if (shouldShowPrompts) {
      log.info(`Encrypting checksum with ${supportsV3Checksum ? 'V3' : 'V2'} (based on updater version ${updaterVersion || 'unknown'})`)
    }

    const filenameEncrypted = `${zipPath}_encrypted.zip`

    writeFileSync(filenameEncrypted, encryptedData)

    void trackEvent({ channel: 'bundle', event: 'Bundle Encrypted', tags: {} })

    if (!silent) {
      if (json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          checksum: encodedChecksum,
          filename: filenameEncrypted,
          ivSessionKey,
        }, null, 2))
      }
      else {
        log.success(`Encoded Checksum: ${encodedChecksum}`)
        log.success(`ivSessionKey: ${ivSessionKey}`)
        log.success(`Encrypted zip saved at ${filenameEncrypted}`)
        outro('Done ✅')
      }
    }

    return {
      checksum: encodedChecksum,
      filename: filenameEncrypted,
      ivSessionKey,
    }
  }
  catch (error) {
    if (error instanceof CliUserError) {
      if (!silent) {
        if (options.json)
          emitCliUserJsonError(error)
        else
          log.error(`Error: ${error.message}`)
      }
      throw error
    }

    if (!silent) {
      if (options.json)
        emitJsonError(error)
      else
        log.error(`Error encrypting zip file ${formatError(error)}`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function encryptZip(zipPath: string, checksum: string, options: BundleEncryptOptions) {
  await encryptZipInternal(zipPath, checksum, options, false)
}
