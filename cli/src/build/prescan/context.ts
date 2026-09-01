// src/build/prescan/context.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/supabase.types'
import type { Platform, ScanContext } from './types'
import { getConfig } from '../../utils'
import { mergeCredentials } from '../credentials'
import { withCwd } from '../cwd'

export interface BuildScanContextArgs {
  appId?: string
  platform: Platform
  projectDir: string
  distributionMode?: 'app_store' | 'ad_hoc'
  androidFlavor?: string
  apikey?: string
  supabase?: SupabaseClient<Database>
  supaHost?: string
  supaAnon?: string
  /** pre-merged credentials when called from build request (avoids double work) */
  credentials?: Record<string, string>
}

function validDistributionMode(value: string | undefined): 'app_store' | 'ad_hoc' | undefined {
  return value === 'app_store' || value === 'ad_hoc' ? value : undefined
}

export async function buildScanContext(args: BuildScanContextArgs): Promise<ScanContext> {
  let config
  // @capacitor/cli loadConfig() is cwd-based; honor projectDir for monorepos/workspaces.
  try { config = (await withCwd(args.projectDir, () => getConfig(true))).config }
  catch { config = undefined } // no capacitor project — checks degrade individually
  const appId = args.appId ?? config?.appId
  if (!appId) throw new Error('Missing appId: pass it explicitly or run inside a Capacitor project')
  const credentials = args.credentials
    ?? (await mergeCredentials(appId, args.platform) as Record<string, string> | undefined)
  return {
    appId,
    platform: args.platform,
    hostPlatform: process.platform,
    projectDir: args.projectDir,
    config,
    credentials,
    // Saved credentials carry the distribution mode / flavor the build will actually
    // use (splitPayload reads CAPGO_IOS_DISTRIBUTION / CAPGO_ANDROID_FLAVOR), so fall
    // back to them when no explicit flag was passed — otherwise checks like
    // ios/profile-type-vs-mode and android/flavor-exists silently never run.
    distributionMode: args.distributionMode ?? validDistributionMode(credentials?.CAPGO_IOS_DISTRIBUTION),
    androidFlavor: args.androidFlavor ?? credentials?.CAPGO_ANDROID_FLAVOR,
    apikey: args.apikey,
    supabase: args.supabase,
    supaHost: args.supaHost,
    supaAnon: args.supaAnon,
  }
}
