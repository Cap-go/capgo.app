export function extractApiKey(request: Request): string | null {
  const header = request.headers.get('authorization')?.trim()
  if (header) {
    const match = /^Bearer(?:\s+(.*))?$/i.exec(header)
    const key = (match ? match[1] : header)?.trim()
    if (key)
      return key
  }
  return request.headers.get('capgkey')?.trim()
    || request.headers.get('x-api-key')?.trim()
    || null
}

export function parseSessionRoute(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix))
    return null
  const rest = pathname.slice(prefix.length)
  if (!rest || rest.includes('/'))
    return null
  const encoded = rest
  if (!encoded)
    return null
  try {
    return decodeURIComponent(encoded)
  }
  catch {
    return null
  }
}