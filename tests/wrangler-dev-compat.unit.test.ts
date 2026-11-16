import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('wrangler dev compatibility date override', () => {
  it('uses today UTC when WRANGLER_DEV_COMPATIBILITY_DATE is unset', () => {
    const script = readFileSync(new URL('../scripts/wrangler-dev-compat.sh', import.meta.url), 'utf8')
    expect(script).toContain('WRANGLER_DEV_COMPATIBILITY_DATE')
    expect(script).toContain('WRANGLER_DEV_MAX_COMPATIBILITY_DATE')
    expect(script).toContain("date -u +%Y-%m-%d")
    expect(script).toContain('bunx wrangler dev --compatibility-date')
    expect(script).toContain('--compatibility-date=*')
    expect(script).toContain('exec bunx wrangler dev "$@"')
  })

  it('routes Cloudflare test worker startup through the compat wrapper', () => {
    const start = readFileSync(new URL('../scripts/start-cloudflare-workers.sh', import.meta.url), 'utf8')
    expect(start).toContain('scripts/wrangler-dev-compat.sh')
    expect(start).not.toMatch(/exec bunx wrangler dev/)
    expect(start).toMatch(/cloudflare_workers\/api[^\n]*\$\{WRANGLER_DEV\}/)
    expect(start).toMatch(/cloudflare_workers\/plugin[^\n]*\$\{WRANGLER_DEV\}/)
    expect(start).toMatch(/cloudflare_workers\/files[^\n]*\$\{WRANGLER_DEV\}/)
  })

  it('spawn backend uses repo root paths for wrapper and env file', () => {
    const spawn = readFileSync(new URL('../scripts/local_cf_backend/spawn.sh', import.meta.url), 'utf8')
    expect(spawn).toContain('scripts/wrangler-dev-compat.sh')
    expect(spawn).toContain('cloudflare_workers/api/wrangler.jsonc')
    expect(spawn).toContain('REPO_ROOT')
    expect(spawn).toContain('internal/cloudflare/.env.local')
  })

  it('passes WRANGLER_DEV_COMPATIBILITY_DATE to bunx and skips inject when already set on argv', () => {
    const scriptPath = fileURLToPath(new URL('../scripts/wrangler-dev-compat.sh', import.meta.url))
    const stubDir = mkdtempSync(join(tmpdir(), 'wrangler-dev-compat-bunx-'))
    const bunxPath = join(stubDir, 'bunx')
    writeFileSync(bunxPath, '#!/bin/sh\nprintf "%s\n" "$@"\n', 'utf8')
    chmodSync(bunxPath, 0o755)
    try {
      const outOverride = execFileSync('bash', [scriptPath, '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}`, WRANGLER_DEV_COMPATIBILITY_DATE: '2030-06-01' },
      })
      const lines = outOverride.trim().split('\n')
      const idx = lines.indexOf('--compatibility-date')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(lines[idx + 1]).toBe('2030-06-01')

      const outPassthrough = execFileSync('bash', [scriptPath, '--compatibility-date', '2025-03-01', '--port', '9999'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` },
      })
      expect(outPassthrough.trim().split('\n')).toEqual([
        'wrangler',
        'dev',
        '--compatibility-date',
        '2025-03-01',
        '--port',
        '9999',
      ])
    }
    finally {
      rmSync(stubDir, { recursive: true, force: true })
    }
  })
})
