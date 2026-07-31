import { describe, expect, it } from 'vitest'
import { resolveDeployScopeFromFiles, resolveDeployScopeFromGit } from '../scripts/deploy-scope.ts'

const noBackendDeploys = {
  api: false,
  files: false,
  plugins: false,
  supabase: false,
  translation: false,
}

describe('deploy scope matching', () => {
  it.concurrent('does not deploy backend targets for frontend-only changes', () => {
    expect(resolveDeployScopeFromFiles(['src/pages/index.vue'])).toEqual(noBackendDeploys)
  })

  it.concurrent('does not deploy backend targets for CLI-only lockfile changes', () => {
    expect(resolveDeployScopeFromFiles(['bun.lock', 'cli/src/index.ts'])).toEqual(noBackendDeploys)
  })

  it.concurrent('runs the subscriber reconciliation for replica schema code changes', () => {
    expect(resolveDeployScopeFromFiles([
      'read_replicate/direct_schema_sync.ts',
      'scripts/check-read-replica-hyperdrive-schema.sh',
      'cloudflare_workers/read-replica-schema-check/index.ts',
    ])).toEqual({
      api: false,
      files: false,
      plugins: false,
      supabase: true,
      translation: false,
    })
  })

  it.concurrent('deploys translation plus API surfaces when source messages change', () => {
    expect(resolveDeployScopeFromFiles(['messages/en.json'])).toEqual({
      api: true,
      files: false,
      plugins: false,
      supabase: true,
      translation: true,
    })
  })

  it.concurrent('keeps plugin endpoint changes scoped to Supabase and plugin workers', () => {
    expect(resolveDeployScopeFromFiles(['supabase/functions/_backend/plugin_runtime/plugins/updates.ts'])).toEqual({
      api: false,
      files: false,
      plugins: true,
      supabase: true,
      translation: false,
    })
  })

  it.concurrent('keeps public API changes scoped to Supabase and API workers', () => {
    expect(resolveDeployScopeFromFiles(['supabase/functions/_backend/public/app/index.ts'])).toEqual({
      api: true,
      files: false,
      plugins: false,
      supabase: true,
      translation: false,
    })
  })

  it.concurrent('deploys shared Hono utilities to API/files workers but not isolated plugins', () => {
    expect(resolveDeployScopeFromFiles(['supabase/functions/_backend/utils/hono.ts'])).toEqual({
      api: true,
      files: true,
      plugins: false,
      supabase: true,
      translation: false,
    })
  })

  it.concurrent('deploys plugin_runtime Hono changes only to plugin workers', () => {
    expect(resolveDeployScopeFromFiles(['supabase/functions/_backend/plugin_runtime/utils/hono.ts'])).toEqual({
      api: false,
      files: false,
      plugins: true,
      supabase: true,
      translation: false,
    })
  })

  it.concurrent('keeps Deno-only plugin stats bridge off the Cloudflare plugin deploy scope', () => {
    expect(resolveDeployScopeFromFiles(['supabase/functions/shared/plugin_deno_stats_fallbacks.ts'])).toEqual({
      api: false,
      files: false,
      plugins: false,
      supabase: true,
      translation: false,
    })
  })


  it.concurrent('deploys files worker when the shared preview subdomain helper changes', () => {
    expect(resolveDeployScopeFromFiles(['supabase/functions/shared/preview-subdomain.ts'])).toEqual({
      api: false,
      files: true,
      plugins: false,
      supabase: true,
      translation: false,
    })
  })

  it.concurrent('deploys API and files workers when the shared TUS file utility changes', () => {
    expect(resolveDeployScopeFromFiles(['supabase/functions/_backend/files/util.ts'])).toEqual({
      api: true,
      files: true,
      plugins: false,
      supabase: true,
      translation: false,
    })
  })

  it.concurrent('deploys package dependency changes to Cloudflare workers without forcing Supabase', () => {
    expect(resolveDeployScopeFromFiles(['package.json'])).toEqual({
      api: true,
      files: true,
      plugins: true,
      supabase: false,
      translation: true,
    })
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

    expect(resolveDeployScopeFromGit('HEAD', run)).toEqual({
      base: 'capgo-11.0.0',
      files: [file],
      head: 'HEAD',
      scope: {
        ...noBackendDeploys,
        [target]: true,
      },
    })
  })
})
