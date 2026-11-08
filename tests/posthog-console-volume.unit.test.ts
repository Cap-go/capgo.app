import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const posthogSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/services/posthog.ts'),
  'utf8',
)

describe('console posthog volume guardrails', () => {
  it.concurrent('disables autocapture and web vitals while keeping explicit pageviews', () => {
    expect(posthogSource).toMatch(/autocapture:\s*false/)
    expect(posthogSource).toMatch(/capture_performance:\s*\{\s*web_vitals:\s*false\s*\}/)
    expect(posthogSource).not.toMatch(/capture_pageview:\s*false/)
  })
})
