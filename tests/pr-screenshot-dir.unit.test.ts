import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const forbidden = [
  'pr-assets',
  'docs/pr-assets',
  'docs/screenshots',
  'docs/pr',
  '.github/pr-screenshots',
  '.github/pr-assets',
  '.github/assets',
  'assets/pr-previews',
]

describe('pr screenshot directory', () => {
  it('keeps committed screenshots in docs/pr-screenshots only', () => {
    for (const dir of forbidden)
      expect(existsSync(dir), dir).toBe(false)
    expect(existsSync('docs/pr-screenshots')).toBe(true)
    const agents = readFileSync('AGENTS.md', 'utf8')
    expect(agents).toContain('docs/pr-screenshots/<feature-slug>/<file>')
    expect(agents).toContain('https://raw.githubusercontent.com/Cap-go/capgo.app/<commit-sha>/docs/pr-screenshots/<feature-slug>/<file>')
  })
})
