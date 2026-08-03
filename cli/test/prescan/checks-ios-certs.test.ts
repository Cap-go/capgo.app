// test/prescan/checks-ios-certs.test.ts
import { describe, expect, it } from 'bun:test'
import forge from 'node-forge'
import { MAX_CREDENTIAL_B64_CHARS } from '../../src/build/prescan/checks/blob-limit'
import { ascKeyValid, openP12, p12Expiry, p12LegacyEncryption, p12Opens } from '../../src/build/prescan/checks/ios-certs'
import { makeChainP12, makeCtx, makeP12 } from './helpers'

function ctxWith(creds: Record<string, string>) {
  return makeCtx({ projectDir: '/tmp', platform: 'ios', credentials: creds })
}

function asn1Children(node: forge.asn1.Asn1): forge.asn1.Asn1[] {
  return Array.isArray(node.value) ? node.value : []
}

function asn1Oid(node: forge.asn1.Asn1 | undefined): string | null {
  if (!node || node.type !== forge.asn1.Type.OID || typeof node.value !== 'string')
    return null
  return forge.asn1.derToOid(node.value)
}

function mutateSafeBag(root: forge.asn1.Asn1, bagOid: string, mutate: (bag: forge.asn1.Asn1) => void): boolean {
  const children = asn1Children(root)
  if (asn1Oid(children[0]) === bagOid) {
    mutate(root)
    return true
  }
  for (const child of children) {
    if (mutateSafeBag(child, bagOid, mutate))
      return true
  }
  if (root.type === forge.asn1.Type.OCTETSTRING && typeof root.value === 'string') {
    try {
      const nested = forge.asn1.fromDer(root.value)
      if (mutateSafeBag(nested, bagOid, mutate)) {
        root.value = forge.asn1.toDer(nested).getBytes()
        return true
      }
    }
    catch {
      // Encrypted and certificate OCTET STRING values are not nested ASN.1.
    }
  }
  return false
}

function mutatePrivateKeyEncryption(
  base64: string,
  algorithmOid: string,
  encryptionSchemeOid?: string,
  unrelatedLegacyOidInCertBag = false,
): string {
  const pfx = forge.asn1.fromDer(forge.util.decode64(base64))
  const foundKeyBag = mutateSafeBag(pfx, forge.pki.oids.pkcs8ShroudedKeyBag, (keyBag) => {
    const encryptedPrivateKeyInfo = asn1Children(asn1Children(keyBag)[1]!)[0]!
    const algorithmIdentifier = asn1Children(encryptedPrivateKeyInfo)[0]!
    const algorithm = asn1Children(algorithmIdentifier)
    algorithm[0]!.value = forge.asn1.oidToDer(algorithmOid).getBytes()
    if (encryptionSchemeOid) {
      const pbes2Params = asn1Children(algorithm[1]!)
      const encryptionScheme = asn1Children(pbes2Params[1]!)
      encryptionScheme[0]!.value = forge.asn1.oidToDer(encryptionSchemeOid).getBytes()
    }
  })
  if (!foundKeyBag)
    throw new Error('fixture has no shrouded private-key bag')
  if (unrelatedLegacyOidInCertBag) {
    const foundCertBag = mutateSafeBag(pfx, forge.pki.oids.certBag, (certBag) => {
      const attributes = asn1Children(certBag)[2]!
      asn1Children(attributes).push(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer('1.2.840.113549.1.12.1.3').getBytes()),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, []),
      ]))
    })
    if (!foundCertBag)
      throw new Error('fixture has no certificate bag')
  }
  return forge.util.encode64(forge.asn1.toDer(pfx).getBytes())
}

describe('ios/p12-opens', () => {
  it('errors on wrong password', async () => {
    const p12 = makeP12({ password: 'right' })
    const f = await p12Opens.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: 'wrong' }))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('password')
  })
  it('passes with the right password', async () => {
    const p12 = makeP12({ password: 'right' })
    expect(await p12Opens.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: 'right' }))).toEqual([])
  })
  it('errors on garbage base64', async () => {
    const f = await p12Opens.run(ctxWith({ BUILD_CERTIFICATE_BASE64: 'not-a-p12', P12_PASSWORD: '' }))
    expect(f[0]?.severity).toBe('error')
  })
})

describe('ios/p12-legacy-encryption', () => {
  it('passes legacy PBESv1 3DES with a SHA-1 MAC', async () => {
    const p12 = makeP12()
    expect(await p12LegacyEncryption.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))).toEqual([])
  })

  it('errors on PBES2 AES encryption even though the password is valid', async () => {
    const p12 = makeP12({ algorithm: 'aes256' })
    expect(await p12Opens.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))).toEqual([])

    const findings = await p12LegacyEncryption.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.title).toContain('macOS build runner')
    expect(findings[0]?.detail).toContain('PBES2/AES')
    expect(findings[0]?.fix).toContain('PBESv1 SHA-1/3DES')
  })

  it('identifies a non-AES PBES2 private-key scheme without calling it AES', async () => {
    const p12 = makeP12({ algorithm: 'aes256' })
    const base64 = mutatePrivateKeyEncryption(p12.base64, '1.2.840.113549.1.5.13', '1.2.840.113549.3.2')

    const findings = await p12LegacyEncryption.run(ctxWith({ BUILD_CERTIFICATE_BASE64: base64, P12_PASSWORD: p12.password }))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('PBES2 private-key encryption')
    expect(findings[0]?.detail).not.toContain('PBES2/AES')
  })

  it('does not let a legacy OID in a certificate bag hide incompatible private-key encryption', async () => {
    const p12 = makeP12({ algorithm: '3des' })
    const base64 = mutatePrivateKeyEncryption(p12.base64, '1.2.3.4', undefined, true)

    const findings = await p12LegacyEncryption.run(ctxWith({ BUILD_CERTIFICATE_BASE64: base64, P12_PASSWORD: p12.password }))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('unsupported private-key encryption')
  })

  it('errors on a SHA-256 MAC even when private-key encryption is legacy 3DES', async () => {
    const p12 = makeP12({ macAlgorithm: 'sha256' })
    expect(await p12Opens.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))).toEqual([])

    const findings = await p12LegacyEncryption.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('SHA-256 MAC')
  })

  it('defers malformed files to ios/p12-opens instead of duplicating its error', async () => {
    expect(await p12LegacyEncryption.run(ctxWith({ BUILD_CERTIFICATE_BASE64: 'not-a-p12', P12_PASSWORD: '' }))).toEqual([])
  })

  it('does not suppress non-parsing failures', async () => {
    const huge = 'A'.repeat(MAX_CREDENTIAL_B64_CHARS + 1)
    await expect(p12LegacyEncryption.run(ctxWith({ BUILD_CERTIFICATE_BASE64: huge, P12_PASSWORD: '' }))).rejects.toThrow('limit 10 MB')
  })
})

describe('ios/p12-expiry', () => {
  it('errors when expired', async () => {
    const p12 = makeP12({ notAfter: new Date(Date.now() - 86_400_000) })
    const f = await p12Expiry.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))
    expect(f[0]?.severity).toBe('error')
  })
  it('warns when expiring within 30 days', async () => {
    const p12 = makeP12({ notAfter: new Date(Date.now() + 10 * 86_400_000) })
    const f = await p12Expiry.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))
    expect(f[0]?.severity).toBe('warning')
  })
  it('passes when far from expiry', async () => {
    const p12 = makeP12()
    expect(await p12Expiry.run(ctxWith({ BUILD_CERTIFICATE_BASE64: p12.base64, P12_PASSWORD: p12.password }))).toEqual([])
  })
})

describe('ios/asc-key-valid', () => {
  const goodP8 = () => {
    // minimal PEM-looking p8; format check only (full EC parse is out of scope for forge)
    const pem = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n'
    return forge.util.encode64(pem)
  }
  it('passes with plausible key id, issuer uuid, and p8 pem', async () => {
    const f = await ascKeyValid.run(ctxWith({
      APPLE_KEY_ID: 'ABCDE12345',
      APPLE_ISSUER_ID: '12345678-1234-1234-1234-123456789012',
      APPLE_KEY_CONTENT: goodP8(),
    }))
    expect(f).toEqual([])
  })
  it('errors on malformed issuer id', async () => {
    const f = await ascKeyValid.run(ctxWith({
      APPLE_KEY_ID: 'ABCDE12345',
      APPLE_ISSUER_ID: 'not-a-uuid',
      APPLE_KEY_CONTENT: goodP8(),
    }))
    expect(f[0]?.severity).toBe('error')
  })
  it('errors when key content is not a PEM private key', async () => {
    const f = await ascKeyValid.run(ctxWith({
      APPLE_KEY_ID: 'ABCDE12345',
      APPLE_ISSUER_ID: '12345678-1234-1234-1234-123456789012',
      APPLE_KEY_CONTENT: forge.util.encode64('hello'),
    }))
    expect(f[0]?.severity).toBe('error')
  })
  it('is silent when ASC keys are absent (output-upload / ad_hoc flows)', async () => {
    expect(await ascKeyValid.run(ctxWith({}))).toEqual([])
  })
})

describe('ios/asc-key-valid — format errors never echo the raw value', () => {
  it('errors on malformed APPLE_KEY_ID without echoing it', async () => {
    const wrong = 'super-secret-password' // classic field mix-up: a password pasted into the key id
    const f = await ascKeyValid.run(ctxWith({ APPLE_KEY_ID: wrong }))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('APPLE_KEY_ID')
    expect(JSON.stringify(f)).not.toContain(wrong)
  })
  it('errors on malformed APPLE_ISSUER_ID without echoing it', async () => {
    const wrong = 'not-a-uuid-but-maybe-a-secret'
    const f = await ascKeyValid.run(ctxWith({ APPLE_ISSUER_ID: wrong }))
    expect(f[0]?.severity).toBe('error')
    expect(JSON.stringify(f)).not.toContain(wrong)
  })
})

describe('openP12 leaf selection (chain-bearing P12s)', () => {
  it('picks the leaf cert even when a CA cert sits at bag index 0', () => {
    const chain = makeChainP12()
    const opened = openP12(chain.base64, chain.password)
    expect(opened.sha1).toBe(chain.leafSha1)
    expect(opened.sha1).not.toBe(chain.caSha1)
  })
  it('cert-profile pairing logic sees the leaf, not the CA (no false mismatch)', async () => {
    const chain = makeChainP12()
    // p12-expiry uses the selected cert too: leaf expires in 1y → no findings
    const f = await p12Expiry.run(ctxWith({ BUILD_CERTIFICATE_BASE64: chain.base64, P12_PASSWORD: chain.password }))
    expect(f).toEqual([])
  })
})

describe('credential blob size cap', () => {
  it('refuses an absurdly large certificate blob with a clear error (no decode attempt)', async () => {
    const huge = 'A'.repeat(MAX_CREDENTIAL_B64_CHARS + 1)
    const started = Date.now()
    const f = await p12Opens.run(ctxWith({ BUILD_CERTIFICATE_BASE64: huge, P12_PASSWORD: 'x' }))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.detail).toContain('limit 10 MB')
    expect(Date.now() - started).toBeLessThan(2000) // fails fast, no multi-GB forge parse
  })
})
