import type { Context } from 'hono'
import { cloudlog } from './logging.ts'

const PLUGIN_SUPABASE_WRITE_SKIPPED_MESSAGE = 'Supabase write fallback skipped for plugin endpoint'

function getRequestId(c: Context) {
  try {
    return c.get('requestId')
  }
  catch {
    return undefined
  }
}

function getBooleanContextFlag(c: Context, key: string): boolean {
  try {
    return c.get(key as any) === true
  }
  catch {
    return false
  }
}

export function shouldSkipSupabaseStatsFallback(c: Context): boolean {
  return getBooleanContextFlag(c, 'skipSupabaseStatsFallback')
}

export function shouldSkipSupabaseNotificationWrites(c: Context): boolean {
  return getBooleanContextFlag(c, 'skipSupabaseNotificationWrites')
}

export function shouldQueuePluginNotifications(c: Context): boolean {
  return getBooleanContextFlag(c, 'queuePluginNotifications')
}

export function shouldRequireReadReplica(c: Context): boolean {
  return getBooleanContextFlag(c, 'requireReadReplica')
}

export function shouldSkipDirectHyperdriveFallback(c: Context): boolean {
  return shouldRequireReadReplica(c)
}

export function shouldSkipChannelSelfPostgresFallback(c: Context): boolean {
  return getBooleanContextFlag(c, 'skipChannelSelfPostgresFallback')
}

export function logSkippedSupabaseWrite(c: Context, operation: string): void {
  cloudlog({
    requestId: getRequestId(c),
    message: PLUGIN_SUPABASE_WRITE_SKIPPED_MESSAGE,
    operation,
  })
}
