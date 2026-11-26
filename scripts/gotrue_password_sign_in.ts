// Password sign-in against Supabase Auth (GoTrue) with plain fetch, the same
// request supabase-js `auth.signInWithPassword` sends.

export interface GotrueSession {
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at: number
  token_type: string
  user: { id: string, [key: string]: unknown }
}

export async function signInWithPassword(supabaseUrl: string, anonKey: string, email: string, password: string): Promise<GotrueSession> {
  const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await response.json().catch(() => ({})) as Partial<GotrueSession> & { msg?: string, message?: string, error_description?: string, error?: string }
  if (!response.ok || !body.access_token)
    throw new Error(body.msg || body.message || body.error_description || body.error || `HTTP ${response.status}`)
  return {
    ...body,
    // supabase-js fills expires_at in when the server leaves it out.
    expires_at: body.expires_at ?? Math.round(Date.now() / 1000) + (body.expires_in ?? 0),
  } as GotrueSession
}
