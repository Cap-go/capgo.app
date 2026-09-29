import { describe, expect, it } from 'vitest'
import { CHANNEL_SELF_STORE_CUTOFF_CAPTION } from '../supabase/functions/_backend/utils/plugin_compatibility.ts'
import {
  buildLegacyPluginUpgradeEvents,
  LEGACY_PLUGIN_UPGRADE_BENTO_EVENT,
  selectLegacyPluginUpgradeEventsForSend,
  summarizeLegacyPluginApps,
} from '../supabase/functions/_backend/utils/legacyPluginUpgradeEvent.ts'

describe('legacy plugin upgrade bento event', () => {
  it('keeps apps whose latest reported devices are on the old channel plugin', () => {
    const apps = summarizeLegacyPluginApps([
      { app_id: 'com.example.old', plugin_version: '7.30.0', device_count: 40 },
      { app_id: 'com.example.old', plugin_version: '7.40.0', device_count: 10 },
      { app_id: 'com.example.current', plugin_version: '7.40.0', device_count: 80 },
      { app_id: 'com.example.placeholder', plugin_version: '0.0.0', device_count: 3 },
      { app_id: 'com.example.tiny', plugin_version: '6.0.0', device_count: 1 },
    ], 2)

    expect(apps.map(app => app.appId)).toEqual(['com.example.old', 'com.example.placeholder'])
    expect(apps[0]).toMatchObject({
      legacyDevices: 40,
      reportedDevices: 50,
      mainPluginVersion: '7.30.0',
    })
  })

  it('sends one event per org admin and includes the apps they can upgrade', () => {
    const events = buildLegacyPluginUpgradeEvents([
      { appId: 'com.example.b', ownerOrgId: 'org-1', legacyDevices: 5, reportedDevices: 5, mainPluginVersion: '6.1.0' },
      { appId: 'com.example.a', ownerOrgId: 'org-1', legacyDevices: 20, reportedDevices: 25, mainPluginVersion: '7.12.0' },
      { appId: 'com.example.other', ownerOrgId: 'org-2', legacyDevices: 8, reportedDevices: 8, mainPluginVersion: '5.9.5' },
    ], new Map([
      ['org-1', ['Admin@Example.com', 'admin@example.com', 'other@example.com']],
      ['org-2', [' ']],
    ]))

    expect(events).toHaveLength(2)
    expect(events.every(event => event.event === LEGACY_PLUGIN_UPGRADE_BENTO_EVENT)).toBe(true)
    expect(events.map(event => event.email)).toEqual(['admin@example.com', 'other@example.com'])
    expect(events[0]?.details).toMatchObject({
      org_id: 'org-1',
      app_count: 2,
      legacy_devices: 25,
      reported_devices: 30,
      main_plugin_version: '7.12.0',
      cutoff: CHANNEL_SELF_STORE_CUTOFF_CAPTION,
    })
    expect(events[0]?.details.apps.map(app => app.app_id)).toEqual(['com.example.a', 'com.example.b'])
  })

  it('sends each email at most once per day and keeps the org with the most old devices', () => {
    const now = new Date('2026-09-29T18:00:00.000Z')
    const events = buildLegacyPluginUpgradeEvents([
      { appId: 'com.example.big', ownerOrgId: 'org-big', legacyDevices: 40, reportedDevices: 40, mainPluginVersion: '7.12.0' },
      { appId: 'com.example.small', ownerOrgId: 'org-small', legacyDevices: 4, reportedDevices: 4, mainPluginVersion: '6.1.0' },
    ], new Map([
      ['org-big', ['admin@example.com']],
      ['org-small', ['admin@example.com', 'other@example.com']],
    ]))

    const firstRun = selectLegacyPluginUpgradeEventsForSend(events, new Map(), now)
    expect(firstRun.map(event => `${event.email}:${event.details.org_id}`)).toEqual([
      'admin@example.com:org-big',
      'other@example.com:org-small',
    ])

    const sameDay = selectLegacyPluginUpgradeEventsForSend(events, new Map([
      ['admin@example.com', '2026-09-29T10:00:00.000Z'],
    ]), now)
    expect(sameDay.map(event => event.email)).toEqual(['other@example.com'])

    const nextDay = selectLegacyPluginUpgradeEventsForSend(events, new Map([
      ['admin@example.com', '2026-09-28T18:00:00.000Z'],
    ]), now)
    expect(nextDay.map(event => event.email)).toEqual(['admin@example.com', 'other@example.com'])
  })
})
