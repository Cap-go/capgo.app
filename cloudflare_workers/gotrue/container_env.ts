// Bindings and secrets only the Worker uses; GoTrue never sees them.
const WORKER_ONLY_ENV = new Set(['GOTRUE', 'SUPABASE_SERVICE_ROLE_KEY'])

// Every other string var and secret of this Worker is GoTrue configuration (vars in
// wrangler.jsonc, secrets from internal/cloudflare_gotrue_auth/.env.prod).
export function goTrueStringEnv(env: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return !WORKER_ONLY_ENV.has(entry[0]) && typeof entry[1] === 'string'
    }),
  )
}
