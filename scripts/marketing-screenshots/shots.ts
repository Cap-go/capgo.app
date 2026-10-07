import type { Page } from '@playwright/test'

/** Region in device pixels of the 2x capture. */
interface Crop { x: number, y: number, width: number, height: number }

export interface Shot {
  name: string
  path: string
  viewport: { width: number, height: number }
  prepare?: (page: Page) => Promise<void>
  /** Files under the website's `public/landing-demos/`, encoded as webp. */
  exports?: { file: string, width: number, crop?: Crop, quality?: number }[]
}

const APP = 'com.demo.app'
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 430, height: 860 }

const showResolvedHistory = async (page: Page) => {
  await page.getByLabel('Unresolved only').uncheck().catch(() => {})
  await page.waitForTimeout(1500)
}

/** Observe tour: desktop at 2160px wide plus a 430px mobile variant. */
function observeShot(id: string, path: string, prepare?: Shot['prepare']): Shot[] {
  return [
    { name: `observe-${id}`, path, viewport: DESKTOP, prepare, exports: [{ file: `observe/observe-${id}.webp`, width: 2160 }] },
    { name: `observe-${id}-mobile`, path, viewport: MOBILE, prepare, exports: [{ file: `observe/observe-${id}-mobile.webp`, width: 860 }] },
  ]
}

function consoleShot(id: string, path: string, options: Partial<Shot> = {}): Shot {
  return { name: `console-${id}`, path, viewport: DESKTOP, exports: [{ file: `console/${id}.webp`, width: 2160 }], ...options }
}

export const shots: Shot[] = [
  ...observeShot('live-release', `/app/${APP}?days=7`),
  ...observeShot('update-health', `/app/${APP}/observe/errors?days=7`),
  ...observeShot('native-health', `/app/${APP}/observe/native?days=7`),
  ...observeShot('compatibility', `/app/${APP}/observe/compatibility`, showResolvedHistory),
  ...observeShot('plugins', `/app/${APP}/observe/compatibility?view=plugins`),
  ...observeShot('logs', `/app/${APP}/observe/logs`),
  {
    name: 'observe-compatibility-detail',
    path: `/app/${APP}/observe/compatibility`,
    viewport: DESKTOP,
    prepare: showResolvedHistory,
    // Banner + table only, for the narrow Live Update guidance panel.
    exports: [{ file: 'observe/observe-compatibility-detail.webp', width: 1600, quality: 0.82, crop: { x: 585, y: 490, width: 2230, height: 1170 } }],
  },
  consoleShot('builds', `/app/${APP}/builds`, { viewport: { width: 1440, height: 1180 } }),
  consoleShot('rollout', `/app/${APP}/channel/1`, {
    viewport: { width: 1440, height: 1100 },
    prepare: async (page) => {
      await page.getByText(/of devices receive/).first().evaluate((el: Element) => el.closest('div')?.parentElement?.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(600)
    },
  }),
  consoleShot('channels', `/app/${APP}/channels`),
  consoleShot('bundle-dependencies', `/app/${APP}/bundle/5/dependencies?compare=6`),
  consoleShot('device-history', `/app/${APP}/device/ios-7f3a91c2/deployments`),
  consoleShot('notifications', `/app/${APP}/notifications`, {
    viewport: { width: 1440, height: 1380 },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Broadcasts' }).first().click()
      await page.waitForTimeout(1500)
      await page.getByText('Spring sale is live').first().click().catch(() => {})
      await page.waitForTimeout(1500)
    },
    exports: [{ file: 'console/notifications.webp', width: 2160, crop: { x: 0, y: 0, width: 2880, height: 2200 } }],
  }),
  consoleShot('notifications-push-update', `/app/${APP}/notifications`, {
    // Provider status + push update panel, for the Notifications guidance section.
    exports: [{ file: 'console/notifications-push-update.webp', width: 1360, quality: 0.82, crop: { x: 1460, y: 800, width: 1360, height: 740 } }],
  }),
  consoleShot('security', '/settings/organization/Security'),
  consoleShot('members', '/settings/organization/Members'),
  consoleShot('app-access', `/app/${APP}/settings/access`),
  consoleShot('audit-logs', '/settings/organization/AuditLogs'),
  consoleShot('api-keys', '/apikeys', {
    prepare: async (page) => {
      await page.getByText('Remove the filter').click().catch(() => {})
      await page.waitForTimeout(1200)
    },
  }),
  consoleShot('webhooks', '/settings/organization/Webhooks'),
]
