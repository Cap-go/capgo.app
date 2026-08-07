// src/build/prescan/checks/shared-remote.ts
import type { Finding, PrescanCheck, ScanContext } from '../types'

export const apikeyPermission: PrescanCheck = {
  id: 'shared/apikey-permission',
  platforms: ['ios', 'android'],
  remote: true,
  async run(ctx: ScanContext): Promise<Finding[]> {
    // mirrors hasCliPermission() (src/utils.ts) — call the RPC directly so a false result
    // becomes a Finding instead of a thrown error
    const { data, error } = await ctx.supabase!.rpc('cli_check_permission' as any, {
      apikey: ctx.apikey ?? '',
      permission_key: 'app.build_native',
      org_id: null,
      app_id: ctx.appId,
      channel_id: null,
    })
    if (error) {
      return [{ id: 'shared/apikey-permission', severity: 'info', title: 'Could not verify Capgo build permission (network/API error)', detail: error.message }]
    }
    if (data !== true) {
      return [{
        id: 'shared/apikey-permission',
        severity: 'error',
        title: `Capgo rejected this API key: missing app.build_native permission for ${ctx.appId}`,
        detail: 'Your Capgo API key authenticated, but it lacks native-build rights for this app.',
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
