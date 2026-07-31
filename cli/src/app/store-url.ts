export function normalizeStoreUrl(rawUrl: string | undefined, expectedHost: 'apps.apple.com' | 'play.google.com'): string | null {
  const trimmedUrl = rawUrl?.trim() ?? ''
  if (!trimmedUrl)
    return null

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmedUrl)
  }
  catch {
    throw new Error(`Invalid store URL: ${trimmedUrl}`)
  }

  if (parsedUrl.hostname !== expectedHost)
    throw new Error(`Store URL must use ${expectedHost}`)

  return parsedUrl.toString()
}
