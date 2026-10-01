import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('cloudflare snippet minified build', () => {
  it('index.min.js is up to date and under the 32 KB Snippet limit', () => {
    const output = execFileSync('bun', ['scripts/snippet/build-snippet.ts', '--check'], {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
    })
    expect(output).toContain('Snippet OK')
  })
})
