import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getTransientCiJobFailure, isTransientGitHubReadFailure } from '../scripts/retry-transient-ci-run'

describe('transient CI job retry classifier', () => {
  it('classifies external runner shutdowns as transient', () => {
    expect(getTransientCiJobFailure(
      [
        '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.',
        '##[error]Process completed with exit code 143.',
        'Cleaning up orphan processes',
      ].join('\n'),
      ['Run Supabase Start'],
    )).toBe('runner_shutdown')
  })

  it('ignores shutdown text that is not the terminal runner trailer', () => {
    const output = [
      '##[error]The runner has received a shutdown signal.',
      '##[error]Process completed with exit code 143.',
      'Cleaning up orphan processes',
      'FAIL tests/product.test.ts > product assertion',
    ].join('\n')

    expect(getTransientCiJobFailure(output, ['Run backend integration tests'])).toBeNull()
  })

  it('classifies exhausted Docker startup failures only when Supabase start failed', () => {
    const output = 'SUPABASE_START_FINAL_FAILURE=docker_image_pull'

    expect(getTransientCiJobFailure(output, ['Run Supabase Start'])).toBe('supabase_docker_image_pull')
    expect(getTransientCiJobFailure(output, ['Run backend integration tests'])).toBeNull()
  })

  it('uses the terminal startup classification instead of earlier retry output', () => {
    const output = [
      'failed to pull docker image',
      'request returned 503 Service Unavailable',
      'Migration failed: relation does not exist',
      'SUPABASE_START_FINAL_FAILURE=non_transient',
    ].join('\n')

    expect(getTransientCiJobFailure(output, ['Run Supabase Start'])).toBeNull()
  })

  it('does not classify application failures or generic HTTP 500 responses as transient', () => {
    expect(getTransientCiJobFailure('AssertionError: expected 500 to be 200', ['Run backend integration tests'])).toBeNull()
    expect(getTransientCiJobFailure('Migration failed: relation does not exist', ['Run Supabase Start'])).toBeNull()
  })
})

describe('github API read retry classifier', () => {
  it.each([500, 502, 503, 504])('retries HTTP %i responses', (status) => {
    expect(isTransientGitHubReadFailure(`gh: Server Error (HTTP ${status})`)).toBe(true)
  })

  it('retries transient GitHub connection failures', () => {
    expect(isTransientGitHubReadFailure('error connecting to api.github.com')).toBe(true)
    expect(isTransientGitHubReadFailure('read: connection reset by peer')).toBe(true)
  })

  it('does not retry authentication, validation, or rate-limit failures', () => {
    expect(isTransientGitHubReadFailure('gh: HTTP 401: Bad credentials')).toBe(false)
    expect(isTransientGitHubReadFailure('gh: HTTP 422: Validation Failed')).toBe(false)
    expect(isTransientGitHubReadFailure('gh: HTTP 429: rate limit exceeded')).toBe(false)
  })

  it('retries a failed GitHub API read before classifying the run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'capgo-ci-read-retry-'))
    const counter = join(directory, 'count')
    const fakeGh = join(directory, 'gh')
    writeFileSync(fakeGh, `#!/bin/sh
count=0
if [ -f "$FAKE_GH_COUNT" ]; then count=$(sed -n '1p' "$FAKE_GH_COUNT"); fi
count=$((count + 1))
printf '%s' "$count" > "$FAKE_GH_COUNT"
if [ "$count" -eq 1 ]; then
  echo 'gh: Server Error (HTTP 502)' >&2
  exit 1
fi
printf '%s' '{"run_attempt":2,"status":"completed","conclusion":"failure"}'
`)
    chmodSync(fakeGh, 0o755)

    try {
      const result = spawnSync('bun', ['scripts/retry-transient-ci-run.ts', 'Cap-go/capgo.app', '123'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_GH_COUNT: counter,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        },
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(readFileSync(counter, 'utf8')).toBe('2')
      expect(result.stderr).toContain('Transient GitHub API read failure')
      expect(result.stdout).toContain('not an eligible first-attempt failure')
    }
    finally {
      rmSync(directory, { recursive: true })
    }
  })
})

describe('transient CI retry workflow', () => {
  it('is disabled unless the repository explicitly opts in', () => {
    const workflow = readFileSync(new URL('../.github/workflows/retry_transient_ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('vars.ENABLE_TRANSIENT_CI_RETRY == \'true\' &&')
  })
})
