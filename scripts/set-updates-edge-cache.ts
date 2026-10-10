#!/usr/bin/env bun
/**
 * Sets UPDATES_EDGE_CACHE on the plugin workers in one go.
 *
 * One switch for the whole plugin edge cache: /updates, /stats and
 * /channel_self all read it, and a device sampled in by a percentage is
 * sampled in on every endpoint (stable hash of app_id:device_id).
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
 *
 * The snippet edge answers switch (SNIPPET_EDGE_ANSWER, see
 * plugin_runtime/utils/snippetEdgeAnswer.ts) takes the same values:
 *
 *   bun run snippet-edge-answer:set 1%
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parseJsonc, WRANGLER_PATH as WRANGLER_CONFIG } from './generate-plugin-route-hosts.ts'

const SECRET_NAMES = ['UPDATES_EDGE_CACHE', 'SNIPPET_EDGE_ANSWER'] as const

export function resolveSecretName(args: string[]) {
  const flag = args.find(arg => arg.startsWith('--secret='))
  const name = flag ? flag.slice('--secret='.length) : SECRET_NAMES[0]
  if (!(SECRET_NAMES as readonly string[]).includes(name))
    throw new Error(`Unknown secret ${name}. Allowed: ${SECRET_NAMES.join(', ')}`)
  return name
}

export function normalizeEdgeCacheValue(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  if (value === 'on' || value === 'off')
    return value
  const percent = Number.parseFloat(value.replace(/%$/, ''))
  if (!/^\d+(?:\.\d+)?%?$/.test(value) || !Number.isFinite(percent) || percent < 0 || percent > 100)
    return null
  // The worker works in basis points (0.01%): refuse what would round to 0.
  const bps = Math.round(percent * 100)
  if (percent > 0 && bps === 0)
    return null
  if (bps === 0)
    return 'off'
  if (bps === 10_000)
    return 'on'
  return `${bps / 100}%`
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
  const SECRET_NAME = resolveSecretName(args)
  const [rawValue, ...requestedEnvs] = args.filter(arg => arg !== '--dry-run' && !arg.startsWith('--secret='))
  const value = rawValue ? normalizeEdgeCacheValue(rawValue) : null
  if (!value) {
    console.error('Usage: bun run updates-edge-cache:set <off|on|N%> [env ...] [--dry-run] [--secret=SNIPPET_EDGE_ANSWER]')
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
