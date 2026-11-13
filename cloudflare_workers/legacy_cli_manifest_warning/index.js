const LEGACY_MANIFEST_WARNING_CODE = 'legacy_manifest_upload'
const LEGACY_MANIFEST_WARNING = {
  code: LEGACY_MANIFEST_WARNING_CODE,
  source: 'cloudflare',
  fatal: false,
  message: 'This CLI version uses the legacy manifest upload path, which is no longer supported. Normal bundle uploads can continue, but delta/manifest uploads will fail. Upgrade to the latest CLI by running the same command with npx @capgo/cli@latest.',
}

function usesLegacyManifestUpload(cliVersion) {
  if (typeof cliVersion !== 'string')
    return false

  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(cliVersion.trim())
  if (!match)
    return false

  const major = Number(match[1])
  const minor = Number(match[2])

  return major < 8 || (major === 8 && minor < 30)
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const isWarningsRpc = request.method === 'POST'
      && url.hostname === 'sb.capgo.app'
      && url.pathname === '/rest/v1/rpc/get_organization_cli_warnings'

    if (!isWarningsRpc)
      return fetch(request)

    let payload
    try {
      payload = await request.clone().json()
    }
    catch {
      return fetch(request)
    }

    if (!usesLegacyManifestUpload(payload?.cli_version))
      return fetch(request)

    const response = await fetch(request)
    if (!response.ok)
      return response

    let warnings
    try {
      warnings = await response.clone().json()
    }
    catch {
      return response
    }

    if (!Array.isArray(warnings))
      return response

    if (!warnings.some(warning => warning?.code === LEGACY_MANIFEST_WARNING_CODE))
      warnings.push(LEGACY_MANIFEST_WARNING)

    const headers = new Headers(response.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.delete('content-range')
    headers.delete('etag')
    headers.set('cache-control', 'no-store')
    headers.set('content-type', 'application/json; charset=utf-8')

    return new Response(JSON.stringify(warnings), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
