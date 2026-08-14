import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modalSource = readFileSync(new URL('../src/components/dashboard/InviteTeammateModal.vue', import.meta.url), 'utf8')
const organizationPageSource = readFileSync(new URL('../src/pages/onboarding/organization.vue', import.meta.url), 'utf8')
const organizationInviteSource = readFileSync(new URL('../src/components/dashboard/OrganizationOnboardingInvite.vue', import.meta.url), 'utf8')
const stepsAppSource = readFileSync(new URL('../src/components/dashboard/StepsApp.vue', import.meta.url), 'utf8')
const technicalInviteSource = readFileSync(new URL('../src/components/dashboard/TechnicalTeammateInviteCard.vue', import.meta.url), 'utf8')

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

describe('shared technical teammate invitation', () => {
  it.concurrent('reuses one card and preserves the technical modal', () => {
    expect(stepsAppSource).toContain("import TechnicalTeammateInviteCard from '~/components/dashboard/TechnicalTeammateInviteCard.vue'")
    expect(stepsAppSource).toContain('<TechnicalTeammateInviteCard')
    expect(stepsAppSource).toContain('@opened="onTechnicalInviteOpened"')
    expect(stepsAppSource).not.toContain('<!-- Invite Teammate Option -->')
    expect(technicalInviteSource).toContain('data-test="onboarding-technical-invite"')
    expect(technicalInviteSource).toContain('invite-kind="technical"')
    expect(technicalInviteSource).toContain("emit('success', invite)")
  })
})

describe('shared organization onboarding invite panel', () => {
  it.concurrent('owns the existing invite UI while the page owns continuation', () => {
    expect(organizationPageSource).toContain("import OrganizationOnboardingInvite from '~/components/dashboard/OrganizationOnboardingInvite.vue'")
    expect(organizationPageSource).toContain('<OrganizationOnboardingInvite')
    expect(organizationPageSource).toContain('@continue="finishOnboarding"')
    expect(organizationInviteSource).toContain('data-test="onboarding-invite-users"')
    expect(organizationInviteSource).toContain('data-test="onboarding-finish"')
    expect(organizationInviteSource).toContain('<InviteTeammateModal')
    expect(organizationInviteSource).toContain("emit('continue', sentInvites.value.length)")
  })
})
