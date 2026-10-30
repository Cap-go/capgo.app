import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { REPLICA_TABLES } from '../read_replicate/schema_catalog.ts'

function runRefreshCommand(error?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'capgo-subscription-command-'))
  const response = {
    status: { code: 0 },
    results: [{
      columns: [{ name: 'table_name' }, { name: 'state' }],
      rows: REPLICA_TABLES.map(table => ({ values: [{ value: table }, { value: 'r' }] })),
    }],
  }

  try {
    // Fake only gcloud, exercising the real Bun entry point and command handling.
    writeFileSync(join(directory, 'gcloud'), `#!/usr/bin/env node
const args = process.argv.slice(2)
if (!args.includes('--partial-result-mode=FAIL_PARTIAL_RESULT')) {
  console.error("ERROR: (gcloud.sql.instances.execute-sql) unrecognized arguments: --partial_result_mode=FAIL_PARTIAL_RESULT (did you mean '--partial-result-mode'?)")
  process.exit(2)
}
const error = ${JSON.stringify(error ?? null)}
if (error) {
  console.error(error)
  process.exit(1)
}
console.log(${JSON.stringify(JSON.stringify(response))})
`, { mode: 0o700 })

    return spawnSync('bun', [
      new URL('../scripts/sync-read-replica-schema.ts', import.meta.url).pathname,
      '--refresh-subscription',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` },
      timeout: 10_000,
    })
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('read-replica subscription gcloud command', () => {
  it.concurrent('uses the supported gcloud flag and succeeds when every table is ready', () => {
    const result = runRefreshCommand()
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Read-replica subscription streams every replicated table.')
  })

  it.concurrent('preserves a gcloud argument error mentioning partial results', () => {
    const error = "ERROR: (gcloud.sql.instances.execute-sql) unrecognized arguments: --partial_result_mode=FAIL_PARTIAL_RESULT (did you mean '--partial-result-mode'?)"
    const result = runRefreshCommand(error)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
    expect(result.stderr).not.toContain('rejected the response at its 10 MB response limit')
  })

  it.concurrent('preserves the original diagnostic for a real response size failure', () => {
    const error = 'ERROR: response size exceeds the 10 MB limit for this SQL statement'
    const result = runRefreshCommand(error)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
  })
})
