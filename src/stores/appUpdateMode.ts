import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSupabase } from '~/services/supabase'

export type AppUpdateMode = 'capgo' | 'website'

export interface AppUpdateModeState {
  updateMode: AppUpdateMode
  websiteUrl: string | null
}

/**
 * Website Live apps hide every classic Capgo feature (bundles, channels,
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
      const { data, error } = await useSupabase()
        .from('apps')
        .select('update_mode, website_url')
        .eq('app_id', appId)
        .maybeSingle()
      if (error || !data)
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
    const { data, error } = await useSupabase()
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
    set(appId, saved)
    return saved
  }

  return { modes, get, isWebsiteMode, load, save, set }
})

/** Normalizes user input to the https URL format accepted by apps.website_url. */
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
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(url.hostname) || url.username || url.password)
    return null
  // The updater stores files relative to the bundle root, so the app must be
  // served from the root of the domain.
  if (url.pathname !== '/' && url.pathname !== '/index.html')
    return null
  return `${url.origin}/`
}
