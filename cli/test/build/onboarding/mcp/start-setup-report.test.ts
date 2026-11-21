import type { NextStepResult } from '../../../../src/build/onboarding/mcp/contract.ts'
import { describe, expect, it } from 'bun:test'
import { createStartSetupReporter } from '../../../../src/build/onboarding/mcp/start-setup-report.ts'

function result(overrides: Partial<NextStepResult>): NextStepResult {
  return { onboarding: 'capgo-builder', phase: 'credentials', state: 'ios-welcome', platform: 'ios', progress: 10, kind: 'auto', summary: '', ...overrides }
}

function setup(overrides: { apikey?: string, orgId?: string } = {}) {
  const tracked: any[] = []
  const report = createStartSetupReporter({
    getApiKey: () => 'apikey' in overrides ? overrides.apikey : 'ak_test',
    getAppId: async () => 'com.test.app',
    resolveOrgId: async () => 'orgId' in overrides ? overrides.orgId : 'org-1',
    track: async (input) => { tracked.push(input) },
  })
  return { report, tracked }
}

describe('MCP start_setup report', () => {
  it('reports the platform once per app and platform', async () => {
    const { report, tracked } = setup()
    await report(result({}))
    await report(result({ state: 'ios-asc-key' }))
    await report(result({ platform: 'android', state: 'android-welcome' }))
    expect(tracked.map(input => [input.action, input.platform, input.appId, input.orgId, input.tags.source])).toEqual([
      ['start_setup', 'ios', 'com.test.app', 'org-1', 'mcp'],
      ['start_setup', 'android', 'com.test.app', 'org-1', 'mcp'],
    ])
    expect(tracked[0].step).toBe('ios-welcome')
  })

  it('ignores results before a platform is chosen', async () => {
    const { report, tracked } = setup()
    await report(result({ platform: undefined, phase: 'app' }))
    await report(result({ phase: 'preflight' }))
    expect(tracked).toEqual([])
  })

  it('skips while the account or owner org is unknown', async () => {
    const noKey = setup({ apikey: undefined })
    await noKey.report(result({}))
    expect(noKey.tracked).toEqual([])

    const noOrg = setup({ orgId: undefined })
    await noOrg.report(result({}))
    expect(noOrg.tracked).toEqual([])
  })
})
