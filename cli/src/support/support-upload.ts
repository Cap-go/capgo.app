// cli/src/support/support-upload.ts
import { readFileSync } from 'node:fs'

export interface SupportUploadInput {
  apiHost: string
  apikey: string
  appId?: string
  jobId?: string
  platform?: 'ios' | 'android'
  // Path to the already-gzipped bundle (the .log.gz writeSupportBundleFiles produced).
  gzPath: string
}

export interface SupportUploadResult {
  id: string
  url: string
}

// Upload the gzipped support bundle through the capgo backend proxy
// (POST /build/support_logs → capgo_builder worker → R2, sha256-keyed,
// 30-day lifecycle). Returns the public download link, or null on ANY
// failure — callers degrade to the manual-attach flow and never block on this.
export async function uploadSupportLogs(input: SupportUploadInput): Promise<SupportUploadResult | null> {
  let gzB64: string
  try {
    gzB64 = readFileSync(input.gzPath).toString('base64')
  }
  catch {
    return null
  }
  const host = input.apiHost.replace(/\/+$/, '') // tolerate a trailing slash from --supa-host
  try {
    const res = await fetch(`${host}/build/support_logs`, {
      method: 'POST',
      headers: {
        'capgkey': input.apikey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ appId: input.appId, jobId: input.jobId, platform: input.platform, gzB64 }),
      // Short timeout: this is an optional nicety; the attach fallback always works.
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status !== 200)
      return null
    const body = await res.json() as { id?: string, url?: string }
    if (typeof body.id !== 'string' || typeof body.url !== 'string')
      return null
    return { id: body.id, url: body.url }
  }
  catch {
    return null
  }
}
