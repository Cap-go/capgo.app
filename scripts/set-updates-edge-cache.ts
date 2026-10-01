#!/usr/bin/env bun
/**
 * Sets UPDATES_EDGE_CACHE on the plugin workers in one go.
 *
 * It is a worker secret (not a wrangler var), so a change applies right away,
 * without a code deploy. Values: off | on | a share of devices like 1%, 0.5, 25.
 *
 *   bun run updates-edge-cache:set 1%                 # every prod_* plugin env
 *   bun run updates-edge-cache:set on prod_eu prod_na # only these envs
 *   bun run updates-edge-cache:set 10% preprod
 *   bun run updates-edge-cache:set off --dry-run
 *
 * Envs come from cloudflare_workers/plugin/wrangler.jsonc.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parseJsonc, WRANGLER_PATH as WRANGLER_CONFIG } from './generate-plugin-route-hosts.ts'

const SECRET_NAME = 'UPDATES_EDGE_CACHE'

export function normalizeEdgeCacheValue(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  if (value === 'on' || value === 'off')
    return value
  const percent = Number.parseFloat(value.replace(/%$/, ''))
  if (!/^\d+(?:\.\d+)?%?$/.test(value) || !Number.isFinite(percent) || percent < 0 || percent > 100)
    return null
  if (percent === 0)
    return 'off'
  if (percent === 100)
    return 'on'
  return `${percent}%`
}

export function pluginEnvs(config: unknown) {
  return Object.keys((config as { env?: Record<string, unknown> }).env ?? {})
}

export function resolveTargetEnvs(requested: string[], available: string[]) {
  if (requested.length === 0)
    return available.filter(env => env.startsWith('prod_'))
  const unknown = requested.filter(env => !available.includes(env))
  if (unknown.length > 0)
    throw new Error(`Unknown plugin env(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`)
  return requested
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const [rawValue, ...requestedEnvs] = args.filter(arg => arg !== '--dry-run')
  const value = rawValue ? normalizeEdgeCacheValue(rawValue) : null
  if (!value) {
    console.error('Usage: bun run updates-edge-cache:set <off|on|N%> [env ...] [--dry-run]')
    process.exit(1)
  }

  const envs = resolveTargetEnvs(requestedEnvs, pluginEnvs(parseJsonc(readFileSync(WRANGLER_CONFIG, 'utf8'))))
  console.log(`${SECRET_NAME}=${value} -> ${envs.join(', ')}${dryRun ? ' (dry run)' : ''}`)
  if (dryRun)
    return

  const failed: string[] = []
  for (const env of envs) {
    // The value goes through stdin, as with an interactive `wrangler secret put`.
    const child = spawnSync('bunx', ['wrangler', 'secret', 'put', SECRET_NAME, '--config', WRANGLER_CONFIG, '--env', env], {
      input: value,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    if (child.status !== 0)
      failed.push(env)
  }
  if (failed.length > 0) {
    console.error(`Failed for: ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log(`Done: ${envs.length} plugin worker(s) now use ${SECRET_NAME}=${value}`)
}

if (import.meta.main)
  main()
