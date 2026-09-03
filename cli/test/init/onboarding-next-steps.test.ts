import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const commandSource = readFileSync(new URL('../../src/init/command.ts', import.meta.url), 'utf8')
const uiSource = readFileSync(new URL('../../src/init/ui.ts', import.meta.url), 'utf8')

describe('CLI onboarding next-step copy', () => {
  it('reports a reused console app as add_app done without rewinding resume', () => {
    expect(commandSource).toContain('reusedPendingApp')
    expect(commandSource).toContain('reportInitOnboardingStep(globalReportContext.apikey, appId, 1, \'done\'')
    expect(commandSource).toContain('writing step_done=1')
  })

  it('asks whether the app launched instead of always skipping run_device', () => {
    expect(commandSource).toContain('Did you launch the app on a device or simulator?')
    expect(commandSource).toContain('return confirmDeviceWasLaunched(orgId, apikey)')
    expect(commandSource.includes('if (!doRun)')).toBe(true)
    expect(commandSource).not.toMatch(/if \(!doRun\) \{[\s\S]{0,180}return 'skipped'/)
  })

  it('tells the user to self-test on device without cap sync', () => {
    expect(uiSource).toContain('Self-test on your device')
    expect(uiSource).toContain('Do not run cap sync for this test')
    expect(commandSource).toContain('Background the app and reopen it so it can fetch the update')
    expect(commandSource).toContain('Do not run "${pm.runner} cap sync" for this self-test.')
  })
})
