import type { Context } from 'hono'
import type { RlsPrincipal } from '../../utils/pg_rls.ts'
import { withRlsContext } from '../../utils/pg_rls.ts'
import { getEnv } from '../../utils/utils.ts'

export interface SavedBuildOutput {
  url: string
  kind: 'ios_ipa' | 'android_apk' | 'android_aab'
  expires_at: string
}

interface BuilderOutput {
  kind?: string
  downloadUrl?: string
  expiresAt?: number
}

export function pickSavedOutput(outputs: BuilderOutput[] | undefined, platform: string): SavedBuildOutput | undefined {
  const preferred = platform === 'ios' ? ['ios_ipa'] : ['android_apk', 'android_aab']
  for (const kind of preferred) {
    const found = outputs?.find(output => output.kind === kind && typeof output.downloadUrl === 'string' && output.downloadUrl.startsWith('https://'))
    if (!found?.downloadUrl)
      continue
    return {
      url: found.downloadUrl,
      kind: kind as SavedBuildOutput['kind'],
      expires_at: new Date(found.expiresAt ?? 0).toISOString(),
    }
  }
  return undefined
}

export async function savedOutputsForJobs(c: Context, principal: RlsPrincipal, appId: string, ownerOrg: string, jobIds: string[]): Promise<Record<string, SavedBuildOutput>> {
  const ids = [...new Set(jobIds)].filter(id => /^[A-Za-z0-9._:-]{1,80}$/.test(id)).slice(0, 20)
  if (ids.length === 0)
    return {}
  const owned = await withRlsContext(c, principal, async client => (await client.query<{ builder_job_id: string, platform: string }>(
    `SELECT builder_job_id, platform
     FROM public.build_requests
     WHERE app_id = $1 AND owner_org = $2 AND status = 'succeeded' AND builder_job_id = ANY($3::text[])`,
    [appId, ownerOrg, ids],
  )).rows)
  const outputs: Record<string, SavedBuildOutput> = {}
  await Promise.all(owned.map(async (row) => {
    const response = await fetch(`${getEnv(c, 'BUILDER_URL')}/jobs/${encodeURIComponent(row.builder_job_id)}`, {
      headers: { 'x-api-key': getEnv(c, 'BUILDER_API_KEY') },
    })
    if (!response.ok)
      return
    const body = await response.json().catch(() => undefined) as { outputs?: BuilderOutput[] } | undefined
    const saved = pickSavedOutput(body?.outputs, row.platform)
    if (saved)
      outputs[row.builder_job_id] = saved
  }))
  return outputs
}
