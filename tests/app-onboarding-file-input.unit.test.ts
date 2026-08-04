import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')

describe('app onboarding file input', () => {
  it('keeps the empty file status visible in dark mode', () => {
    const fileInput = source.match(/<FormKit\s+type="file"[\s\S]*?\/>/)?.[0]

    expect(fileInput).toContain('no-files-class="text-slate-600! dark:text-slate-300!"')
  })
})
