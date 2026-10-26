import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  capReleaseAs,
  matchesComponent,
  resolvePendingReleaseScope,
  resolveReleaseScope,
} from '../scripts/release-scope.ts'

function gitStub(responses: Record<string, string>, calls: string[][] = []) {
  return (args: string[]) => {
    calls.push(args)
    const key = args.join(' ')
    if (key in responses)
      return responses[key]
    throw new Error(`Unexpected git call: ${key}`)
  }
}

describe('release scope matching', () => {
  it.concurrent.each([
    ['release infrastructure', [
      '.github/workflows/tests.yml',
      '.github/workflows/bump_version.yml',
      '.github/workflows/publish_cli.yml',
      '.github/workflows/publish_notifications.yml',
      '.github/scripts/start-background-service.sh',
      'scripts/setup-bun.sh',
      'scripts/setup-bun.ps1',
      'scripts/sync-notifications-package-version.ts',
      'scripts/release-scope.ts',
      'tests/release-scope.test.ts',
    ], null],
    ['root package and test inputs', ['package.json', 'bun.lock', 'tsconfig.json', 'vitest.config.ts'], 'capgo'],
    ['read-replica schema sync scripts', ['scripts/sync-read-replica-schema.ts', 'scripts/check-read-replica-hyperdrive-schema.sh'], 'capgo'],
    ['capgo deploy workflow', ['.github/workflows/build_and_deploy.yml', 'scripts/deploy-scope.ts'], 'capgo'],
    ['inventory queue provisioning', ['scripts/ensure-r2-inventory-queues.ts'], 'capgo'],
    ['console runtime code', ['src/pages/index.vue'], 'capgo'],
    ['CLI runtime code', ['cli/src/index.ts'], 'cli'],
    ['notifications package', ['packages/capacitor-notifications/src/index.ts'], 'notifications'],
    ['unrelated docs', ['README.md'], null],
  ] as const)('scopes %s changes to %s only', (_name, files, component) => {
    for (const candidate of ['capgo', 'cli', 'notifications'] as const)
      expect(matchesComponent(candidate, [...files]), candidate).toBe(candidate === component)
  })

  it.concurrent('does not release the packages changed only by the release-scope fix', () => {
    const files = [
      '.github/workflows/publish_cli.yml',
      '.github/workflows/publish_notifications.yml',
      'scripts/release-scope.ts',
      'tests/release-scope.test.ts',
    ]

    const run = gitStub({
      'rev-list --reverse release-parent..release-fix': 'release-fix',
      'show --format= --name-only release-fix': files.join('\n'),
    })

    for (const component of ['capgo', 'cli', 'notifications'] as const) {
      expect(resolveReleaseScope(component, 'release-parent', 'release-fix', run)).toEqual({
        shouldRelease: false,
        releaseAs: 'patch',
      })
    }
  })

  it.concurrent('keeps the notifications plugin major aligned with Capacitor', () => {
    const packageJson = JSON.parse(
      readFileSync('packages/capacitor-notifications/package.json', 'utf8'),
    ) as { version: string, devDependencies: Record<string, string> }
    const capacitorMajor = packageJson.devDependencies['@capacitor/ios'].replace(/^\D*/, '').split('.')[0]

    expect(packageJson.version.split('.')[0]).toBe(capacitorMajor)
    expect(capReleaseAs('notifications', 'major')).toBe('minor')
    expect(capReleaseAs('notifications', 'patch')).toBe('patch')
    expect(capReleaseAs('cli', 'major')).toBe('major')
  })

  it.concurrent('publishes notifications as a public npm package', () => {
    const packageJson = JSON.parse(
      readFileSync('packages/capacitor-notifications/package.json', 'utf8'),
    ) as { publishConfig?: { access?: string } }
    const workflow = readFileSync('.github/workflows/publish_notifications.yml', 'utf8')

    expect(packageJson.publishConfig?.access).toBe('public')
    expect(workflow).toContain('--access public')
    expect(workflow).not.toContain('--access restricted')
  })

  it.concurrent('stages notifications releases for automated 2FA approval', () => {
    const workflow = readFileSync('.github/workflows/publish_notifications.yml', 'utf8')

    expect(() => parse(workflow)).not.toThrow()
    expect(workflow).toContain('npm install -g npm@^11.15.0')
    expect(workflow).toContain('npm stage publish --tag latest --provenance --access public --ignore-scripts')
    expect(workflow).toContain('npm stage publish --tag next --provenance --access public --ignore-scripts')
    expect(workflow).toContain('NODE_AUTH_TOKEN: $' + '{{ secrets.NPM_TOKEN }}')
    expect(workflow).toContain('GH_TOKEN: $' + '{{ secrets.NPM_STAGE_DISPATCH_TOKEN }}')
    expect(workflow).toContain('repos/Cap-go/automations/dispatches')
    expect(workflow).toContain('-f event_type=npm-stage-approve')
    expect(workflow).toContain('working-directory: packages/capacitor-notifications')
    expect(workflow).not.toContain('bun publish')
    expect(workflow).not.toContain('NPM_CONFIG_TOKEN')
  })

  it.concurrent('ignores an auto-sync commit when calculating pending release scope', () => {
    const run = gitStub({
      'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha.* --abbrev=0 auto-sync-head': 'capgo-12.0.0',
      'rev-list --reverse capgo-12.0.0..auto-sync-head': 'auto-sync-head',
      'show --format= --name-only auto-sync-head': 'supabase/schemas/prod.sql\nsrc/types/database.types.ts',
      'log -1 --format=%s auto-sync-head': 'chore(auto-sync): update supabase schema and generated types',
      'log -1 --format=%b auto-sync-head': '',
    })

    expect(resolvePendingReleaseScope('capgo', 'auto-sync-head', false, run)).toEqual({
      base: 'capgo-12.0.0',
      shouldRelease: false,
      releaseAs: 'patch',
    })
  })

  it.concurrent('lets an auto-sync run release earlier pending source changes', () => {
    const run = gitStub({
      'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha.* --abbrev=0 auto-sync-head': 'capgo-12.0.0',
      'rev-list --reverse capgo-12.0.0..auto-sync-head': 'feature-head\nauto-sync-head',
      'show --format= --name-only feature-head': 'src/pages/index.vue',
      'show --format= --name-only auto-sync-head': 'supabase/schemas/prod.sql\nsrc/types/database.types.ts',
      'log -1 --format=%s feature-head': 'feat: pending console change',
      'log -1 --format=%b feature-head': '',
      'log -1 --format=%s auto-sync-head': 'chore(auto-sync): update supabase schema and generated types',
      'log -1 --format=%b auto-sync-head': '',
    })

    expect(resolvePendingReleaseScope('capgo', 'auto-sync-head', false, run)).toEqual({
      base: 'capgo-12.0.0',
      shouldRelease: true,
      releaseAs: 'minor',
    })
  })

  it.concurrent('keeps earlier failed component changes pending after a later merge', () => {
    const run = gitStub({
      'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha.* --abbrev=0 head-cli-only': 'capgo-12.0.0',
      'rev-list --reverse capgo-12.0.0..head-cli-only': 'capgo-change\ncli-change',
      'show --format= --name-only capgo-change': 'src/pages/index.vue',
      'show --format= --name-only cli-change': 'cli/src/index.ts',
      'log -1 --format=%s capgo-change': 'feat: pending console change',
      'log -1 --format=%b capgo-change': '',
    })

    expect(resolvePendingReleaseScope('capgo', 'head-cli-only', false, run)).toEqual({
      base: 'capgo-12.0.0',
      shouldRelease: true,
      releaseAs: 'minor',
    })
  })

  it.concurrent('uses the latest stable component tag as the production baseline', () => {
    const calls: string[][] = []
    const run = gitStub({
      'describe --tags --match cli-[0-9]* --exclude cli-*-alpha.* --abbrev=0 head': 'cli-8.50.2',
      'rev-list --reverse cli-8.50.2..head': '',
    }, calls)

    expect(resolvePendingReleaseScope('cli', 'head', false, run)).toEqual({
      base: 'cli-8.50.2',
      shouldRelease: false,
      releaseAs: 'patch',
    })
    expect(calls).toContainEqual([
      'describe',
      '--tags',
      '--match',
      'cli-[0-9]*',
      '--exclude',
      'cli-*-alpha.*',
      '--abbrev=0',
      'head',
    ])
  })

  it.concurrent('uses the latest alpha component tag as the development baseline', () => {
    const calls: string[][] = []
    const run = gitStub({
      'describe --tags --match notifications-*-alpha.* --abbrev=0 head': 'notifications-0.2.0-alpha.3',
      'rev-list --reverse notifications-0.2.0-alpha.3..head': '',
    }, calls)

    expect(resolvePendingReleaseScope('notifications', 'head', true, run)).toEqual({
      base: 'notifications-0.2.0-alpha.3',
      shouldRelease: false,
      releaseAs: 'patch',
    })
    expect(calls).toContainEqual([
      'describe',
      '--tags',
      '--match',
      'notifications-*-alpha.*',
      '--abbrev=0',
      'head',
    ])
  })

  it.concurrent('rethrows unexpected git describe failures', () => {
    const run = () => {
      throw new Error('fatal: unable to access network')
    }

    expect(() => resolvePendingReleaseScope('capgo', 'head', false, run)).toThrow(
      'fatal: unable to access network',
    )
  })

  it.concurrent('treats divergent history without a reachable tag as untagged', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      if (key === 'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha.* --abbrev=0 divergent-head') {
        throw new Error('fatal: No tags can describe \'divergent-head\'.')
      }

      const responses: Record<string, string> = {
        'rev-list --reverse divergent-head': 'root\ndivergent-head',
        'show --format= --name-only root': 'README.md',
        'show --format= --name-only divergent-head': 'src/main.ts',
        'log -1 --format=%s divergent-head': 'fix: divergent release',
        'log -1 --format=%b divergent-head': '',
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolvePendingReleaseScope('capgo', 'divergent-head', false, run)).toEqual({
      base: null,
      shouldRelease: true,
      releaseAs: 'patch',
    })
  })

  it.concurrent('evaluates the full reachable history when no component tag exists', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      if (key === 'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha.* --abbrev=0 first-head') {
        throw new Error('fatal: No names found, cannot describe anything.')
      }

      const responses: Record<string, string> = {
        'rev-list --reverse first-head': 'root\nfirst-head',
        'show --format= --name-only root': 'README.md',
        'show --format= --name-only first-head': 'src/main.ts',
        'log -1 --format=%s first-head': 'fix: first release',
        'log -1 --format=%b first-head': '',
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolvePendingReleaseScope('capgo', 'first-head', false, run)).toEqual({
      base: null,
      shouldRelease: true,
      releaseAs: 'patch',
    })
  })
})
