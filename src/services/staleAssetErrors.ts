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

// Transient browser network drops surface as a `fetch` TypeError whose exact
// wording differs per engine. Anchored so only the standalone browser message
// (optionally wrapped with a `<context>: ` prefix, e.g. `downloadUrl error: …`)
// is suppressed — not richer messages like "Failed to fetch organization insights".
const TRANSIENT_NETWORK_ERROR_PATTERNS = [
  /^(?:.*: )?Failed to fetch$/i,
  /^(?:.*: )?Load failed$/i,
  /^(?:.*: )?NetworkError when attempting to fetch resource\.?$/i,
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

export function isTransientNetworkErrorMessage(message: string | undefined): boolean {
  if (!message)
    return false

  return TRANSIENT_NETWORK_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

export function isComponentResolutionErrorMessage(message: string | undefined): boolean {
  if (!message)
    return false

  return COMPONENT_RESOLUTION_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

interface PostHogStackFrame {
  filename?: unknown
  function?: unknown
  lineno?: unknown
  in_app?: unknown
}

interface PostHogExceptionLike {
  value?: unknown
  $exception_value?: unknown
  stacktrace?: {
    frames?: PostHogStackFrame[]
  }
}

interface PostHogEventLike {
  event?: unknown
  properties?: {
    $exception_list?: PostHogExceptionLike[]
    $exception_values?: unknown[]
    $current_url?: unknown
  }
}

function stripUrlQueryAndHash(url: string | undefined): string | undefined {
  if (!url)
    return undefined

  const cutIndex = url.search(/[?#]/)
  return cutIndex === -1 ? url : url.slice(0, cutIndex)
}

// First-party inline script in index.html (theme bootstrap before Vue loads).
const FIRST_PARTY_INLINE_FRAME_FUNCTIONS = new Set([
  'applyTheme',
  '__setTheme',
])

function isDocumentUrlFrame(frame: PostHogStackFrame, documentUrl: string): boolean {
  return stripUrlQueryAndHash(typeof frame.filename === 'string' ? frame.filename : undefined) === documentUrl
}

function isFirstPartyInlineFrame(frame: PostHogStackFrame): boolean {
  const func = typeof frame.function === 'string' ? frame.function : ''
  return FIRST_PARTY_INLINE_FRAME_FUNCTIONS.has(func)
}

// Console paste, extensions, and AI browser agents typically surface as
// `global code` at line 1 on the page URL. Require that signature so we do not
// drop real errors from our owned inline theme script, which also stacks against
// the document URL but uses normal function names and line numbers.
function hasInjectedCodeFrameSignature(frame: PostHogStackFrame): boolean {
  const func = typeof frame.function === 'string' ? frame.function : ''
  const lineno = typeof frame.lineno === 'number' ? frame.lineno : undefined

  if (func === 'global code' || func === 'eval' || func === 'eval code')
    return true

  if (lineno === 1 && (func === '' || func === '<anonymous>' || func === 'global code'))
    return true

  return false
}

// A snippet pasted into the browser console, injected by an extension, or run by
// an AI browser agent surfaces as an $exception whose in-app frames all point at
// the HTML document with a console/eval signature. Bundled app code runs from
// hashed chunks under `/assets/`; our inline theme bootstrap is allowlisted.
export function isInjectedDocumentCodeException(exception: PostHogExceptionLike | undefined, currentUrl: unknown): boolean {
  const documentUrl = stripUrlQueryAndHash(typeof currentUrl === 'string' ? currentUrl : undefined)
  if (!documentUrl)
    return false

  const frames = exception?.stacktrace?.frames
  if (!Array.isArray(frames))
    return false

  const inAppFrames = frames.filter(frame => frame?.in_app === true)
  if (inAppFrames.length === 0)
    return false

  if (!inAppFrames.every(frame => isDocumentUrlFrame(frame, documentUrl)))
    return false

  if (inAppFrames.some(frame => isFirstPartyInlineFrame(frame)))
    return false

  return inAppFrames.some(frame => hasInjectedCodeFrameSignature(frame))
}

export function shouldSuppressPostHogExceptionEvent(event: PostHogEventLike): boolean {
  if (event.event !== '$exception')
    return false

  const exception = event.properties?.$exception_list?.[0]
  const exceptionValue = getErrorMessage(exception?.value) ?? getErrorMessage(exception?.$exception_value)
  if (isSuppressibleNoiseErrorMessage(exceptionValue))
    return true

  const fallbackValue = getErrorMessage(event.properties?.$exception_values?.[0])
  if (isSuppressibleNoiseErrorMessage(fallbackValue))
    return true

  return isInjectedDocumentCodeException(exception, event.properties?.$current_url)
}

function isSuppressibleNoiseErrorMessage(message: string | undefined): boolean {
  return isStaleAssetErrorMessage(message)
    || isComponentResolutionErrorMessage(message)
    || isKnownCrawlerNoiseErrorMessage(message)
    || isTransientNetworkErrorMessage(message)
}
