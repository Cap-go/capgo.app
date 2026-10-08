import type { AuthChangeEvent, AuthError, Factor, RealtimeChannel, Session, SupabaseClient, User } from '@supabase/supabase-js'
import type { Database } from './supabase.types.ts'

// During the database cutover, transport types preserve existing table/RPC contracts.
// These are erased at build time; the console never loads the database SDK.
export type ConsoleDataClient<T = Database> = Pick<SupabaseClient<T>, 'from' | 'rpc'>
export type { AuthChangeEvent, AuthError, Factor, RealtimeChannel, Session, User }

export interface ConsoleQuery {
  kind: 'table' | 'rpc'
  name: string
  args: unknown[]
  operations: { method: string, args: unknown[] }[]
}
