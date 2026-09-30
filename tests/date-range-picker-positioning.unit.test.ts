import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('date range picker positioning', () => {
  it('right-aligns with the trigger but clamps the popover inside the viewport', async () => {
    const source = await readFile(new URL('../src/components/DateRangePicker.vue', import.meta.url), 'utf8')

    // Right edge follows the trigger, then clamps so the popover never spills over the sidebar or off-screen.
    expect(source).toMatch(/Math\.min\(Math\.max\(margin, rect\.right - width\), window\.innerWidth - width - margin\)/)
    expect(source).toMatch(/left:\s*`\$\{Math\.round\(Math\.max\(margin, left\)\)\}px`/)
    // Flips above the trigger only when it does not fit below.
    expect(source).toMatch(/top \+ height > window\.innerHeight - margin/)
    // Native <dialog> UA insets must stay neutralised.
    expect(source).toMatch(/\.date-range-popover\s*\{[^}]*\bleft:\s*auto\s*;/s)
  })
})
