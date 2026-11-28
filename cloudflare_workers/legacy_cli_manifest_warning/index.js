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

// Old CLIs (up to 8.32.7) call Supabase Edge Functions on sb.capgo.app. Serve those calls
// from the Cloudflare Workers, which run the same backend routes.
const LEGACY_FUNCTIONS_PREFIX = '/functions/v1'
const LEGACY_UPLOAD_LINK_PATH = `${LEGACY_FUNCTIONS_PREFIX}/private/upload_link`
const LEGACY_CLI_UNSUPPORTED = {
  error: 'legacy_cli_unsupported',
  message: 'This CLI version is no longer supported. Upgrade to the latest CLI by running the same command with npx @capgo/cli@latest.',
}

function legacyFunctionTarget(url) {
  if (url.hostname !== 'sb.capgo.app' || !url.pathname.startsWith(`${LEGACY_FUNCTIONS_PREFIX}/`))
    return null
  const path = url.pathname.slice(LEGACY_FUNCTIONS_PREFIX.length)
  if (path === '/bundle' || path.startsWith('/bundle/') || path === '/private/set_manifest')
    return `https://api.capgo.app${path}${url.search}`
  if (path.startsWith('/files/'))
    return `https://files.capgo.app${path}${url.search}`
  return null
}

const legacySnippet = {
  async handle(request) {
    const url = new URL(request.url)
    // Only CLIs that no longer work call this path, so answer here instead of forwarding.
    if (url.hostname === 'sb.capgo.app' && url.pathname === LEGACY_UPLOAD_LINK_PATH) {
      return new Response(JSON.stringify(LEGACY_CLI_UNSUPPORTED), {
        status: 410,
        headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
      })
    }

    const target = legacyFunctionTarget(url)
    if (target)
      return fetch(new Request(target, request))

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

function markResponse(response) {
  if (response.status === 101)
    return response
  const marked = new Response(response.body, response)
  marked.headers.set('x-capgo-snippet', 'legacy')
  return marked
}

export default {
  async fetch(request) {
    return markResponse(await legacySnippet.handle(request))
  },
}
