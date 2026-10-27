import { spawnSync } from 'node:child_process'
import process from 'node:process'

export interface SupabaseStatus {
  API_URL?: string
  STORAGE_S3_URL?: string
  ANON_KEY?: string
  PUBLISHABLE_KEY?: string
  SERVICE_ROLE_KEY?: string
  SECRET_KEY?: string
}

// With PostgREST disabled ([api] enabled = false) the CLI no longer prints
// API_URL, but the gateway still serves Auth, Storage and Functions on the API
// port. Storage's S3 endpoint lives on that same gateway.
export function gatewayUrlFromStatus(status: Record<string, unknown>): string | undefined {
  if (typeof status.API_URL === 'string' && status.API_URL)
    return status.API_URL
  if (typeof status.STORAGE_S3_URL === 'string' && status.STORAGE_S3_URL)
    return new URL(status.STORAGE_S3_URL).origin
  return undefined
}

export function parseSupabaseStatus(stdout: string): SupabaseStatus | null {
  const jsonStart = stdout.indexOf('{')
  if (jsonStart < 0)
    return null

  try {
    const status = JSON.parse(stdout.slice(jsonStart)) as SupabaseStatus
    const apiUrl = gatewayUrlFromStatus(status as Record<string, unknown>)
    return apiUrl ? { ...status, API_URL: apiUrl } : status
  }
  catch {
    return null
  }
}

export function getSupabaseStatus(cwd = process.cwd()): SupabaseStatus | null {
  const result = spawnSync('bun', ['scripts/supabase-worktree.ts', 'status', '-o', 'json'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: 10_000,
  })
  if ((result.status ?? 1) !== 0)
    return null
  return parseSupabaseStatus(result.stdout || '')
}
