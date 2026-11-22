const AUTH_ERRORS = new Set([
  'invalid_apikey',
  'apikey_expired',
  'apikey_app_forbidden',
  'app_org_mismatch',
])

export function authErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'auth_failed'
  if (AUTH_ERRORS.has(message))
    return Response.json({ error: message }, { status: 403 })
  return Response.json({ error: 'internal_error' }, { status: 500 })
}