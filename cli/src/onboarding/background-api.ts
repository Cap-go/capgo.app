import type { OnboardingCheckOptions } from './background'
import { defaultApiHost } from '../utils'

function parseApiUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return undefined
    return url
  }
  catch {
    return undefined
  }
}

export function isTrustedOnboardingApiHost(
  apiHost: string,
  options: Pick<OnboardingCheckOptions, 'supaHost' | 'supaAnon'>,
  trustedOrigins: readonly string[],
): boolean {
  const destination = parseApiUrl(apiHost)
  if (!destination)
    return false
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)
  // Trust does not permit sending credentials over remote cleartext transport.
  if (destination.protocol !== 'https:' && !loopback)
    return false

  if (destination.origin === new URL(defaultApiHost).origin)
    return true
  // An explicit CLI self-host selection authorizes that origin, not project config alone.
  const explicitHost = options.supaHost && options.supaAnon ? parseApiUrl(options.supaHost) : undefined
  if (explicitHost?.origin === destination.origin)
    return true
  return trustedOrigins.some((origin) => {
    const trusted = parseApiUrl(origin.trim())
    return trusted?.pathname === '/' && trusted.origin === destination.origin
  })
}
