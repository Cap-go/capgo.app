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

  function set(appId: string, state: AppUpdateModeState) {
    modes.value = { ...modes.value, [appId]: state }
  }

  function get(appId: string): AppUpdateModeState | null {
    return modes.value[appId] ?? null
  }

  function isWebsiteMode(appId: string) {
    return modes.value[appId]?.updateMode === 'website'
  }

  async function load(appId: string, force = false): Promise<AppUpdateModeState | null> {
    if (!appId)
      return null
    if (!force && modes.value[appId])
      return modes.value[appId]
    const inflight = pending.get(appId)
    if (inflight && !force)
      return inflight
    const request = (async () => {
      const { data, error } = await useSupabase()
        .from('apps')
        .select('update_mode, website_url')
        .eq('app_id', appId)
        .maybeSingle()
      if (error || !data)
        return null
      const state: AppUpdateModeState = {
        updateMode: data.update_mode === 'website' ? 'website' : 'capgo',
        websiteUrl: data.website_url ?? null,
      }
      set(appId, state)
      return state
    })()
    pending.set(appId, request)
    try {
      return await request
    }
    finally {
      pending.delete(appId)
    }
  }

  async function save(appId: string, state: AppUpdateModeState) {
    const { error } = await useSupabase()
      .from('apps')
      .update({ update_mode: state.updateMode, website_url: state.websiteUrl })
      .eq('app_id', appId)
    if (error)
      throw error
    set(appId, state)
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
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password)
    return null
  url.hash = ''
  url.search = ''
  const normalized = url.toString()
  return normalized.length <= 2048 ? normalized : null
}
