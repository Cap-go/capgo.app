const UNAUTH_ERRORS = new Set(['invalid_apikey', 'apikey_expired'])
const FORBIDDEN_ERRORS = new Set([
  'apikey_app_forbidden',
  'apikey_not_app_scoped',
  'apikey_ambiguous_scope',
  'app_org_mismatch',
  'session_not_active',
])

export function authErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'auth_failed'
  if (UNAUTH_ERRORS.has(message))
    return Response.json({ error: message }, { status: 401 })
  if (FORBIDDEN_ERRORS.has(message))
    return Response.json({ error: message }, { status: 403 })
  console.error(JSON.stringify({ event: 'terminal_auth_error', message }))
  return Response.json({ error: 'internal_error' }, { status: 500 })
}