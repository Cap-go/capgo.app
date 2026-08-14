import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modalSource = readFileSync(new URL('../src/components/dashboard/InviteTeammateModal.vue', import.meta.url), 'utf8')

describe('onboarding invite analytics context', () => {
  it.concurrent('keeps v2 defaults while allowing v3 callers', () => {
    expect(modalSource).toContain('analyticsChannel?: string')
    expect(modalSource).toContain('trackingVersion?: number')
    expect(modalSource).toContain("analyticsChannel: 'onboarding-v2'")
    expect(modalSource).toContain('trackingVersion: 2')
    expect(modalSource).toContain('channel: props.analyticsChannel')
    expect(modalSource).toContain('tracking_version: props.trackingVersion')
    expect(modalSource).toContain("existingUserInviteRole = 'org_admin'")
    expect(modalSource).toContain("newUserInviteRole = 'org_admin'")
  })
})
