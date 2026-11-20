import { MCP_ALIAS_HOST, MCP_PUBLIC_PATH_HEADER } from '../../supabase/functions/_backend/mcp/oauth_shared.ts'

function mcpAliasNotFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
}

export function isMcpAliasRequest(request: Request): boolean {
  const host = request.headers.get('host')?.split(':')[0]?.toLowerCase()
    ?? new URL(request.url).hostname.toLowerCase()
  return host === MCP_ALIAS_HOST
}

function isAllowedMcpAliasPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '')
    return true
  if (pathname === '/mcp.json')
    return true
  if (pathname === '/mcp' || pathname.startsWith('/mcp/'))
    return true
  if (pathname.startsWith('/.well-known/'))
    return true
  return false
}

function mcpAliasPublicPath(pathname: string): '/' | '/mcp' {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/.well-known/oauth-protected-resource/mcp')
    return '/mcp'
  if (path === '/.well-known/oauth-protected-resource')
    return '/'
  if (path === '/' || path === '')
    return '/'
  if (path === '/mcp' || path.startsWith('/mcp/'))
    return '/mcp'
  return '/'
}

export function handleMcpAliasRequest(request: Request): Request | Response {
  if (!isMcpAliasRequest(request))
    return request
  const url = new URL(request.url)
  if (!isAllowedMcpAliasPath(url.pathname))
    return mcpAliasNotFound()

  const headers = new Headers(request.headers)
  headers.set(MCP_PUBLIC_PATH_HEADER, mcpAliasPublicPath(url.pathname))

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: request.redirect,
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }

  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/mcp'
    return new Request(url, init)
  }

  return new Request(url, init)
}