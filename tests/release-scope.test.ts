import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  matchesComponent,
  resolvePendingReleaseScope,
  resolveReleaseScope,
} from '../scripts/release-scope.ts'

describe('release scope matching', () => {
  it.concurrent('does not publish packages for release infrastructure changes', () => {
    const files = [
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
    ]

    expect(matchesComponent('capgo', files)).toBe(false)
    expect(matchesComponent('cli', files)).toBe(false)
    expect(matchesComponent('notifications', files)).toBe(false)
  })

  it.concurrent('does not release the packages changed only by the release-scope fix', () => {
    const files = [
      '.github/workflows/publish_cli.yml',
      '.github/workflows/publish_notifications.yml',
      'scripts/release-scope.ts',
      'tests/release-scope.test.ts',
    ]

    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'rev-list --reverse release-parent..release-fix': 'release-fix',
        'show --format= --name-only release-fix': files.join('\n'),
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    for (const component of ['capgo', 'cli', 'notifications'] as const) {
      expect(resolveReleaseScope(component, 'release-parent', 'release-fix', run)).toEqual({
        shouldRelease: false,
        releaseAs: 'patch',
      })
    }
  })

  it.concurrent('treats root package and test inputs as Capgo-only', () => {
    const files = ['package.json', 'bun.lock', 'tsconfig.json', 'vitest.config.ts']

    expect(matchesComponent('capgo', files)).toBe(true)
    expect(matchesComponent('cli', files)).toBe(false)
    expect(matchesComponent('notifications', files)).toBe(false)
  })

  it.concurrent('treats read-replica schema sync scripts as Capgo releases', () => {
    const files = [
      'scripts/sync-read-replica-schema.ts',
      'scripts/check-read-replica-hyperdrive-schema.sh',
    ]

    expect(matchesComponent('capgo', files)).toBe(true)
    expect(matchesComponent('cli', files)).toBe(false)
    expect(matchesComponent('notifications', files)).toBe(false)
  })

  it.concurrent('treats capgo deploy workflow changes as capgo-only releases', () => {
    const files = ['.github/workflows/build_and_deploy.yml', 'scripts/deploy-scope.ts']

    expect(matchesComponent('capgo', files)).toBe(true)
    expect(matchesComponent('cli', files)).toBe(false)
    expect(matchesComponent('notifications', files)).toBe(false)
  })

  it.concurrent('treats notifications package changes as notifications-only releases', () => {
    const files = ['packages/capacitor-notifications/src/index.ts']

    expect(matchesComponent('capgo', files)).toBe(false)
    expect(matchesComponent('cli', files)).toBe(false)
    expect(matchesComponent('notifications', files)).toBe(true)
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

  it.concurrent('builds package changelogs from the last successful component release', () => {
    for (const [workflowPath, prefix] of [
      ['.github/workflows/publish_cli.yml', 'cli-'],
      ['.github/workflows/publish_notifications.yml', 'notifications-'],
    ] as const) {
      const workflow = readFileSync(workflowPath, 'utf8')
      const changelogUrl = 'compare/$' + '{{ steps.changelog_base.outputs.from_tag }}...$' + '{{ github.ref_name }}'
      const legacyChangelogUrl = 'compare/$' + '{{ steps.changelog.outputs.from_tag }}...$' + '{{ steps.changelog.outputs.to_tag }}'

      expect(workflow).toContain('gh release list')
      expect(workflow).toContain(`--arg prefix "${prefix}"`)
      expect(workflow).toContain('FROM_TAG: $' + '{{ steps.changelog_base.outputs.from_tag }}')
      expect(workflow).toContain(changelogUrl)
      expect(workflow).not.toContain(legacyChangelogUrl)
    }
  })

  it.concurrent('uses the released package in Discord release footers', () => {
    const workflow = readFileSync('.github/workflows/github-releases-to-discord.yml', 'utf8')
    const cliPackage = JSON.parse(readFileSync('cli/package.json', 'utf8')) as { name: string }
    const notificationsPackage = JSON.parse(
      readFileSync('packages/capacitor-notifications/package.json', 'utf8'),
    ) as { name: string }

    expect(workflow).toContain('id: release_metadata')
    expect(workflow).toContain(`cli-[0-9]*) footer_title="Release $(node -p 'require("./cli/package.json").name')"`)
    expect(workflow).toContain(
      `notifications-[0-9]*) footer_title="Release $(node -p 'require("./packages/capacitor-notifications/package.json").name')"`,
    )
    expect(workflow).not.toContain('cli-*) footer_title=')
    expect(workflow).toContain('footer_title: $' + '{{ steps.release_metadata.outputs.footer_title }}')
    expect(cliPackage.name).toBe('@capgo/cli')
    expect(notificationsPackage.name).toBe('@capgo/capacitor-notifications')
  })

  it.concurrent('keeps runtime code scoped to the matching component', () => {
    expect(matchesComponent('capgo', ['src/pages/index.vue'])).toBe(true)
    expect(matchesComponent('cli', ['src/pages/index.vue'])).toBe(false)
    expect(matchesComponent('notifications', ['src/pages/index.vue'])).toBe(false)
    expect(matchesComponent('capgo', ['cli/src/index.ts'])).toBe(false)
    expect(matchesComponent('cli', ['cli/src/index.ts'])).toBe(true)
    expect(matchesComponent('notifications', ['cli/src/index.ts'])).toBe(false)
  })

  it.concurrent('does not release on unrelated changes', () => {
    const files = ['README.md']

    expect(matchesComponent('capgo', files)).toBe(false)
    expect(matchesComponent('cli', files)).toBe(false)
    expect(matchesComponent('notifications', files)).toBe(false)
  })

  it.concurrent('keeps earlier failed component changes pending after a later merge', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'describe --tags --match capgo-[0-9]* --exclude capgo-*-alpha.* --abbrev=0 head-cli-only': 'capgo-12.0.0',
        'rev-list --reverse capgo-12.0.0..head-cli-only': 'capgo-change\ncli-change',
        'show --format= --name-only capgo-change': 'src/pages/index.vue',
        'show --format= --name-only cli-change': 'cli/src/index.ts',
        'log -1 --format=%s capgo-change': 'feat: pending console change',
        'log -1 --format=%b capgo-change': '',
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolvePendingReleaseScope('capgo', 'head-cli-only', false, run)).toEqual({
      base: 'capgo-12.0.0',
      shouldRelease: true,
      releaseAs: 'minor',
    })
  })

  it.concurrent('uses the latest stable component tag as the production baseline', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'describe --tags --match cli-[0-9]* --exclude cli-*-alpha.* --abbrev=0 head': 'cli-8.50.2',
        'rev-list --reverse cli-8.50.2..head': '',
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

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
    const run = (args: string[]) => {
      calls.push(args)
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'describe --tags --match notifications-*-alpha.* --abbrev=0 head': 'notifications-0.2.0-alpha.3',
        'rev-list --reverse notifications-0.2.0-alpha.3..head': '',
      }

      if (key in responses) {
        return responses[key]
      }

      throw new Error(`Unexpected git call: ${key}`)
    }

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
