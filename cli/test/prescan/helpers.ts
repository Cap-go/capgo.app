// test/prescan/helpers.ts
import type { ScanContext } from '../../src/build/prescan/types'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import forge from 'node-forge'

/** Create a temp project dir from a {relativePath: content} map. */
export function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'prescan-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

export function makeCtx(partial: Partial<ScanContext> & { projectDir: string }): ScanContext {
  return { appId: 'com.demo.app', platform: 'ios', hostPlatform: 'darwin', ...partial }
}

export interface MadeP12 {
  base64: string
  password: string
  sha1: string // lowercase hex of the cert
  notAfter: Date
}

function certSha1(cert: forge.pki.Certificate): string {
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const md = forge.md.sha1.create()
  // lgtm[js/weak-cryptographic-algorithm] SHA1 cert thumbprint (test fixture), matches Apple's provisioning-profile identifier — not a security primitive.
  md.update(certDer)
  return md.digest().toHex().toLowerCase()
}

/** DER bytes of a P12's first certificate (for synthesizing JKS entries etc.). */
export function certDerFromP12(p12: MadeP12): Buffer {
  const p12Obj = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(p12.base64)), p12.password)
  const certBag = p12Obj.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]![0]!
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certBag.cert!)).getBytes(), 'binary')
}

/** Self-signed cert + key wrapped in a password-protected P12 (pure node-forge, no binaries). */
export function makeP12(opts: { password?: string, notAfter?: Date, cn?: string } = {}): MadeP12 {
  const password = opts.password ?? 'test-pass'
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: opts.cn ?? 'Apple Distribution: Test' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
  const der = forge.asn1.toDer(p12Asn1).getBytes()
  const base64 = forge.util.encode64(der)

  return { base64, password, sha1: certSha1(cert), notAfter: cert.validity.notAfter }
}

export interface MadeChainP12 {
  base64: string
  password: string
  leafSha1: string
  caSha1: string
}

/**
 * P12 whose cert bags carry a CA cert FIRST and the leaf second (the layout
 * macOS `security export`/Keychain Access can produce), with no localKeyId
 * attributes — exercises openP12's leaf-selection fallbacks.
 */
export function makeChainP12(opts: { password?: string } = {}): MadeChainP12 {
  const password = opts.password ?? 'test-pass'
  const caKeys = forge.pki.rsa.generateKeyPair(1024)
  const caCert = forge.pki.createCertificate()
  caCert.publicKey = caKeys.publicKey
  caCert.serialNumber = '02'
  caCert.validity.notBefore = new Date(Date.now() - 86_400_000)
  caCert.validity.notAfter = new Date(Date.now() + 3650 * 86_400_000)
  const caAttrs = [{ name: 'commonName', value: 'Test Worldwide Developer Relations CA' }]
  caCert.setSubject(caAttrs)
  caCert.setIssuer(caAttrs)
  caCert.setExtensions([{ name: 'basicConstraints', cA: true }])
  caCert.sign(caKeys.privateKey, forge.md.sha256.create())

  const leafKeys = forge.pki.rsa.generateKeyPair(1024)
  const leafCert = forge.pki.createCertificate()
  leafCert.publicKey = leafKeys.publicKey
  leafCert.serialNumber = '03'
  leafCert.validity.notBefore = new Date(Date.now() - 86_400_000)
  leafCert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  leafCert.setSubject([{ name: 'commonName', value: 'Apple Distribution: Test Leaf' }])
  leafCert.setIssuer(caAttrs)
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create())

  // CA deliberately first; generateLocalKeyId=false mimics exports without key/cert pairing attributes
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(leafKeys.privateKey, [caCert, leafCert], password, { algorithm: '3des', generateLocalKeyId: false })
  const base64 = forge.util.encode64(forge.asn1.toDer(p12Asn1).getBytes())
  return { base64, password, leafSha1: certSha1(leafCert), caSha1: certSha1(caCert) }
}

/** Provisioning-profile XML the existing mobileprovision parser accepts (it scans for <?xml..</plist>). */
export function makeProfileXml(opts: {
  bundleId?: string
  teamId?: string
  expiration?: Date
  type?: 'app_store' | 'ad_hoc' | 'development'
  certSha1s?: string[]
} = {}): string {
  const teamId = opts.teamId ?? 'TEAM123456'
  const bundleId = opts.bundleId ?? 'com.demo.app'
  const expiration = (opts.expiration ?? new Date(Date.now() + 30 * 86_400_000)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // profile type markers used by parseMobileprovisionDetailed (deriveProfileType):
  //   app_store: no ProvisionedDevices + no ProvisionsAllDevices
  //   ad_hoc: ProvisionedDevices present (no get-task-allow=true)
  //   development: ProvisionedDevices present + <key>get-task-allow</key><true/>
  const typeBlock = opts.type === 'ad_hoc'
    ? '<key>ProvisionedDevices</key><array><string>0000000000000000000000000000000000000000</string></array>'
    : opts.type === 'development'
      ? '<key>ProvisionedDevices</key><array><string>0000000000000000000000000000000000000000</string></array><key>Entitlements</key><dict><key>get-task-allow</key><true/></dict>'
      : ''
  const certs = (opts.certSha1s ?? []).map(() => '<data>AAAA</data>').join('')
  // DeveloperCertificates carry DER certs; the parser SHA1-hashes them. For tests we instead
  // build the data blocks from real DER when pairing matters — see makeProfileXmlWithCert.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>Test Profile</string>
<key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
<key>TeamIdentifier</key><array><string>${teamId}</string></array>
<key>ExpirationDate</key><date>${expiration}</date>
<key>Entitlements</key><dict>
  <key>application-identifier</key><string>${teamId}.${bundleId}</string>
</dict>
${typeBlock}
<key>DeveloperCertificates</key><array>${certs}</array>
</dict></plist>`
}

/** Profile XML whose DeveloperCertificates contain the actual DER of a makeP12 cert (for pairing tests). */
export function makeProfileXmlWithCert(p12: MadeP12, opts: Parameters<typeof makeProfileXml>[0] = {}): string {
  const b64 = certDerFromP12(p12).toString('base64')
  const xml = makeProfileXml(opts)
  return xml.replace('<key>DeveloperCertificates</key><array></array>', `<key>DeveloperCertificates</key><array><data>${b64}</data></array>`)
}
