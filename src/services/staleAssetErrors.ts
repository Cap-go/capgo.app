import { getErrorMessage } from '~/utils/errors'

export { getErrorMessage } from '~/utils/errors'

const STALE_ASSET_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
  /text\/html.*is not a valid JavaScript MIME type/i,
  /Loading chunk [\w-]+ failed/i,
  /Loading CSS chunk [\w-]+ failed/i,
]

const KNOWN_CRAWLER_ERROR_PATTERNS = [
  /Object Not Found Matching Id:\d+(?:,\s*MethodName:[^,]+,\s*ParamCount:\d+)?/i,
]

// vue-router throws this when a lazy route component fails to load (e.g. a stale
// chunk 404 during a deploy). It can also surface if a navigation races the
// automatic reload we trigger for stale chunks, so we treat it as a chunk error.
const COMPONENT_RESOLUTION_ERROR_PATTERNS = [
  /Couldn't resolve component/i,
]

export function isStaleAssetErrorMessage(message: string | undefined): boolean {
  if (!message)
    return false

  return STALE_ASSET_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

export function isKnownCrawlerNoiseErrorMessage(message: string | undefined): boolean {
  if (!message)
    return false

  return KNOWN_CRAWLER_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

export function isComponentResolutionErrorMessage(message: string | undefined): boolean {
  if (!message)
    return false

  return COMPONENT_RESOLUTION_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

interface PostHogExceptionLike {
  value?: unknown
  $exception_value?: unknown
}

interface PostHogEventLike {
  event?: unknown
  properties?: {
    $exception_list?: PostHogExceptionLike[]
    $exception_values?: unknown[]
  }
}

export function shouldSuppressPostHogExceptionEvent(event: PostHogEventLike): boolean {
  if (event.event !== '$exception')
    return false

  const exception = event.properties?.$exception_list?.[0]
  const exceptionValue = getErrorMessage(exception?.value) ?? getErrorMessage(exception?.$exception_value)
  if (isStaleAssetErrorMessage(exceptionValue) || isKnownCrawlerNoiseErrorMessage(exceptionValue))
    return true

  const fallbackValue = getErrorMessage(event.properties?.$exception_values?.[0])
  return isStaleAssetErrorMessage(fallbackValue) || isKnownCrawlerNoiseErrorMessage(fallbackValue)
}
