import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('cli posthog volume guardrails', () => {
  it.concurrent('does not emit removed scan lifecycle events', () => {
    const source = readFileSync(join(root, 'cli/src/onboarding/background-check.ts'), 'utf8')
    expect(source).not.toMatch(/scan_started/)
    expect(source).not.toMatch(/scan_ended/)
    expect(source).not.toMatch(/onboarding-analytics/)
  })

  it.concurrent('does not emit removed TUS volume events', () => {
    const utils = readFileSync(join(root, 'cli/src/utils.ts'), 'utf8')
    const upload = readFileSync(join(root, 'cli/src/bundle/upload.ts'), 'utf8')
    expect(utils).not.toMatch(/App TUS upload/)
    expect(upload).not.toMatch(/TUS upload zip performance/)
    expect(upload).toMatch(/Upload zip performance/)
    expect(upload).toMatch(/if \(!isTus\)/)
  })
})
