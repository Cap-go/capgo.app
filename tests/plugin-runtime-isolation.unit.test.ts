import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('plugin_runtime isolation', () => {
  it('keeps plugin_runtime and the CF plugin entry free of shared _backend imports', () => {
    expect(() => {
      execFileSync(process.execPath, [resolve('scripts/check_plugin_runtime_isolation.mjs')], {
        cwd: resolve('.'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }).not.toThrow()
  })
})
