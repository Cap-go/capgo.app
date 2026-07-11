import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matchesComponent, resolveReleaseScope } from '../scripts/release-scope.ts'

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

  it.concurrent('only evaluates component paths from the current push', () => {
    for (const [component, previousTag, componentFile] of [
      ['cli', 'cli-8.25.11', 'cli/src/posthog.ts'],
      ['notifications', 'notifications-0.1.10', 'packages/capacitor-notifications/src/index.ts'],
    ] as const) {
      const run = (args: string[]) => {
        const key = args.join(' ')
        const responses: Record<string, string> = {
          [`describe --tags --match ${component}-[0-9]* --abbrev=0 head-capgo-only`]: previousTag,
          [`rev-list --reverse ${previousTag}..head-capgo-only`]: `${component}-change\ncapgo-change`,
          'rev-list --reverse current-push-parent..head-capgo-only': 'capgo-change',
          [`show --format= --name-only ${component}-change`]: componentFile,
          'show --format= --name-only capgo-change': 'src/pages/index.vue',
          [`log -1 --format=%s ${component}-change`]: `feat(${component}): previous change`,
          [`log -1 --format=%b ${component}-change`]: '',
        }

        if (key in responses) {
          return responses[key]
        }

        throw new Error(`Unexpected git call: ${key}`)
      }

      expect(resolveReleaseScope(component, 'current-push-parent', 'head-capgo-only', run)).toEqual({
        shouldRelease: false,
        releaseAs: 'patch',
      })
    }
  })
})
