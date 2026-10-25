import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useConsole } from '~/services/console'

export type AppUpdateMode = 'capgo' | 'website'

export interface AppUpdateModeState {
  updateMode: AppUpdateMode
  websiteUrl: string | null
}

/**
 * Web2App apps hide every classic Capgo feature (bundles, channels,
 * devices, stats, builds). The layout and settings read the mode from here so
 * one fetch per app drives the whole app section.
 */
export const useAppUpdateModeStore = defineStore('appUpdateMode', () => {
  const modes = ref<Record<string, AppUpdateModeState>>({})
  const pending = new Map<string, Promise<AppUpdateModeState | null>>()
  // Bumped on every write: a read that started before a save must not
  // overwrite the saved state when it resolves late.
  const writeGeneration = new Map<string, number>()

  function set(appId: string, state: AppUpdateModeState) {
    modes.value = { ...modes.value, [appId]: state }
  }

  function get(appId: string): AppUpdateModeState | null {
    return modes.value[appId] ?? null
  }

  function isWebsiteMode(appId: string) {
    return modes.value[appId]?.updateMode === 'website'
  }

  function toState(row: { update_mode: string, website_url: string | null }): AppUpdateModeState {
    return {
      updateMode: row.update_mode === 'website' ? 'website' : 'capgo',
      websiteUrl: row.website_url ?? null,
    }
  }

  /** Seeds the mode from an apps row fetched elsewhere, unless it is already known. */
  function prime(appId: string, row: { update_mode: string, website_url: string | null }) {
    if (appId && !modes.value[appId])
      set(appId, toState(row))
  }

  async function load(appId: string, force = false): Promise<AppUpdateModeState | null> {
    if (!appId)
      return null
    if (!force && modes.value[appId])
      return modes.value[appId]
    const inflight = pending.get(appId)
    if (inflight && !force)
      return inflight
    const generation = writeGeneration.get(appId) ?? 0
    const request = (async () => {
      const { data, error } = await useConsole()
        .from('apps')
        .select('update_mode, website_url')
        .eq('app_id', appId)
        .maybeSingle()
      if (error) {
        // Not cached: the next load() call retries instead of treating the
        // app as classic for the rest of the session.
        console.error('Cannot load app update mode', appId, error)
        return modes.value[appId] ?? null
      }
      if (!data)
        return modes.value[appId] ?? null
      const state = toState(data)
      if ((writeGeneration.get(appId) ?? 0) === generation)
        set(appId, state)
      return modes.value[appId] ?? state
    })()
    pending.set(appId, request)
    try {
      return await request
    }
    finally {
      if (pending.get(appId) === request)
        pending.delete(appId)
    }
  }

  async function save(appId: string, state: AppUpdateModeState) {
    writeGeneration.set(appId, (writeGeneration.get(appId) ?? 0) + 1)
    // RLS denials and missing rows return no error but no row either.
    const { data, error } = await useConsole()
      .from('apps')
      .update({ update_mode: state.updateMode, website_url: state.websiteUrl })
      .eq('app_id', appId)
      .select('update_mode, website_url')
      .maybeSingle()
    if (error)
      throw error
    if (!data)
      throw new Error('App update mode was not saved')
    const saved = toState(data)
    // Bump again: a load that started while this write was in flight read the
    // pre-write generation and could still resolve with the old row.
    writeGeneration.set(appId, (writeGeneration.get(appId) ?? 0) + 1)
    set(appId, saved)
    return saved
  }

  return { modes, get, isWebsiteMode, load, prime, save, set }
})

// Mirrors isBlockedWebsiteHost in supabase/functions/_backend/utils/website_live_check.ts.
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

function isBlockedWebsiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))
}

/** Normalizes user input to the https URL format accepted by apps.website_url and the API. */
export function normalizeWebsiteLiveUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed)
    return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  }
  catch {
    return null
  }
  // Public domain names only: no IP literals, localhost or single-label hosts.
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i.test(url.hostname) || url.username || url.password || isBlockedWebsiteHost(url.hostname))
    return null
  // The updater stores files relative to the bundle root, so the app must be
  // served from the root of the domain.
  if (url.pathname !== '/' && url.pathname !== '/index.html')
    return null
  return `${url.origin}/`
}
