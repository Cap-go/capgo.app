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
 *
 * The secret only stops new snippet fills, so this also purges the stored
 * ones (Cache-Tag SNIPPET_EDGE_ANSWERS_TAG). Run the purge alone after a
 * LIMITED_APPS change:
 *
 *   bun run snippet-edge-answer:purge
 *
 * Plugin-state reads and timing are regional controls and require explicit
 * environments. Keep them out of shared bulk env files:
 *
 *   bun run plugin-state:set 0.1% prod_eu --dry-run
 *   bun run plugin-state:timing 1% prod_eu --dry-run
 *   bun scripts/set-updates-edge-cache.ts --check-bulk-env=path/to/shared.env
 *
 * Purge env: CLOUDFLARE_API_TOKEN (Cache Purge) and CF_CACHE_PURGE_ZONE_IDS
 * (comma separated, every zone the snippet runs on).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parse as parseEnv } from 'dotenv'
import { parseJsonc, WRANGLER_PATH as WRANGLER_CONFIG } from './generate-plugin-route-hosts.ts'

const SECRET_NAMES = ['UPDATES_EDGE_CACHE', 'SNIPPET_EDGE_ANSWER', 'PLUGIN_STATE_KV', 'PLUGIN_STATE_TIMING'] as const
/** SNIPPET_EDGE_ANSWERS_TAG in plugin_runtime/utils/snippetEdgeAnswer.ts. */
export const SNIPPET_EDGE_ANSWERS_TAG = 'capgo-snippet-edge-answers'

export function resolveSecretName(args: string[]) {
  const flag = args.find(arg => arg.startsWith('--secret='))
  const name = flag ? flag.slice('--secret='.length) : SECRET_NAMES[0]
  const matched = SECRET_NAMES.find(secret => secret === name)
  if (!matched)
    throw new Error(`Unknown secret ${name}. Allowed: ${SECRET_NAMES.join(', ')}`)
  return matched
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

export function resolveTargetEnvs(requested: string[], available: string[], secret: typeof SECRET_NAMES[number] = 'UPDATES_EDGE_CACHE') {
  if (requested.length === 0 && secret.startsWith('PLUGIN_STATE_'))
    throw new Error(`${secret} requires explicit plugin environment(s); a canary must not default to every production region`)
  if (requested.length === 0)
    return available.filter(env => env.startsWith('prod_'))
  const unknown = requested.filter(env => !available.includes(env))
  if (unknown.length > 0)
    throw new Error(`Unknown plugin env(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`)
  return requested
}

/** Shared bulk uploads must never overwrite independently selected regional rollout settings. */
export function assertNoPluginStateBulkSettings(content: string) {
  const settings = Object.keys(parseEnv(content)).filter(key => key === 'PLUGIN_STATE_KV' || key.startsWith('PLUGIN_STATE_KV_') || key === 'PLUGIN_STATE_TIMING')
  if (settings.length > 0)
    throw new Error(`Regional plugin-state settings must stay out of shared bulk env files: ${settings.join(', ')}. Use plugin-state:set with explicit environments.`)
}

/** Drops every stored snippet answer in the given zones. */
export async function purgeSnippetEdgeAnswers(token: string, zoneIds: string[], fetchImpl: typeof fetch = fetch) {
  const failed: string[] = []
  for (const zoneId of zoneIds) {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [SNIPPET_EDGE_ANSWERS_TAG] }),
    })
    const json = await response.json().catch(() => null) as { success?: boolean } | null
    if (!json?.success)
      failed.push(zoneId)
  }
  return failed
}

async function purgeFromEnv(dryRun: boolean) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim()
  const zoneIds = (process.env.CF_CACHE_PURGE_ZONE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean)
  if (!token || zoneIds.length === 0) {
    console.error(`Stored snippet answers were NOT purged (set CLOUDFLARE_API_TOKEN and CF_CACHE_PURGE_ZONE_IDS, then run bun run snippet-edge-answer:purge). Until then they keep answering until their TTL.`)
    return false
  }
  console.log(`Purge Cache-Tag ${SNIPPET_EDGE_ANSWERS_TAG} -> ${zoneIds.join(', ')}${dryRun ? ' (dry run)' : ''}`)
  if (dryRun)
    return true
  const failed = await purgeSnippetEdgeAnswers(token, zoneIds)
  if (failed.length > 0) {
    console.error(`Purge failed for zone(s): ${failed.join(', ')}`)
    return false
  }
  return true
}

async function main() {
  const args = process.argv.slice(2)
  const bulkEnvFlag = args.find(arg => arg.startsWith('--check-bulk-env='))
  if (bulkEnvFlag) {
    assertNoPluginStateBulkSettings(readFileSync(bulkEnvFlag.slice('--check-bulk-env='.length), 'utf8'))
    return
  }
  const dryRun = args.includes('--dry-run')
  const SECRET_NAME = resolveSecretName(args)
  if (args.includes('--purge-only')) {
    if (SECRET_NAME.startsWith('PLUGIN_STATE_'))
      throw new Error('Snippet purge-only mode is not a plugin-state rollout operation')
    if (!await purgeFromEnv(dryRun))
      process.exit(1)
    return
  }
  const [rawValue, ...requestedEnvs] = args.filter(arg => arg !== '--dry-run' && !arg.startsWith('--secret='))
  const value = rawValue ? normalizeEdgeCacheValue(rawValue) : null
  if (!value) {
    console.error(`Usage: bun scripts/set-updates-edge-cache.ts <off|on|N%> [env ...] [--dry-run] [--secret=${SECRET_NAMES.join('|')}]`)
    process.exit(1)
  }

  const envs = resolveTargetEnvs(requestedEnvs, pluginEnvs(parseJsonc(readFileSync(WRANGLER_CONFIG, 'utf8'))), SECRET_NAME)
  console.log(`${SECRET_NAME}=${value} -> ${envs.join(', ')}${dryRun ? ' (dry run)' : ''}`)
  if (dryRun) {
    if (SECRET_NAME === 'SNIPPET_EDGE_ANSWER')
      await purgeFromEnv(true)
    return
  }

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
  if (SECRET_NAME === 'SNIPPET_EDGE_ANSWER' && !await purgeFromEnv(false))
    process.exit(1)
}

if (import.meta.main)
  void main()
