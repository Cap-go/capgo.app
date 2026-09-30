export const MANIFEST_SIZE_RECEIPT_HEADER = 'X-Capgo-Manifest-Size-Receipt'
const encoder = new TextEncoder()
const algorithm = { name: 'HMAC', hash: 'SHA-256' } as const
const payload = (path: string, size: number) => encoder.encode(`capgo-manifest-size:v1\n${path}\n${size}`)
const key = (secret: string, usage: 'sign' | 'verify') => crypto.subtle.importKey('raw', encoder.encode(secret), algorithm, false, [usage])
async function verify(key: CryptoKey, path: string, receipt: string): Promise<number | null> {
  const [version, rawSize, signature, extra] = receipt.split('.')
  const size = Number(rawSize)
  if (version !== 'v1' || extra || !signature || !/^[\w-]{43}$/.test(signature) || String(size) !== rawSize || !Number.isSafeInteger(size) || size < 0)
    return null
  return await crypto.subtle.verify(algorithm, key, Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/').padEnd(44, '=')), char => char.charCodeAt(0)), payload(path, size)) ? size : null
}
export async function createManifestSizeReceipt(secret: string, path: string, size: number): Promise<string> {
  if (!secret || !Number.isSafeInteger(size) || size < 0)
    throw new Error('Cannot sign invalid manifest size receipt')
  const signature = await crypto.subtle.sign(algorithm, await key(secret, 'sign'), payload(path, size))
  return `v1.${size}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`
}
export async function verifyManifestSizeReceipts(secret: string, entries: Array<{ path: string, receipt: string }>): Promise<number[] | null> {
  if (!secret)
    return null
  const verifyKey = await key(secret, 'verify')
  const sizes = await Promise.all(entries.map(entry => verify(verifyKey, entry.path, entry.receipt)))
  return sizes.some(size => size == null) ? null : sizes as number[]
}
