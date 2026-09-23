import { spawnSync } from 'node:child_process'

const supabaseUrl = process.env.SUPABASE_URL
if (!supabaseUrl) {
  console.error('SUPABASE_URL is required for Playwright frontend preview')
  process.exit(1)
}

const normalizedSupabaseHost = supabaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
const apiDomain = `${normalizedSupabaseHost}/functions/v1`

const env = {
  ...process.env,
  API_DOMAIN: apiDomain,
  CAPTCHA_KEY: '',
  ENV: 'local',
  SUPA_ANON: process.env.SUPABASE_ANON_KEY || '',
  SUPA_URL: supabaseUrl,
}

const build = spawnSync('bun', ['run', 'build'], { env, stdio: 'inherit' })
if ((build.status ?? 1) !== 0)
  process.exit(build.status ?? 1)

const preview = spawnSync('bunx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '5173'], {
  env,
  stdio: 'inherit',
})

process.exit(preview.status ?? 1)
