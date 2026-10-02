import type { SAMLConfig } from '@better-auth/sso'
import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import ipaddr from 'ipaddr.js'
import { IdentityProvider } from 'samlify'
import { simpleError } from './hono.ts'
import { getPgClient } from './pg.ts'
import { getEnv } from './utils.ts'

export function consoleSamlConfig(authURL: string, providerId: string, xml: string, mapping: Record<string, string> = {}): SAMLConfig {
  if (new TextEncoder().encode(xml).length > 262144 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw simpleError('invalid_saml_metadata', 'Invalid SAML metadata')
  let entryPoint: string
  try {
    const idp = IdentityProvider({ metadata: xml })
    const service = idp.entityMeta.getSingleSignOnService('redirect')
    const cert = idp.entityMeta.getX509Certificate('signing')
    if (!idp.entityMeta.getEntityID() || typeof service !== 'string' || !service || !cert?.length)
      throw new Error('Missing SAML metadata fields')
    entryPoint = service
  }
  catch {
    throw simpleError('invalid_saml_metadata', 'SAML metadata must contain an entity, redirect service, and signing certificate')
  }
  const base = `${authURL.replace(/\/$/, '')}/auth`
  return {
    issuer: `${base}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`,
    entryPoint,
    idpMetadata: { metadata: xml },
    wantAssertionsSigned: true,
    mapping: { email: mapping.email, name: mapping.name, firstName: mapping.first_name, lastName: mapping.last_name,
      extraFields: Object.fromEntries(Object.entries(mapping).filter(([key]) => !['email', 'name', 'first_name', 'last_name'].includes(key))) },
  }
}

export async function fetchConsoleSamlMetadata(source: { metadata_url?: string, metadata_xml?: string }) {
  if (source.metadata_xml)
    return source.metadata_xml
  // Workers prohibit private-network fetches even if DNS changes after validation.
  // Other runtimes must use uploaded XML rather than an unpinned URL fetch.
  if (getRuntimeKey() !== 'workerd')
    throw new Error('Upload SAML metadata XML on this deployment')
  const url = new URL(source.metadata_url ?? '')
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || ipaddr.isValid(url.hostname))
    throw new Error('Metadata URL must use a public HTTPS hostname')
  // Reject private/reserved answers before fetching. Workers also prohibit
  // private-network fetches. Redirects require an explicit metadata URL update.
  const answers = await Promise.all(['A', 'AAAA'].map(async (type) => {
    const dns = new URL('https://cloudflare-dns.com/dns-query')
    dns.searchParams.set('name', url.hostname)
    dns.searchParams.set('type', type)
    const response = await fetch(dns, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })
    if (!response.ok)
      throw new Error('Cannot resolve metadata hostname')
    const result = await response.json() as { Answer?: { type: number, data: string }[] }
    return (result.Answer ?? []).filter(answer => [1, 28].includes(answer.type)).map(answer => answer.data)
  }))
  const addresses = answers.flat()
  if (!addresses.length || addresses.some(address => ipaddr.process(address).range() !== 'unicast'))
    throw new Error('Metadata hostname must resolve to public addresses')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) })
  if (!response.ok || !response.body)
    throw new Error('Unable to fetch SAML metadata')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done)
        break
      bytes += value.byteLength
      if (bytes > 262144)
        throw new Error('SAML metadata is too large')
      chunks.push(value)
    }
  }
  finally {
    await reader.cancel()
  }
  const data = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(data)
}

export async function withConsoleSsoDatabase<T>(c: Context, operation: (pool: ReturnType<typeof getPgClient>) => Promise<T>) {
  const pool = getPgClient(c)
  try {
    return await operation(pool)
  }
  finally {
    if (getRuntimeKey() !== 'workerd')
      await pool.end()
  }
}

export function consoleSsoURL(c: Context) {
  const url = getEnv(c, 'CONSOLE_AUTH_URL')
  if (!url)
    throw new Error('CONSOLE_AUTH_URL is required')
  return url
}
