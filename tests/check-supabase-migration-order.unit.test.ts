import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'

function run(command: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
  })

  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.status}`,
      result.stdout,
      result.stderr,
    ].join('\n'))
  }

  return result
}

function resolveGitPath(): string {
  return run('bash', ['-lc', 'command -v git'], process.cwd()).stdout.trim()
}

describe('supabase migration order check', () => {
  it('uses the local PR merge parent instead of fetching in GitHub pull request runs', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'capgo-migration-order-'))
    const fakeBinDir = join(repoDir, 'fake-bin')
    const migrationsDir = join(repoDir, 'supabase', 'migrations')
    const scriptPath = join(process.cwd(), 'scripts', 'check-supabase-migration-order.sh')
    const realGit = resolveGitPath()

    try {
      mkdirSync(migrationsDir, { recursive: true })
      run('git', ['init', '-b', 'main'], repoDir)
      run('git', ['config', 'user.email', 'test@example.com'], repoDir)
      run('git', ['config', 'user.name', 'Capgo Test'], repoDir)
      run('git', ['config', 'commit.gpgsign', 'false'], repoDir)

      writeFileSync(join(migrationsDir, '20260101000000_base.sql'), 'select 1;\n')
      run('git', ['add', '.'], repoDir)
      run('git', ['commit', '-m', 'base migration'], repoDir)

      run('git', ['checkout', '-b', 'feature'], repoDir)
      writeFileSync(join(migrationsDir, '20260102000000_feature.sql'), 'select 2;\n')
      run('git', ['add', '.'], repoDir)
      run('git', ['commit', '-m', 'feature migration'], repoDir)

      run('git', ['checkout', 'main'], repoDir)
      run('git', ['merge', '--no-ff', 'feature', '-m', 'merge feature'], repoDir)

      mkdirSync(fakeBinDir)
      writeFileSync(join(fakeBinDir, 'git'), `#!/usr/bin/env bash
if [[ "$1" == "fetch" ]]; then
  echo "unexpected git fetch" >&2
  exit 88
fi
exec "$REAL_GIT" "$@"
`)
      chmodSync(join(fakeBinDir, 'git'), 0o755)

      const result = spawnSync('bash', [scriptPath], {
        cwd: repoDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_BASE_REF: 'main',
          GITHUB_EVENT_NAME: 'pull_request',
          PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
          REAL_GIT: realGit,
        },
      })

      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain('unexpected git fetch')
      expect(result.stdout).toContain('Checking Supabase migrations against local merge base parent (main)')
      expect(result.stdout).toContain('Supabase migration filenames are unique')
    }
    finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })
})
