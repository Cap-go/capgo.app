import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('date range picker positioning', () => {
  it('clears the native dialog left inset while retaining trigger right alignment', async () => {
    const source = await readFile(new URL('../src/components/DateRangePicker.vue', import.meta.url), 'utf8')

    expect(source).toMatch(/right:\s*`\$\{Math\.round\(window\.innerWidth - rect\.right\)\}px`/)
    expect(source).toMatch(/\.date-range-popover\s*\{[^}]*\bleft:\s*auto\s*;/s)
  })
})
