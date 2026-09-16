import type { NotifyAppReadyCheckOptions } from './notify-app-ready-background'
import { exit } from 'node:process'
import { workerData } from 'node:worker_threads'
import { buildCliRequestHeaders, setCurrentCliCommand } from './analytics/cli-headers'
import { resolveNotifyAppReadyProject } from './onboarding/notify-app-ready-project'
import { scanNotifyAppReadySource } from './onboarding/notify-app-ready-source'
import { defaultApiHost, findSavedKeySilent, isCapgoManagedSupabaseHost, normalizeSupabaseHost, resolveConfiguredCapgoPublicApiHost, trimTrailingSlashes } from './utils'

async function check(options: NotifyAppReadyCheckOptions): Promise<void> {
  const apikey = options.apikey ?? findSavedKeySilent()
  if (!apikey)
    return
  const project = await resolveNotifyAppReadyProject(options)
  if (!project || scanNotifyAppReadySource(project) !== 'found')
    return

  const updater = project.config.plugins?.CapacitorUpdater
  const config = {
    hostApi: updater?.localApi || defaultApiHost,
    supaHost: updater?.localSupa,
    supaKey: updater?.localSupaAnon,
  }
  const explicitSelfHost = options.supaHost && options.supaAnon && !isCapgoManagedSupabaseHost(options.supaHost)
  const apiHost = explicitSelfHost
    ? `${normalizeSupabaseHost(options.supaHost!)}/functions/v1`
    : resolveConfiguredCapgoPublicApiHost(config)
  const anonKey = options.supaAnon ?? config.supaKey
  setCurrentCliCommand(options.command)
  const response = await fetch(`${trimTrailingSlashes(apiHost)}/app/${encodeURIComponent(project.appId)}`, {
    method: 'PUT',
    headers: buildCliRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': apiHost.includes('/functions/v1') && anonKey ? `Bearer ${anonKey}` : apikey,
      'capgkey': apikey,
    }),
    // Preserve source, outcome, and all unrelated onboarding steps.
    body: JSON.stringify({ onboarding: { steps: { add_code: { status: 'done' } } } }),
    signal: AbortSignal.timeout(2_000),
  })
  await response.body?.cancel()
}

void check(workerData as NotifyAppReadyCheckOptions).catch(() => {
  // Missing projects, parser/config failures, and rejected reports are optional.
}).finally(() => exit(0))
