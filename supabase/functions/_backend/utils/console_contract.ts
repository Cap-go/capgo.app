import type { PostgrestClient } from '@supabase/postgrest-js'
import type { Database } from './supabase.types.ts'

// Transport types shared by the console client and the console API. They are
// erased at build time; the console bundle never loads a Supabase SDK.
export type ConsoleDataClient<T = Database> = Pick<PostgrestClient<T>, 'from' | 'rpc'>

// GoTrue response shapes, limited to the fields the console reads.
export type AuthChangeEvent = 'INITIAL_SESSION' | 'PASSWORD_RECOVERY' | 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED' | 'MFA_CHALLENGE_VERIFIED'

export interface AuthError {
  message: string
  code?: string
  status?: number
}

export interface Factor {
  id: string
  friendly_name?: string
  factor_type: 'totp' | 'phone' | 'webauthn'
  status: 'verified' | 'unverified'
  created_at: string
  updated_at: string
}

export interface User {
  id: string
  aud: string
  email?: string
  phone?: string
  created_at: string
  updated_at?: string
  email_confirmed_at?: string
  app_metadata: { provider?: string, providers?: string[], [key: string]: unknown }
  user_metadata: { first_name?: string, last_name?: string, [key: string]: unknown }
  factors?: Factor[]
}

export interface Session {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  expires_at?: number
  user: User
}

export interface FunctionInvokeOptions {
  headers?: Record<string, string>
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE'
  body?: object | string
}

// The org-scoped CLI event stream, shaped like the realtime channel the console used before.
export type RealtimeChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'CLOSED'

export interface RealtimeChannel {
  on: (kind: 'broadcast', filter: { event: string }, callback: (message: { payload: unknown }) => void) => RealtimeChannel
  subscribe: (callback: (status: RealtimeChannelStatus) => void) => RealtimeChannel
  track: (presence: Record<string, unknown>) => Promise<'ok'>
  unsubscribe: () => Promise<'ok'>
}

export interface ConsoleQuery {
  kind: 'table' | 'rpc'
  name: string
  args: unknown[]
  operations: { method: string, args: unknown[] }[]
}
