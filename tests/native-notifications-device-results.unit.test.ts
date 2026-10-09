import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const notificationsPageSource = readFileSync(new URL('../src/pages/app/[app].notifications.vue', import.meta.url), 'utf8')
const englishMessages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

describe('notifications device results summary', () => {
  it.concurrent('does not show a device count before a recipient lookup ran', () => {
    expect(notificationsPageSource).toContain('{{ hasRecipientLookup ? formatNumber(devices.length) : \'-\' }}')
    expect(notificationsPageSource).toContain('t(\'notification-device-results-hint\')')
    expect(englishMessages['notification-device-results-hint']).toBeTruthy()
  })

  it.concurrent('marks the lookup as done only after a successful lookup', () => {
    const lookup = notificationsPageSource.slice(
      notificationsPageSource.indexOf('async function lookupRecipient('),
      notificationsPageSource.indexOf('catch (error)', notificationsPageSource.indexOf('async function lookupRecipient(')),
    )
    expect(lookup.indexOf('devices.value = response.devices')).toBeLessThan(lookup.indexOf('hasRecipientLookup.value = true'))
  })

  it.concurrent('clears lookup results when the app changes', () => {
    const appWatcher = notificationsPageSource.slice(notificationsPageSource.indexOf('id.value = appParam'))
    expect(appWatcher.indexOf('hasRecipientLookup.value = false')).toBeLessThan(appWatcher.indexOf('if (!appParam)'))
    expect(appWatcher.indexOf('devices.value = []')).toBeLessThan(appWatcher.indexOf('if (!appParam)'))
  })
})
