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

  it.concurrent('defines every registration source label in English', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['registrations-by-source']).toBe('Registrations by source')
    expect(messages['registrations-by-source-description']).toBe('New authentication accounts grouped by their profile creation state')
    expect(messages['normal-registration']).toBe('Normal registration')
    expect(messages['organization-invite']).toBe('Organization invite')
    expect(messages['without-profile']).toBe('Without profile')
  })
})
