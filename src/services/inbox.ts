import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import { Capacitor } from '@capacitor/core'
import Bowser from 'bowser'
import { getLocalConfig, useSupabase } from './supabase'

export interface InboxContext {
  locale: string
  org_id: string | null
  app_id: string | null
  page: string
  current_url: string
  origin: string
  device: {
    class: 'mobile' | 'tablet' | 'desktop' | 'unknown'
    browser: { name: string | null, version: string | null }
    os: { name: string | null, version: string | null }
    model: string | null
  }
  runtime: { is_native: boolean, platform: string }
  viewport: { width: number, height: number }
}

export interface InboxMessage {
  id: string
  embed_url: string
  presentation: { preferred_width: number, preferred_height: number }
}

export type InboxEvent = 'shown' | 'dismissed' | 'abandoned' | 'failed'

// These transport endpoints are supplied by the proxy, outside the database schema.
type InboxDatabase = Omit<Database, 'public'> & {
  public: Omit<Database['public'], 'Functions'> & {
    Functions: Database['public']['Functions'] & {
      get_inbox_message: { Args: { p_context: InboxContext }, Returns: { message: InboxMessage | null } }
      record_inbox_message_event: {
        Args: { p_message_id: string, p_viewer_token: string, p_event: InboxEvent, p_reason: string }
        Returns: { status: string }
      }
    }
  }
}

function client() {
  return useSupabase() as unknown as SupabaseClient<InboxDatabase>
}

export function inboxDevice(userAgent = navigator.userAgent, maxTouchPoints = navigator.maxTouchPoints): InboxContext['device'] {
  const parsed = Bowser.parse(userAgent)
  const isIPad = /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  const platform = isIPad ? 'tablet' : parsed.platform.type
  return {
    class: platform === 'mobile' || platform === 'tablet' || platform === 'desktop' ? platform : 'unknown',
    browser: { name: parsed.browser.name ?? null, version: parsed.browser.version ?? null },
    os: { name: isIPad ? 'iPadOS' : parsed.os.name ?? null, version: parsed.os.version ?? null },
    model: parsed.platform.model ?? null,
  }
}

export function inboxContext(scope: Pick<InboxContext, 'locale' | 'org_id' | 'app_id' | 'page'>): InboxContext {
  // Query strings and fragments can contain login or invitation credentials.
  const url = new URL(location.href)
  url.search = ''
  url.hash = ''
  return {
    ...scope,
    current_url: url.href,
    origin: location.origin,
    device: inboxDevice(),
    runtime: { is_native: Capacitor.isNativePlatform(), platform: Capacitor.getPlatform() },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
}

export function validateInboxMessage(value: unknown, serviceOrigin = getLocalConfig().supaHost): InboxMessage | null {
  if (!value || typeof value !== 'object')
    return null
  const message = value as InboxMessage
  try {
    const url = new URL(message.embed_url)
    if (url.protocol !== 'https:' || url.origin !== new URL(serviceOrigin).origin || url.origin === location.origin || url.username || url.password || url.search || url.hash || !/^\/__messages\/[\w-]{32,96}$/.test(url.pathname))
      return null
    if (typeof message.id !== 'string' || !/^[\w-]{1,96}$/.test(message.id))
      return null
    const width = message.presentation?.preferred_width
    const height = message.presentation?.preferred_height
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      return null
    return { id: message.id, embed_url: url.href, presentation: { preferred_width: Math.min(width, 1200), preferred_height: Math.min(height, 900) } }
  }
  catch {
    return null
  }
}

export async function getInboxMessage(context: InboxContext, signal: AbortSignal) {
  const { data, error } = await client().rpc('get_inbox_message', { p_context: context }).abortSignal(signal)
  return error ? null : validateInboxMessage(data?.message)
}

export async function recordInboxEvent(message: InboxMessage, event: InboxEvent, reason: string) {
  await client().rpc('record_inbox_message_event', {
    p_message_id: message.id,
    p_viewer_token: new URL(message.embed_url).pathname.split('/').at(-1)!,
    p_event: event,
    p_reason: reason,
  }).abortSignal(AbortSignal.timeout(5000))
}
