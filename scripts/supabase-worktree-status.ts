import { spawnSync } from 'node:child_process'
import process from 'node:process'

export interface SupabaseStatus {
  API_URL?: string
  ANON_KEY?: string
  PUBLISHABLE_KEY?: string
  SERVICE_ROLE_KEY?: string
  SECRET_KEY?: string
}

export function parseSupabaseStatus(stdout: string): SupabaseStatus | null {
  const jsonStart = stdout.indexOf('{')
  if (jsonStart < 0)
    return null

  try {
    return JSON.parse(stdout.slice(jsonStart)) as SupabaseStatus
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
