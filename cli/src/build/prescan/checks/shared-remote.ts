// src/build/prescan/checks/shared-remote.ts
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { hasCliPermission } from '../../../utils'

export const apikeyPermission: PrescanCheck = {
  id: 'shared/apikey-permission',
  platforms: ['ios', 'android'],
  remote: true,
  async run(ctx: ScanContext): Promise<Finding[]> {
    if (!ctx.supabase || !ctx.apikey) {
      return [{ id: 'shared/apikey-permission', severity: 'info', title: 'Could not verify Capgo build permission (missing API client)', detail: 'No Supabase client or API key in prescan context' }]
    }
    let allowed = false
    try {
      allowed = await hasCliPermission(ctx.supabase, ctx.apikey, 'app.build_native', { appId: ctx.appId })
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return [{ id: 'shared/apikey-permission', severity: 'info', title: 'Could not verify Capgo build permission (network/API error)', detail }]
    }
    if (!allowed) {
      return [{
        id: 'shared/apikey-permission',
        severity: 'error',
        title: `Capgo could not authorize app.build_native for ${ctx.appId}`,
        detail: 'Capgo could not authorize the requested permission for this API key and app.',
        fix: 'Use a Capgo apikey from the org that owns the app (role with native-build rights), or fix the appId',
      }]
    }
    return []
  },
}

export const appExists: PrescanCheck = {
  id: 'shared/app-exists',
  platforms: ['ios', 'android'],
  remote: true,
  async run(ctx: ScanContext): Promise<Finding[]> {
    const { data, error } = await ctx.supabase!
      .from('apps')
      .select('app_id')
      .eq('app_id', ctx.appId)
      .maybeSingle()
    if (error) {
      return [{ id: 'shared/app-exists', severity: 'info', title: 'Could not verify app existence (network/API error)', detail: error.message }]
    }
    if (!data) {
      return [{
        id: 'shared/app-exists',
        severity: 'error',
        title: `Capgo: app ${ctx.appId} is not visible to this Capgo API key`,
        detail: 'Either the app does not exist in Capgo or it belongs to an org this Capgo key cannot access.',
        fix: `Create it (npx @capgo/cli@latest app add ${ctx.appId}) or pass the right appId / Capgo apikey`,
      }]
    }
    return []
  },
}
