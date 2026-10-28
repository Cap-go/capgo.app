import { describe, expect, it } from 'vitest'
import {
  hasMigrationChanges,
  requiresSchemaTypesSync,
  resolveDeployScopeFromFiles,
  resolveDeployScopeFromGit,
} from '../scripts/deploy-scope.ts'

const noBackendDeploys = {
  alert_tail: false,
  api: false,
  files: false,
  plugins: false,
  supabase: false,
  translation: false,
}

describe('deploy scope matching', () => {
  it.concurrent('reports migration changes separately from the Supabase deploy scope', () => {
    expect(hasMigrationChanges(['supabase/migrations/20260910000000_example.sql'])).toBe(true)
    expect(hasMigrationChanges(['supabase/functions/main/index.ts'])).toBe(false)
  })

  it.concurrent('synchronizes schema types for the first Capgo release', () => {
    expect(requiresSchemaTypesSync({
      base: null,
      files: [],
      head: 'HEAD',
      scope: {
        alert_tail: true,
        api: true,
        files: true,
        plugins: true,
        supabase: true,
        translation: true,
      },
    })).toBe(true)
  })

  it.concurrent.each([
    ['frontend-only changes deploy no backend target', ['src/pages/index.vue'], {}],
    ['CLI-only lockfile changes deploy no backend target', ['bun.lock', 'cli/src/index.ts'], {}],
    ['replica schema code runs the subscriber reconciliation', ['read_replicate/direct_schema_sync.ts', 'scripts/check-read-replica-hyperdrive-schema.sh', 'cloudflare_workers/read-replica-schema-check/index.ts'], { supabase: true }],
    ['source messages deploy translation plus API surfaces', ['messages/en.json'], { api: true, supabase: true, translation: true }],
    ['plugin endpoints stay scoped to Supabase and plugin workers', ['supabase/functions/_backend/plugin_runtime/plugins/updates.ts'], { plugins: true, supabase: true }],
    ['public API changes stay scoped to Supabase and API workers', ['supabase/functions/_backend/public/app/index.ts'], { api: true, supabase: true }],
    ['hosted MCP server changes deploy with the API worker', ['supabase/functions/_backend/mcp/tools.ts'], { api: true, supabase: true }],
    ['shared Hono utilities deploy to API/files workers but not isolated plugins', ['supabase/functions/_backend/utils/hono.ts'], { api: true, files: true, supabase: true }],
    ['plugin_runtime Hono changes deploy only to plugin workers', ['supabase/functions/_backend/plugin_runtime/utils/hono.ts'], { plugins: true, supabase: true }],
    ['the Deno-only plugin stats bridge stays off the Cloudflare plugin deploy', ['supabase/functions/shared/plugin_deno_stats_fallbacks.ts'], { supabase: true }],
    ['the shared preview subdomain helper deploys the files worker', ['supabase/functions/shared/preview-subdomain.ts'], { files: true, supabase: true }],
    ['the shared TUS file utility deploys API and files workers', ['supabase/functions/_backend/files/util.ts'], { api: true, files: true, supabase: true }],
    ['package dependency changes deploy Cloudflare workers without forcing Supabase', ['package.json'], { alert_tail: true, api: true, files: true, plugins: true, translation: true }],
    ['alert tail worker changes deploy only the tail worker', ['cloudflare_workers/alert_tail/tail_logic.ts'], { alert_tail: true }],
    ['alert tail throttle module deploys tail worker only', ['cloudflare_workers/alert_tail/throttle_logic.ts'], { alert_tail: true }],
    ['alert tail DO deploys tail worker only', ['cloudflare_workers/alert_tail/throttle_do.ts'], { alert_tail: true }],
  ] as const)('%s', (_name, files, deploys) => {
    expect(resolveDeployScopeFromFiles([...files])).toEqual({ ...noBackendDeploys, ...deploys })
  })

  it.concurrent('ignores generated release commits when resolving changed code', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'log -1 --format=%s capgo-12.0.0': 'chore(release): 12.0.0',
        'rev-parse capgo-12.0.0^': 'feature-head',
        'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha* --abbrev=0 feature-head': 'capgo-11.0.0',
        'diff --name-only --diff-filter=ACMRTD capgo-11.0.0..feature-head': 'src/pages/index.vue',
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveDeployScopeFromGit('capgo-12.0.0', run)).toEqual({
      base: 'capgo-11.0.0',
      files: ['src/pages/index.vue'],
      head: 'feature-head',
      scope: noBackendDeploys,
    })
  })

  it.concurrent('excludes alpha tags when resolving production deploy scope', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'log -1 --format=%s capgo-12.0.0': 'chore(release): 12.0.0',
        'rev-parse capgo-12.0.0^': 'feature-head',
        'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha* --abbrev=0 feature-head': 'capgo-11.0.0',
        'diff --name-only --diff-filter=ACMRTD capgo-11.0.0..feature-head': 'supabase/functions/_backend/plugin_runtime/plugins/updates.ts',
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveDeployScopeFromGit('capgo-12.0.0', run)).toEqual({
      base: 'capgo-11.0.0',
      files: ['supabase/functions/_backend/plugin_runtime/plugins/updates.ts'],
      head: 'feature-head',
      scope: {
        alert_tail: false,
        api: false,
        files: false,
        plugins: true,
        supabase: true,
        translation: false,
      },
    })
  })

  it.concurrent('includes alpha tags when resolving alpha deploy scope', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'log -1 --format=%s capgo-12.0.0-alpha.1': 'chore(release): 12.0.0-alpha.1',
        'rev-parse capgo-12.0.0-alpha.1^': 'feature-head',
        'describe --tags --match capgo-[0-9]* --abbrev=0 feature-head': 'capgo-11.0.0-alpha.9',
        'diff --name-only --diff-filter=ACMRTD capgo-11.0.0-alpha.9..feature-head': 'cloudflare_workers/translation/index.ts',
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveDeployScopeFromGit('capgo-12.0.0-alpha.1', run)).toEqual({
      base: 'capgo-11.0.0-alpha.9',
      files: ['cloudflare_workers/translation/index.ts'],
      head: 'feature-head',
      scope: {
        alert_tail: false,
        api: false,
        files: false,
        plugins: false,
        supabase: false,
        translation: true,
      },
    })
  })

  it.concurrent('deploys all targets when no previous Capgo tag exists', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      if (key === 'log -1 --format=%s HEAD') {
        return 'feat: first capgo release'
      }
      if (key === 'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha* --abbrev=0 HEAD') {
        throw Object.assign(new Error('git describe failed'), {
          stderr: 'fatal: No names found, cannot describe anything.',
        })
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveDeployScopeFromGit('HEAD', run)).toEqual({
      base: null,
      files: [],
      head: 'HEAD',
      scope: {
        alert_tail: true,
        api: true,
        files: true,
        plugins: true,
        supabase: true,
        translation: true,
      },
    })
  })

  it.concurrent.each([
    ['supabase', 'supabase/config.toml'],
    ['api', 'cloudflare_workers/api/index.ts'],
    ['translation', 'cloudflare_workers/translation/index.ts'],
    ['files', 'cloudflare_workers/files/index.ts'],
    ['plugins', 'cloudflare_workers/plugin/index.ts'],
    ['alert_tail', 'cloudflare_workers/alert_tail/index.ts'],
  ] as const)('deploys %s when a matched file is deleted', (target, file) => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'log -1 --format=%s HEAD': 'feat: delete deployed code',
        'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha* --abbrev=0 HEAD': 'capgo-11.0.0',
        'diff --name-only --diff-filter=ACMRTD capgo-11.0.0..HEAD': file,
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    const scope = target === 'alert_tail'
      ? {
          ...noBackendDeploys,
          alert_tail: true,
        }
      : {
          ...noBackendDeploys,
          [target]: true,
        }

    expect(resolveDeployScopeFromGit('HEAD', run)).toEqual({
      base: 'capgo-11.0.0',
      files: [file],
      head: 'HEAD',
      scope,
    })
  })
})
