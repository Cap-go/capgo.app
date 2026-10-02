import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { getSupabaseWorktreeConfig } from './supabase-worktree-config'

// The worktree API port and the local publishable key are deterministic, so CI can
// build the frontend while Supabase is still starting instead of waiting for `status`.
const LOCAL_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

const supabaseUrl = process.env.SUPABASE_URL || `http://127.0.0.1:${getSupabaseWorktreeConfig().ports.api}`
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || LOCAL_SUPABASE_PUBLISHABLE_KEY

const normalizedSupabaseHost = supabaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
const apiDomain = `${normalizedSupabaseHost}/functions/v1`

const env = {
  ...process.env,
  API_DOMAIN: apiDomain,
  CAPTCHA_KEY: '',
  CAPGO_PLAYWRIGHT_FIXTURES: 'true',
  ENV: 'local',
  SUPA_ANON: supabaseAnonKey,
  SUPA_URL: supabaseUrl,
}

console.log(`Building Playwright frontend for ${supabaseUrl}`)
const build = spawnSync('bun', ['run', 'build'], { env, stdio: 'inherit' })
if ((build.status ?? 1) !== 0)
  process.exit(build.status ?? 1)

const preview = spawnSync('bunx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '5173'], {
  env,
  stdio: 'inherit',
})

process.exit(preview.status ?? 1)
