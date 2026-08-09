import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('admin registration source dashboard', () => {
  it.concurrent('wires the auth registration trend to the stacked chart', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/users.vue', import.meta.url), 'utf8')

    expect(source).toContain('registration_source_trend')
    expect(source).toContain('AdminStackedBarChart')
    expect(source).toContain(`t('normal-registration')`)
    expect(source).toContain(`t('organization-invite')`)
    expect(source).toContain(`t('without-profile')`)
  })

  it.concurrent('renders selected-period source totals below the stacked chart', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/users.vue', import.meta.url), 'utf8')

    expect(source).toContain('const registrationSourceTotals = computed(() => {')
    expect(source).toContain('normalRegistrations: totals.normalRegistrations + (Number(item.normal_registrations) || 0)')
    expect(source).toContain('organizationInvites: totals.organizationInvites + (Number(item.invite_registrations) || 0)')
    expect(source).toContain('withoutProfiles: totals.withoutProfiles + (Number(item.without_profile) || 0)')
    expect(source).toContain(':value="registrationSourceTotals.normalRegistrations"')
    expect(source).toContain(':value="registrationSourceTotals.organizationInvites"')
    expect(source).toContain(':value="registrationSourceTotals.withoutProfiles"')
    expect(source).toContain('color-class="text-blue-500"')
    expect(source).toContain('color-class="text-orange-500"')
    expect(source).toContain('color-class="text-slate-400"')
    expect(source.match(/:subtitle="t\('selected-period'\)"/g)).toHaveLength(3)

    const chartIndex = source.indexOf('<AdminStackedBarChart')
    const totalsIndex = source.indexOf('data-test="registration-source-totals"')
    const onboardingTrendIndex = source.indexOf('<!-- Onboarding Trend Chart -->')

    expect(chartIndex).toBeGreaterThan(-1)
    expect(totalsIndex).toBeGreaterThan(chartIndex)
    expect(onboardingTrendIndex).toBeGreaterThan(totalsIndex)
  })

  it.concurrent('defines every registration source label in English', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['registrations-by-source']).toBe('Registrations by source')
    expect(messages['registrations-by-source-description']).toBe('New authentication accounts grouped by their profile creation state')
    expect(messages['normal-registration']).toBe('Normal registration')
    expect(messages['organization-invite']).toBe('Organization invite')
    expect(messages['without-profile']).toBe('Without profile')
  })
})
