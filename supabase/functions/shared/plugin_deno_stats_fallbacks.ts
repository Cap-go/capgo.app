import { registerPluginStatsSupabaseFallbacks } from '../_backend/plugin_runtime/utils/plugin_stats.ts'
import { trackBandwidthUsageSB, trackDevicesSB, trackDeviceUsageSB, trackLogsSB, trackVersionUsageSB } from '../_backend/utils/supabase.ts'

/**
 * Deno/local Supabase function boot helper.
 * Bridges isolated plugin_runtime stats writers to supabase-js fallbacks.
 * Must not be imported by the Cloudflare plugin worker.
 */
export function registerPluginStatsSbFallbacksForDeno() {
  registerPluginStatsSupabaseFallbacks({
    trackLogsSB,
    trackDevicesSB,
    trackDeviceUsageSB,
    trackBandwidthUsageSB,
    trackVersionUsageSB,
  })
}
