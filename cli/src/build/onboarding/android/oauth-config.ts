// src/build/onboarding/android/oauth-config.ts
//
// Capgo's Google OAuth client credentials are NOT baked into the CLI.
// They are fetched at runtime from a Capgo backend endpoint so they can be
// rotated without re-publishing the CLI.
//
// Endpoint: GET https://api.capgo.app/private/config/builder
// Response: { enabled: false }
//        OR { enabled: true, clientId: string, clientSecret: string, scopes: string[] }
//
// The "client_secret" returned is for a Google "Desktop app" OAuth client.
// Per RFC 8252 §8.5 and Google's native-app docs, that secret is not treated
// as confidential — every Google-backed CLI (gcloud, gh, vercel, firebase)
// ships with theirs in the binary. We fetch ours from the backend rather than
// embedding it solely so that rotation doesn't require a CLI release.

import process from 'node:process'

const DEFAULT_CONFIG_ENDPOINT = 'https://api.capgo.app/private/config/builder'

/** Override the config endpoint via env var (useful for staging / a local backend). */
const CONFIG_ENDPOINT_ENV = 'CAPGO_BUILDER_CONFIG_URL'

/**
 * YouTube tutorial explaining how to find a Google Play Console Developer
 * account ID — shown as an option on the "paste your developer ID" step.
 */
export const PLAY_DEV_ID_TUTORIAL_URL = 'https://www.youtube.com/watch?v=Y1_Ngj8hHLU'

export interface CapgoOAuthClientConfig {
  clientId: string
  clientSecret: string
  /**
   * Scopes the backend tells the CLI to request. Always at least
   * `https://www.googleapis.com/auth/androidpublisher`.
   */
  scopes: string[]
}

interface BuilderConfigResponse {
  enabled: boolean
  clientId?: string
  clientSecret?: string
  scopes?: string[]
}

/**
 * Fetch Capgo's Google OAuth client config from the backend.
 *
 * Returns the config when the backend has both `GOOGLE_OAUTH_CLIENT_ID` and
 * `GOOGLE_OAUTH_CLIENT_SECRET` set (the `enabled: true` branch). Returns null
 * if Google OAuth is not configured server-side — callers should treat that
 * as "Android OAuth onboarding is not available, ask the user to use the
 * manual flow from the docs".
 */
export async function fetchCapgoOAuthConfig(): Promise<CapgoOAuthClientConfig | null> {
  const url = process.env[CONFIG_ENDPOINT_ENV] || DEFAULT_CONFIG_ENDPOINT
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Capgo builder config fetch failed (${res.status} from ${url}): ${text.slice(0, 200)}`)
  }
  let parsed: BuilderConfigResponse
  try {
    parsed = await res.json() as BuilderConfigResponse
  }
  catch {
    throw new Error(`Capgo builder config returned non-JSON from ${url}`)
  }
  if (!parsed.enabled)
    return null
  if (!parsed.clientId || !parsed.clientSecret)
    throw new Error('Capgo builder config returned enabled=true but is missing clientId/clientSecret')
  return {
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
    scopes: parsed.scopes && parsed.scopes.length > 0
      ? parsed.scopes
      : ['https://www.googleapis.com/auth/androidpublisher'],
  }
}
