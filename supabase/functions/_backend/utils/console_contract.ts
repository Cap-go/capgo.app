import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './supabase.types.ts'

// Transport types shared by the console client and the console API. They are
// erased at build time; the console bundle never loads a Supabase SDK.
export type ConsoleDataClient<T = Database> = Pick<SupabaseClient<T>, 'from' | 'rpc'>
export type { AuthChangeEvent, AuthError, Factor, FunctionInvokeOptions, RealtimeChannel, Session, User } from '@supabase/supabase-js'

export interface ConsoleQuery {
  kind: 'table' | 'rpc'
  name: string
  args: unknown[]
  operations: { method: string, args: unknown[] }[]
}
