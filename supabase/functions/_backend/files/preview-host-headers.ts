export const PREVIEW_X_ROBOTS_TAG = 'noindex, nofollow'

export function isPreviewCapgoHost(hostname: string): boolean {
  return /^[^.]+\.preview(?:\.[^.]+)?\.(?:capgo\.app|usecapgo\.com)$/.test(hostname)
}

export function applyPreviewXRobotsTag(headers: Headers): void {
  headers.set('X-Robots-Tag', PREVIEW_X_ROBOTS_TAG)
}

export function withPreviewHostHeaders(request: Request, response: Response): Response {
  const hostname = request.headers.get('host') || new URL(request.url).hostname
  if (!isPreviewCapgoHost(hostname))
    return response

  applyPreviewXRobotsTag(response.headers)
  return response
}
