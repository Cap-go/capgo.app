import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

function provisionQueues(env: string, outcome = 'created') {
  const dir = mkdtempSync(join(tmpdir(), 'r2-queue-provision-'))
  const log = join(dir, 'calls.log')
  const command = join(dir, 'bunx')
  writeFileSync(command, `#!/bin/sh
printf '%s\\n' "$*" >> "$R2_QUEUE_TEST_LOG"
case "$R2_QUEUE_TEST_OUTCOME" in
  existing) echo 'Queue already exists' >&2; exit 1 ;;
  denied) echo 'Authentication error: permission denied' >&2; exit 1 ;;
esac
`)
  chmodSync(command, 0o755)
  try {
    const result = spawnSync('bun', ['scripts/ensure-r2-inventory-queues.ts', env], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        R2_QUEUE_TEST_LOG: log,
        R2_QUEUE_TEST_OUTCOME: outcome,
      },
      encoding: 'utf8',
      timeout: 10_000,
    })
    return {
      status: result.status,
      error: result.error,
      stderr: result.stderr,
      calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('r2 inventory deployment queue provisioning', () => {
  it.concurrent.each(['alpha', 'prod', 'preprod'])('creates the four %s queues with four-day retention', (env) => {
    const result = provisionQueues(env)

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.calls).toEqual(['', '-dlq', '-repair', '-repair-dlq'].map(suffix =>
      `wrangler queues create capgo-r2-inventory-${env}${suffix} --message-retention-period-secs 345600`,
    ))
  })

  it.concurrent('allows another deployment when the queues already exist', () => {
    const result = provisionQueues('prod', 'existing')

    expect(result.status).toBe(0)
    expect(result.calls).toHaveLength(4)
  })

  it.concurrent('stops provisioning on permission failure so the workflow cannot deploy afterward', () => {
    const result = provisionQueues('prod', 'denied')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('permission denied')
    expect(result.calls).toHaveLength(1)
  })

  it.concurrent('rejects unsupported environments without calling Wrangler', () => {
    const result = provisionQueues('unsupported')

    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual([])
  })
})
