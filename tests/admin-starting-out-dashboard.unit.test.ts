import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('admin starting-out dashboard', () => {
  it.concurrent('wires the organization starting point trend to a stacked chart', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/users.vue', import.meta.url), 'utf8')

    expect(source).toContain('starting_out_trend')
    expect(source).toContain('startingOutTrendSeries')
    expect(source).toContain('chart-id="organizations-by-starting-out"')
    expect(source).toContain(`t('starting-out-no-users')`)
    expect(source).toContain(`t('starting-out-existing-users')`)

    const section = source.slice(
      source.indexOf('chart-id="organizations-by-starting-out"'),
      source.indexOf('<!-- Registration Source Trend Chart -->'),
    )

    expect(section).toContain('<AdminStackedBarChart')
    expect(section).toContain(':series="startingOutTrendSeries"')
  })

  it.concurrent('defines the starting point chart labels in English', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['organizations-by-starting-out']).toBe('Organizations by starting point')
    expect(messages['organizations-by-starting-out-description']).toBe('New organizations grouped by whether they reported having active users. Organizations without an answer are excluded.')
    expect(messages['starting-out-no-users']).toBe('No users yet')
    expect(messages['starting-out-existing-users']).toBe('Has active users')
  })
})
