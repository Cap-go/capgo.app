import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'
import { getRuntimeKey } from 'hono/adapter'
import { cloudlog, cloudlogErr } from './logging.ts'
import { normalizeLegacyEncodedManifestFileName } from './manifest_encoding.ts'
import { s3 } from './s3.ts'

const EXPIRATION_SECONDS = 604800
const BASE_PATH = 'files/read/attachments'
const LOCAL_DEFAULT_HOST = 'localhost:54321'

/**
 * Returns the first value from a potentially comma-separated forwarded header.
 */
function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  if (!value)
    return undefined
  return value.split(',')[0]?.trim() || undefined
}

/**
 * Rewrites edge-runtime internal hosts to externally reachable hosts for local development.
 */
function rewriteLocalEdgeRuntimeUrl(url: URL, c: Context): { url: URL, finalPath: string } {
  let finalPath = BASE_PATH

  // When running on Supabase Edge Runtime, the request host can be the internal container.
  // Build URLs using the externally visible host/port from forwarded headers when possible.
  if (url.host.endsWith(':8081') && url.hostname.startsWith('supabase_edge_runtime_')) {
    const forwardedHost = firstForwardedHeaderValue(c.req.header('X-Forwarded-Host'))
    const forwardedPort = firstForwardedHeaderValue(c.req.header('X-Forwarded-Port'))
    const forwardedProto = firstForwardedHeaderValue(c.req.header('X-Forwarded-Proto'))

    if (forwardedHost) {
      url.host = forwardedHost.includes(':') ? forwardedHost : `${forwardedHost}:${forwardedPort || '54321'}`
      if (forwardedProto)
        url.protocol = `${forwardedProto}:`
    }
    else {
      // Preserve the old behavior: if we cannot determine the public host, fall back to localhost.
      url.host = forwardedPort ? `localhost:${forwardedPort}` : LOCAL_DEFAULT_HOST
      if (forwardedProto)
        url.protocol = `${forwardedProto}:`
    }

    finalPath = `functions/v1/${BASE_PATH}`
  }

  return { url, finalPath }
}

export interface ManifestEntry {
  file_name: string | null
  file_hash: string | null
  download_url: string | null
}

export async function getBundleUrl(
  c: Context,
  r2_path: string | null,
  deviceId: string,
  checksum: string,
) {
  cloudlog({ requestId: c.get('requestId'), message: 'getBundleUrl path', r2_path })
  if (!r2_path)
    return null

  if (getRuntimeKey() !== 'workerd') {
    try {
      const signedUrl = await s3.getSignedUrl(c, r2_path, EXPIRATION_SECONDS)
      cloudlog({ requestId: c.get('requestId'), message: 'getBundleUrl', signedUrl })
      const url = signedUrl
      // Since it's signed url we cannot add extra query params like checksum and device id
      // TODO: switch to our own file endpoint instead of direct s3 signed url
      return url
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBundleUrl', error })
    }
  }
  const url = new URL(c.req.url)
  const { finalPath } = rewriteLocalEdgeRuntimeUrl(url, c)
  const downloadUrl = `${url.protocol}//${url.host}/${finalPath}/${r2_path}?key=${checksum}&device_id=${deviceId}`
  return downloadUrl
}

export function getManifestUrl(c: Context, versionId: number, manifest: Partial<Database['public']['Tables']['manifest']['Row']>[] | null, deviceId: string): ManifestEntry[] {
  if (!manifest) {
    return []
  }

  try {
    const url = new URL(c.req.url)
    const { finalPath } = rewriteLocalEdgeRuntimeUrl(url, c)
    const signKey = versionId

    return manifest.map((entry) => {
      if (!entry.s3_path)
        return null

      return {
        file_name: normalizeLegacyEncodedManifestFileName(entry.file_name, entry.s3_path),
        file_hash: entry.file_hash,
        download_url: `${url.protocol}//${url.host}/${finalPath}/${entry.s3_path}?key=${signKey}&device_id=${deviceId}`,
      }
    }).filter(entry => entry !== null) as ManifestEntry[]
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getManifestUrl', error, manifest })
    return []
  }
}
