/**
 * URL / route helpers for logs and alerts.
 *
 * Some routes carry a capability token in the path (PUT /build/credentials/upload/:token).
 * Every place that logs or reports a request URL must pass it through redactSensitiveUrl.
 */

const SECRET_PATH_SEGMENT = /(\/build\/credentials\/upload\/)[^/?#\s]+/g

/** Replaces capability tokens carried in the URL path with `[redacted]`. */
export function redactSensitiveUrl(url: string): string {
  return url.replace(SECRET_PATH_SEGMENT, '$1[redacted]')
}

const SECRET_BODY_ROUTE = /\/(?:build\/(?:credentials|request)|private\/assistant)(?:[/?#]|$)/

/**
 * Routes whose request body carries native build signing secrets or assistant conversations.
 * Their bodies must never be copied into error reports, whatever the error.
 */
export function isSecretBodyRoute(url: string): boolean {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  }
  catch {
    // Relative URL / path: test it as is.
  }
  return SECRET_BODY_ROUTE.test(pathname)
}
