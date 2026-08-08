import { createSupabaseClient, invokeCapgoCliApi } from '../utils'

const ownerOrgCache = new Map<string, Promise<string | undefined>>()

export interface OrgResolverDeps {
  /** @deprecated Prefer fetchOwnerOrg; kept for existing unit tests. */
  createClient?: typeof createSupabaseClient
  /** Injectable for tests; defaults to GET app via invokeCapgoCliApi. */
  fetchOwnerOrg?: (apikey: string, appId: string, signal?: AbortSignal) => Promise<string | undefined>
}

/**
 * Resolves an app's owner organization id (`apps.owner_org`), promise-cached
 * per `(apikey, appId)`. Returns undefined on any error — never throws.
 * Extracted so the analytics layer and onboarding analytics share one path.
 */
export function resolveOwnerOrgId(apikey: string, appId: string, deps: OrgResolverDeps = {}, signal?: AbortSignal): Promise<string | undefined> {
  const cacheKey = `${apikey}:${appId}`
  const cached = ownerOrgCache.get(cacheKey)
  if (cached)
    return cached

  const promise = (async () => {
    try {
      if (signal?.aborted)
        return undefined
      if (deps.fetchOwnerOrg)
        return await deps.fetchOwnerOrg(apikey, appId, signal)

      // TODO(cli-http): createClient path is legacy test/compat only
      if (deps.createClient) {
        const supabase = await deps.createClient(apikey, undefined, undefined, true, false)
        let query = supabase
          .from('apps')
          .select('owner_org')
          .eq('app_id', appId)
        if (signal)
          query = query.abortSignal(signal)
        const { data } = await query.maybeSingle()
        return data?.owner_org ?? undefined
      }

      const { data, error } = await invokeCapgoCliApi<{ owner_org?: string }>(`app/${encodeURIComponent(appId)}`, {
        apikey,
        method: 'GET',
        body: undefined,
        signal,
      })
      if (error || !data?.owner_org)
        return undefined
      return data.owner_org
    }
    catch {
      return undefined
    }
  })()

  ownerOrgCache.set(cacheKey, promise)
  // Do not cache aborted/failed/negative lookups for the process lifetime.
  void promise.then((value) => {
    if (!value)
      ownerOrgCache.delete(cacheKey)
  }).catch(() => {
    ownerOrgCache.delete(cacheKey)
  })
  return promise
}
