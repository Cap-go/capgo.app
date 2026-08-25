import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { aggregateRegistrationSourceTotals } from '../src/services/adminRegistrationSources'

describe('admin registration source dashboard', () => {
  it.concurrent('wires the auth registration trend to the stacked chart', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/onboarding/sources.vue', import.meta.url), 'utf8')

    expect(source).toContain('registration_source_trend')
    expect(source).toContain('AdminStackedBarChart')
    expect(source).toContain(`t('normal-registration')`)
    expect(source).toContain(`t('organization-invite')`)
    expect(source).toContain(`t('without-profile')`)
  })

  it.concurrent('sums registration source trend values for the selected period', () => {
    expect(aggregateRegistrationSourceTotals([
      {
        date: '2026-08-07',
        normal_registrations: 4,
        invite_registrations: 2,
        without_profile: 1,
      },
      {
        date: '2026-08-08',
        normal_registrations: 3,
        invite_registrations: 1,
        without_profile: 2,
      },
    ])).toEqual({
      normalRegistrations: 7,
      organizationInvites: 3,
      withoutProfiles: 3,
    })

    expect(aggregateRegistrationSourceTotals([])).toEqual({
      normalRegistrations: 0,
      organizationInvites: 0,
      withoutProfiles: 0,
    })
  })

  it.concurrent('renders selected-period source totals below the stacked chart', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/onboarding/sources.vue', import.meta.url), 'utf8')

    expect(source).toContain('aggregateRegistrationSourceTotals(onboardingFunnelData.value?.registration_source_trend ?? [])')
    expect(source).toContain(':value="registrationSourceTotals.normalRegistrations"')
    expect(source).toContain(':value="registrationSourceTotals.organizationInvites"')
    expect(source).toContain(':value="registrationSourceTotals.withoutProfiles"')
    expect(source).toContain('color-class="text-blue-500"')
    expect(source).toContain('color-class="text-orange-500"')
    expect(source).toContain('color-class="text-slate-400"')
    const registrationSection = source.slice(
      source.indexOf('data-test="registration-source-totals"'),
      source.indexOf('data-test="app-onboarding-method-totals"'),
    )
    expect(registrationSection.match(/:subtitle="t\('selected-period'\)"/g)).toHaveLength(3)

    const sectionIndex = source.indexOf('chart-id="registrations-by-source"')
    const sectionEnd = source.indexOf('chart-id="apps-onboarding-by-method"')
    const registrationSectionSource = source.slice(sectionIndex, sectionEnd)
    const chartIndex = registrationSectionSource.indexOf('<AdminStackedBarChart')
    const totalsIndex = registrationSectionSource.indexOf('data-test="registration-source-totals"')

    expect(sectionIndex).toBeGreaterThan(-1)
    expect(chartIndex).toBeGreaterThan(-1)
    expect(totalsIndex).toBeGreaterThan(chartIndex)
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
