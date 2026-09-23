import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const defaultRoutingSource = readFileSync(new URL('../src/components/dashboard/ChannelDefaultRoutingMockup.vue', import.meta.url), 'utf8')
const selfAssignSource = readFileSync(new URL('../src/components/dashboard/ChannelSelfAssignMockup.vue', import.meta.url), 'utf8')
const consoleAssignSource = readFileSync(new URL('../src/components/dashboard/ChannelConsoleAssignMockup.vue', import.meta.url), 'utf8')

describe('channel onboarding animation themes', () => {
  it.concurrent('keeps all embedded animation canvases at the same responsive height', () => {
    const sharedEmbeddedHeight = 'height: clamp(32rem, 55vh, 36rem);'

    expect(defaultRoutingSource).toContain(sharedEmbeddedHeight)
    expect(selfAssignSource).toContain(sharedEmbeddedHeight)
    expect(consoleAssignSource).toContain(sharedEmbeddedHeight)
    expect(selfAssignSource).toContain("'csa-shell-embedded': embedded")
    expect(consoleAssignSource).toContain("'csa-console-shell-embedded': embedded")
  })

  it.concurrent('uses Capgo theme tokens for the default-routing canvas and animated state', () => {
    expect(defaultRoutingSource).toContain('--cr-stage-background:')
    expect(defaultRoutingSource).toContain('var(--color-base-100)')
    expect(defaultRoutingSource).toContain('var(--color-base-content)')
    expect(defaultRoutingSource).toContain('background: var(--cr-stage-background);')
    expect(defaultRoutingSource).toContain("color: 'var(--cr-production-name-active)'")
    expect(defaultRoutingSource).not.toContain("color: '#e9fff7'")
  })

  it.concurrent('uses Capgo theme tokens for both scenes in the self-assignment animation', () => {
    expect(selfAssignSource).toContain('--csa-stage-background:')
    expect(selfAssignSource).toContain('--csa-panel-background:')
    expect(selfAssignSource).toContain('var(--color-base-100)')
    expect(selfAssignSource).toContain('var(--color-base-content)')
    expect(selfAssignSource).toContain('background: var(--csa-stage-background);')
    expect(selfAssignSource).toContain('background: var(--csa-panel-background);')
  })

  it.concurrent('lets the console animation backdrop follow the active Capgo theme', () => {
    expect(consoleAssignSource).toContain('--csa-console-stage-background:')
    expect(consoleAssignSource).toContain('var(--color-base-200)')
    expect(consoleAssignSource).toContain('background: var(--csa-console-stage-background);')
    expect(consoleAssignSource).not.toContain('bg-[#dbe7f5]')
  })
})
