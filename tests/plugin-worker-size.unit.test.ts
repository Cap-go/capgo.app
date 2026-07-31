import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT_TIMEOUT_MS = 100_000
const TEST_TIMEOUT_MS = 120_000

describe('plugin worker size budget', () => {
  it('keeps the Cloudflare plugin worker within +15% of the committed size baseline', () => {
    let output = ''
    try {
      output = execFileSync('bun', [resolve('scripts/check_plugin_worker_size.ts')], {
        cwd: resolve('.'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SCRIPT_TIMEOUT_MS,
      })
    }
    catch (error) {
      const err = error as { stdout?: string, stderr?: string, message?: string }
      output = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`
      console.error(output)
      expect.fail(`plugin worker size check failed:\n${output}`)
    }
    // Surface warnings / size deltas in CI logs even on success.
    if (output)
      console.log(output)
    expect(output).toContain('Plugin worker size vs baseline:')
  }, TEST_TIMEOUT_MS)
})
