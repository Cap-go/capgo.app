// src/build/prescan/checks/shared-remote.ts
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { checkAppExists } from '../../../api/app'
import { getCapgoCliHttpStatus, invokeCapgoCliApi } from '../../../utils'

function hostFromCtx(ctx: ScanContext) {
  return { supaHost: ctx.supaHost, supaAnon: ctx.supaAnon }
}

export const apikeyPermission: PrescanCheck = {
  id: 'shared/apikey-permission',
  platforms: ['ios', 'android'],
  remote: true,
  async run(ctx: ScanContext): Promise<Finding[]> {
    const { data, error } = await invokeCapgoCliApi<{ allowed?: boolean }>('private/cli/check-permission', {
      apikey: ctx.apikey ?? '',
      method: 'POST',
      body: {
        permission_key: 'app.build_native',
        org_id: null,
        app_id: ctx.appId,
        channel_id: null,
      },
      ...hostFromCtx(ctx),
    })
    if (error) {
      return [{ id: 'shared/apikey-permission', severity: 'info', title: 'Could not verify Capgo build permission (network/API error)', detail: error.message }]
    }
    if (data?.allowed !== true) {
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
    const appNotVisibleFinding = (): Finding => ({
      id: 'shared/app-exists',
      severity: 'error',
      title: `Capgo: app ${ctx.appId} is not visible to this Capgo API key`,
      detail: 'Either the app does not exist in Capgo or it belongs to an org this Capgo key cannot access.',
      fix: `Create it (npx @capgo/cli@latest app add ${ctx.appId}) or pass the right appId / Capgo apikey`,
    })
    try {
      const exists = await checkAppExists(ctx.apikey ?? '', ctx.appId, hostFromCtx(ctx))
      if (!exists)
        return [appNotVisibleFinding()]
      return []
    }
    catch (error) {
      const status = getCapgoCliHttpStatus(error)
      if (status === 404)
        return [appNotVisibleFinding()]
      const detail = error instanceof Error ? error.message : String(error)
      return [{ id: 'shared/app-exists', severity: 'info', title: 'Could not verify app existence (network/API error)', detail }]
    }
  },
}
