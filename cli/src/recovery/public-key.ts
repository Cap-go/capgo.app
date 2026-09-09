import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { intro, log } from '@clack/prompts'
import { derivePublicKeyFromPrivate } from '../api/crypto'
import { trackEvent } from '../analytics/track'
import { createKeyInternal, saveKeyInternal } from '../key'
import { baseKeyPubV2, baseKeyV2, getConfigForWrite } from '../utils'

export interface EnsurePublicKeyOptions {
  interactive?: boolean
  silent?: boolean
  json?: boolean
}

function buildCiPublicKeyMessage() {
  return [
    'Missing public key in config.',
    'Generate encryption keys with: npx @capgo/cli@latest key create',
    'Then save the public key into capacitor config with: npx @capgo/cli@latest key save',
    'Or rerun this command interactively to generate keys automatically.',
  ].join('\n')
}

async function saveDerivedPublicKeyFromPrivate(privateKeyPath: string, silent: boolean) {
  const privateKey = readFileSync(privateKeyPath, 'utf8')
  if (!privateKey.startsWith('-----BEGIN RSA PRIVATE KEY-----'))
    throw new Error('Invalid private key format')

  const publicKey = derivePublicKeyFromPrivate(privateKey)
  writeFileSync(baseKeyPubV2, publicKey)
  if (!silent)
    log.info(`Derived public key from ${privateKeyPath} and saved it to ${baseKeyPubV2}.`)
  await saveKeyInternal({ keyData: publicKey }, true)
}

export async function ensurePublicKeyInConfig(options: EnsurePublicKeyOptions = {}): Promise<void> {
  const { interactive = false, silent = false, json = false } = options
  const extConfig = await getConfigForWrite()
  const hasPublicKey = !!extConfig.config.plugins?.CapacitorUpdater?.publicKey

  if (hasPublicKey)
    return

  if (!interactive) {
    if (json)
      throw new Error('missing_public_key')
    throw new Error(buildCiPublicKeyMessage())
  }

  if (!silent)
    intro('Encryption keys')

  log.warn('CapacitorUpdater.publicKey is missing from your capacitor config.')

  if (existsSync(baseKeyPubV2)) {
    log.info(`Found existing public key at ${baseKeyPubV2}. Saving it into capacitor config.`)
    await saveKeyInternal({}, true)
  }
  else if (existsSync(baseKeyV2)) {
    log.info(`Found existing private key at ${baseKeyV2}. Deriving the matching public key.`)
    await saveDerivedPublicKeyFromPrivate(baseKeyV2, silent)
  }
  else {
    log.info('Capgo can generate an RSA keypair, save the public key in capacitor config, and keep the private key in .capgo_key_v2.')
    await createKeyInternal({ force: false, setupChannel: false }, true, extConfig)
  }

  const refreshed = await getConfigForWrite()
  if (!refreshed.config.plugins?.CapacitorUpdater?.publicKey) {
    if (json)
      throw new Error('missing_public_key')
    throw new Error('Failed to write public key into capacitor config')
  }

  if (!silent) {
    log.success('Encryption keys generated and public key saved to capacitor config')
    log.info('Run `npx cap sync` before shipping a native build so devices bundle the public key.')
  }

  void trackEvent({ channel: 'key', event: 'CLI Recovered Missing Public Key', tags: {} })
}

export async function ensurePublicKeyFromPrivateKey(
  privateKeyPem: string,
  options: Pick<EnsurePublicKeyOptions, 'silent' | 'json'> = {},
): Promise<void> {
  const { silent = false, json = false } = options
  const extConfig = await getConfigForWrite()
  if (extConfig.config.plugins?.CapacitorUpdater?.publicKey)
    return

  if (!privateKeyPem.startsWith('-----BEGIN RSA PRIVATE KEY-----')) {
    if (json)
      throw new Error('invalid_private_key')
    throw new Error('Invalid private key format')
  }

  const publicKey = derivePublicKeyFromPrivate(privateKeyPem)
  await saveKeyInternal({ keyData: publicKey }, silent || json)

  const refreshed = await getConfigForWrite()
  if (!refreshed.config.plugins?.CapacitorUpdater?.publicKey) {
    if (json)
      throw new Error('missing_public_key')
    throw new Error('Failed to write public key into capacitor config')
  }

  void trackEvent({ channel: 'key', event: 'CLI Recovered Missing Public Key', tags: { recovery: 'derived-from-private' } })
}
