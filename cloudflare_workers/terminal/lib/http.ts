export function extractApiKey(request: Request): string | null {
  const header = request.headers.get('authorization')?.trim()
  if (header) {
    const match = /^Bearer\s+(\S.*)$/i.exec(header)
    return (match ? match[1] : header).trim() || null
  }
  return request.headers.get('capgkey')?.trim()
    || request.headers.get('x-api-key')?.trim()
    || null
}

export function parseSessionRoute(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix))
    return null
  const encoded = pathname.slice(prefix.length)
  if (!encoded)
    return null
  try {
    return decodeURIComponent(encoded)
  }
  catch {
    return null
  }
}