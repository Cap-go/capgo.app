// src/build/prescan/checks/ios-certs.ts
import type { Finding, PrescanCheck, ScanContext } from '../types'
import forge from 'node-forge'
import { assertCredentialBlobSize } from './blob-limit'

export interface OpenedP12 {
  cert: forge.pki.Certificate
  sha1: string
}

type CertBag = forge.pkcs12.Bag

const SHA1_OID = '1.3.14.3.2.26'
const PBES2_OID = '1.2.840.113549.1.5.13'
const PBESV1_SHA1_3DES_OID = '1.2.840.113549.1.12.1.3'
const AES_CBC_OIDS = new Set([
  '2.16.840.1.101.3.4.1.2',
  '2.16.840.1.101.3.4.1.22',
  '2.16.840.1.101.3.4.1.42',
])

class MalformedP12Error extends Error {
  constructor() {
    super('malformed PKCS12 ASN.1')
    this.name = 'MalformedP12Error'
  }
}

interface PrivateKeyEncryption {
  algorithmOid: string
  encryptionSchemeOid: string | null
}

function asn1Children(node: forge.asn1.Asn1 | undefined): forge.asn1.Asn1[] {
  return node && Array.isArray(node.value) ? node.value : []
}

function asn1Oid(node: forge.asn1.Asn1 | undefined): string | null {
  if (!node || node.type !== forge.asn1.Type.OID || typeof node.value !== 'string')
    return null
  try {
    return forge.asn1.derToOid(node.value)
  }
  catch {
    return null
  }
}

function privateKeyEncryptionFromSafeBag(node: forge.asn1.Asn1): PrivateKeyEncryption | null {
  const bag = asn1Children(node)
  if (asn1Oid(bag[0]) !== forge.pki.oids.pkcs8ShroudedKeyBag)
    return null
  const encryptedPrivateKeyInfo = asn1Children(bag[1])[0]
  const algorithmIdentifier = asn1Children(encryptedPrivateKeyInfo)[0]
  const algorithm = asn1Children(algorithmIdentifier)
  const algorithmOid = asn1Oid(algorithm[0])
  if (!algorithmOid)
    return null
  const pbes2Params = asn1Children(algorithm[1])
  const encryptionScheme = asn1Children(pbes2Params[1])
  return { algorithmOid, encryptionSchemeOid: asn1Oid(encryptionScheme[0]) }
}

function collectPrivateKeyEncryptions(node: forge.asn1.Asn1, result: PrivateKeyEncryption[], depth = 0): void {
  if (depth > 32)
    return
  const encryption = privateKeyEncryptionFromSafeBag(node)
  if (encryption) {
    result.push(encryption)
    return // Never interpret encrypted private-key bytes as nested ASN.1.
  }
  if (Array.isArray(node.value)) {
    for (const child of node.value)
      collectPrivateKeyEncryptions(child, result, depth + 1)
  }
  else if (node.type === forge.asn1.Type.OCTETSTRING && node.value.length > 0) {
    try {
      collectPrivateKeyEncryptions(forge.asn1.fromDer(node.value), result, depth + 1)
    }
    catch {
      // Most OCTET STRING values are encrypted bytes or certificate fields,
      // not nested ASN.1. Only descend when forge can decode the whole value.
    }
  }
}

function p12MacAlgorithm(pfx: forge.asn1.Asn1): string | null {
  if (!Array.isArray(pfx.value))
    return null
  const macData = pfx.value[2]
  if (!macData || !Array.isArray(macData.value))
    return null
  const digestInfo = macData.value[0]
  if (!digestInfo || !Array.isArray(digestInfo.value))
    return null
  const algorithmIdentifier = digestInfo.value[0]
  if (!algorithmIdentifier || !Array.isArray(algorithmIdentifier.value))
    return null
  return asn1Oid(algorithmIdentifier.value[0])
}

function parseP12Asn1(base64: string): forge.asn1.Asn1 {
  try {
    return forge.asn1.fromDer(forge.util.decode64(base64))
  }
  catch {
    throw new MalformedP12Error()
  }
}

function legacyP12CompatibilityProblems(base64: string): string[] {
  assertCredentialBlobSize(base64, 'certificate')
  const pfx = parseP12Asn1(base64)
  const privateKeyEncryptions: PrivateKeyEncryption[] = []
  collectPrivateKeyEncryptions(pfx, privateKeyEncryptions)

  const problems = new Set<string>()
  const macAlgorithm = p12MacAlgorithm(pfx)
  if (macAlgorithm !== SHA1_OID)
    problems.add(macAlgorithm === forge.pki.oids.sha256 ? 'SHA-256 MAC' : 'non-SHA-1 MAC')
  if (privateKeyEncryptions.length === 0) {
    problems.add('missing PBESv1 SHA-1/3DES private-key encryption')
  }
  for (const encryption of privateKeyEncryptions) {
    if (encryption.algorithmOid === PBESV1_SHA1_3DES_OID)
      continue
    if (encryption.algorithmOid === PBES2_OID) {
      problems.add(AES_CBC_OIDS.has(encryption.encryptionSchemeOid ?? '')
        ? 'PBES2/AES private-key encryption'
        : 'PBES2 private-key encryption')
    }
    else {
      problems.add('unsupported private-key encryption')
    }
  }
  return [...problems]
}

function bagLocalKeyIdHex(bag: CertBag): string | null {
  const attr = (bag.attributes as Record<string, unknown[]> | undefined)?.localKeyId?.[0]
  return typeof attr === 'string' ? forge.util.bytesToHex(attr) : null
}

/**
 * Pick the signing (leaf) certificate from a P12 that may also carry CA chain
 * certs (Keychain Access / Windows exports often include the Apple WWDR
 * intermediate, and bag order is NOT guaranteed to put the leaf first):
 * 1. the cert bag whose localKeyId matches a key bag's localKeyId,
 * 2. else the first cert that is not a CA (basicConstraints),
 * 3. else bags[0].
 */
function pickLeafCert(p12: forge.pkcs12.Pkcs12Pfx, bags: CertBag[]): forge.pki.Certificate | undefined {
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ]
  const keyIds = new Set(keyBags.map(b => bagLocalKeyIdHex(b as CertBag)).filter((id): id is string => id !== null))
  if (keyIds.size > 0) {
    const paired = bags.find((b) => {
      const id = bagLocalKeyIdHex(b)
      return id !== null && keyIds.has(id)
    })
    if (paired?.cert)
      return paired.cert
  }
  const nonCa = bags.find((b) => {
    if (!b.cert)
      return false
    const bc = b.cert.getExtension('basicConstraints') as { cA?: boolean } | null
    return !bc?.cA
  })
  if (nonCa?.cert)
    return nonCa.cert
  return bags[0]?.cert
}

// A scan opens the same P12 up to three times (p12-opens, p12-expiry,
// cert-profile-pairing) and the PKCS12 KDF is expensive — memoize per input.
const P12_CACHE_MAX = 4
const p12Cache = new Map<string, { value?: OpenedP12, error?: unknown }>()

/** Open the saved P12; throws on wrong password / garbage. Exported for reuse by pairing check. */
export function openP12(base64: string, password: string): OpenedP12 {
  const cacheKey = `${password}\u0000${base64}`
  const cached = p12Cache.get(cacheKey)
  if (cached) {
    if (cached.error !== undefined)
      throw cached.error
    return cached.value!
  }
  try {
    const value = openP12Uncached(base64, password)
    remember(cacheKey, { value })
    return value
  }
  catch (error) {
    remember(cacheKey, { error })
    throw error
  }
}

function remember(key: string, entry: { value?: OpenedP12, error?: unknown }): void {
  if (p12Cache.size >= P12_CACHE_MAX)
    p12Cache.delete(p12Cache.keys().next().value!)
  p12Cache.set(key, entry)
}

function openP12Uncached(base64: string, password: string): OpenedP12 {
  assertCredentialBlobSize(base64, 'certificate')
  const der = forge.util.decode64(base64)
  const asn1 = forge.asn1.fromDer(der)
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password)
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
  const cert = pickLeafCert(p12, bags)
  if (!cert)
    throw new Error('no certificate inside the P12')
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const md = forge.md.sha1.create()
  // lgtm[js/weak-cryptographic-algorithm] SHA1 is the certificate thumbprint Apple stores in provisioning profiles (the cert↔profile pairing identifier), not a security primitive.
  md.update(certDer)
  return { cert, sha1: md.digest().toHex().toLowerCase() }
}

const has = (ctx: ScanContext, key: string) => Boolean(ctx.credentials?.[key])

export const p12Opens: PrescanCheck = {
  id: 'ios/p12-opens',
  platforms: ['ios'],
  appliesTo: ctx => has(ctx, 'BUILD_CERTIFICATE_BASE64'),
  async run(ctx): Promise<Finding[]> {
    try {
      openP12(ctx.credentials!.BUILD_CERTIFICATE_BASE64, ctx.credentials!.P12_PASSWORD ?? '')
      return []
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isMac = /mac|hmac|password|invalid/i.test(msg)
      return [{
        id: 'ios/p12-opens',
        severity: 'error',
        title: isMac ? 'The P12 certificate cannot be opened with the saved password' : 'The saved certificate is not a valid P12 file',
        detail: msg,
        fix: 'Re-export the .p12 and re-run `build credentials save` with the correct --p12-password',
      }]
    }
  },
}

export const p12LegacyEncryption: PrescanCheck = {
  id: 'ios/p12-legacy-encryption',
  platforms: ['ios'],
  appliesTo: ctx => has(ctx, 'BUILD_CERTIFICATE_BASE64'),
  async run(ctx): Promise<Finding[]> {
    let problems: string[]
    try {
      problems = legacyP12CompatibilityProblems(ctx.credentials!.BUILD_CERTIFICATE_BASE64)
    }
    catch (error) {
      if (error instanceof MalformedP12Error)
        return [] // p12-opens owns malformed/invalid P12 failures
      throw error
    }
    if (problems.length === 0)
      return []
    return [{
      id: 'ios/p12-legacy-encryption',
      severity: 'error',
      title: 'The P12 certificate uses encryption that the macOS build runner cannot import',
      detail: `Detected ${problems.join(' and ')}. Fastlane security import may report a wrong password even when the password is correct.`,
      fix: 'Re-export the .p12 with PBESv1 SHA-1/3DES encryption and a SHA-1 MAC, then re-run `build credentials save`.',
    }]
  },
}

const THIRTY_DAYS_MS = 30 * 86_400_000

export const p12Expiry: PrescanCheck = {
  id: 'ios/p12-expiry',
  platforms: ['ios'],
  appliesTo: ctx => has(ctx, 'BUILD_CERTIFICATE_BASE64'),
  async run(ctx): Promise<Finding[]> {
    let opened: OpenedP12
    try {
      opened = openP12(ctx.credentials!.BUILD_CERTIFICATE_BASE64, ctx.credentials!.P12_PASSWORD ?? '')
    }
    catch {
      return [] // p12-opens owns that failure
    }
    const notAfter = opened.cert.validity.notAfter
    const left = notAfter.getTime() - Date.now()
    if (left <= 0) {
      return [{
        id: 'ios/p12-expiry',
        severity: 'error',
        title: `Signing certificate expired on ${notAfter.toISOString().slice(0, 10)}`,
        fix: 'Create a new distribution certificate in the Apple Developer portal and re-save credentials',
      }]
    }
    if (left < THIRTY_DAYS_MS) {
      return [{
        id: 'ios/p12-expiry',
        severity: 'warning',
        title: `Signing certificate expires in ${Math.ceil(left / 86_400_000)} day(s) (${notAfter.toISOString().slice(0, 10)})`,
        fix: 'Renew it soon to avoid build interruptions',
      }]
    }
    return []
  },
}

const KEY_ID_RE = /^[A-Z0-9]{10}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ascKeyValid: PrescanCheck = {
  id: 'ios/asc-key-valid',
  platforms: ['ios'],
  appliesTo: ctx => has(ctx, 'APPLE_KEY_CONTENT') || has(ctx, 'APPLE_KEY_ID') || has(ctx, 'APPLE_ISSUER_ID'),
  async run(ctx): Promise<Finding[]> {
    const findings: Finding[] = []
    const { APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_KEY_CONTENT } = ctx.credentials ?? {}
    // NEVER echo the raw values: this branch fires exactly when the user pasted the
    // wrong thing into the field (possibly a password or the .p8 key content), and
    // finding text ends up in terminals, CI logs, and --json artifacts.
    if (APPLE_KEY_ID && !KEY_ID_RE.test(APPLE_KEY_ID))
      findings.push({ id: 'ios/asc-key-valid', severity: 'error', title: 'APPLE_KEY_ID is not a 10-char App Store Connect key ID', detail: `got a ${APPLE_KEY_ID.length}-char value (expected 10 uppercase letters/digits)` })
    if (APPLE_ISSUER_ID && !UUID_RE.test(APPLE_ISSUER_ID))
      findings.push({ id: 'ios/asc-key-valid', severity: 'error', title: 'APPLE_ISSUER_ID is not a UUID', detail: `got a ${APPLE_ISSUER_ID.length}-char value (expected a UUID like 12345678-1234-1234-1234-123456789012)`, fix: 'Copy the Issuer ID from App Store Connect → Users and Access → Integrations' })
    if (APPLE_KEY_CONTENT) {
      let pem = ''
      try {
        pem = forge.util.decode64(APPLE_KEY_CONTENT)
      }
      catch { /* fallthrough */ }
      if (!pem.includes('-----BEGIN PRIVATE KEY-----'))
        findings.push({ id: 'ios/asc-key-valid', severity: 'error', title: 'APPLE_KEY_CONTENT does not decode to a .p8 private key PEM', fix: 'Base64-encode the raw AuthKey_XXXX.p8 file content' })
    }
    return findings
  },
}
