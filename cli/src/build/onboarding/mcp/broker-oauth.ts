// src/build/onboarding/mcp/broker-oauth.ts
//
// HTTP client for the Capgo backend OAuth broker (MCP-only). The broker survives the MCP server process
// restarting between turns by persisting the in-flight Google sign-in server-side: the CLI creates a
// session, hands the user a sign-in URL, then polls — presenting the one-time confirmation code the user
// reads back from the success page — until a short-lived Google access token is handed off exactly once.
//
// The interactive (TUI) onboarding keeps its own loopback flow (oauth-google.ts); only the MCP path, whose
// process dies between tool calls, uses this broker.
import process from 'node:process'
import { buildCliRequestHeaders } from '../../../analytics/cli-headers'
import { trimTrailingSlashes } from '../../../utils'

const DEFAULT_BROKER_BASE = 'https://api.capgo.app'
/** Override the broker base via env (staging / local). */
const BROKER_BASE_ENV = 'CAPGO_OAUTH_BROKER_URL'
const BROKER_PATH = '/builder_auth_direct/google'

function brokerBase(): string {
  return trimTrailingSlashes(process.env[BROKER_BASE_ENV] || DEFAULT_BROKER_BASE)
}

export interface BrokerSession {
  pubId: string
  pollSecret: string
  signInUrl: string
  /** Epoch ms when the sign-in window closes (the broker's 15-min session TTL). */
  expiresAt: number
}

export type BrokerPollResult =
  | { status: 'pending' }
  | { status: 'awaiting_code', error?: string }
  | { status: 'done', accessToken: string, expiresAt: number | null }
  | { status: 'error', error: string }

/** Create a broker sign-in session for `appId`. Throws on a transport/HTTP failure. */
export async function createBrokerSession(appId: string): Promise<BrokerSession> {
  const res = await fetch(`${brokerBase()}${BROKER_PATH}/sessions`, {
    method: 'POST',
    headers: buildCliRequestHeaders({ 'content-type': 'application/json', accept: 'application/json' }),
    body: JSON.stringify({ app_id: appId }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Google sign-in is unavailable (broker ${res.status}): ${text.slice(0, 200)}`)
  }
  const j = await res.json() as { pub_id?: string, poll_secret?: string, sign_in_url?: string, expires_at?: number }
  if (!j.pub_id || !j.poll_secret || !j.sign_in_url)
    throw new Error('OAuth broker returned an incomplete session response')
  return { pubId: j.pub_id, pollSecret: j.poll_secret, signInUrl: j.sign_in_url, expiresAt: j.expires_at ?? 0 }
}

/**
 * Poll a broker session. Pass `confirmCode` (the code the user read off the success page) to release the
 * token — the broker withholds it (status 'awaiting_code') until the matching code is presented.
 */
export async function pollBrokerSession(session: { pubId: string, pollSecret: string }, confirmCode?: string): Promise<BrokerPollResult> {
  const headers = buildCliRequestHeaders({ authorization: `Bearer ${session.pollSecret}`, accept: 'application/json' })
  if (confirmCode)
    headers['x-confirm-code'] = confirmCode
  const res = await fetch(`${brokerBase()}${BROKER_PATH}/sessions/${encodeURIComponent(session.pubId)}`, { headers })
  // 404 = the session was claimed/expired and hard-deleted server-side; 401 = wrong secret. Both terminal.
  if (res.status === 404)
    return { status: 'error', error: 'Your Google sign-in session expired. Start the sign-in again.' }
  if (res.status === 401)
    return { status: 'error', error: 'Google sign-in could not be verified. Start the sign-in again.' }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Google sign-in poll failed (broker ${res.status}): ${text.slice(0, 200)}`)
  }
  const j = await res.json() as { status?: string, access_token?: string | null, expires_at?: number | null, error?: string }
  switch (j.status) {
    case 'done':
      if (!j.access_token)
        return { status: 'error', error: 'The sign-in completed but no access token was returned. Start the sign-in again.' }
      return { status: 'done', accessToken: j.access_token, expiresAt: j.expires_at ?? null }
    case 'awaiting_code':
      return { status: 'awaiting_code', error: j.error }
    case 'error':
      return { status: 'error', error: j.error || 'Google sign-in failed.' }
    default:
      return { status: 'pending' }
  }
}
