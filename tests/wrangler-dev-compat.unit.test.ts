import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('wrangler dev compatibility date override', () => {
  it('uses today UTC when WRANGLER_DEV_COMPATIBILITY_DATE is unset', () => {
    const script = readFileSync(new URL('../scripts/wrangler-dev-compat.sh', import.meta.url), 'utf8')
    expect(script).toContain('WRANGLER_DEV_COMPATIBILITY_DATE')
    expect(script).toContain("date -u +%Y-%m-%d")
    expect(script).toContain('bunx wrangler dev --compatibility-date')
    expect(script).toContain('--compatibility-date=*')
    expect(script).toContain('exec bunx wrangler dev "$@"')
  })

  it('routes Cloudflare test worker startup through the compat wrapper', () => {
    const start = readFileSync(new URL('../scripts/start-cloudflare-workers.sh', import.meta.url), 'utf8')
    expect(start).toContain('scripts/wrangler-dev-compat.sh')
    expect(start).not.toMatch(/exec bunx wrangler dev/)
  })

  it('spawn backend uses repo root paths for wrapper and env file', () => {
    const spawn = readFileSync(new URL('../scripts/local_cf_backend/spawn.sh', import.meta.url), 'utf8')
    expect(spawn).toContain('scripts/wrangler-dev-compat.sh')
    expect(spawn).toContain('REPO_ROOT')
    expect(spawn).toContain('internal/cloudflare/.env.local')
  })
})
