import type { Locator, Page } from '@playwright/test'

/** Short muted loops for the website. Each flow starts on a loaded page; recording is trimmed to the steps. */
export interface VideoFlow {
  name: string
  path: string
  viewport: { width: number, height: number }
  /** Runs after the page is loaded; everything it shows ends up in the clip. */
  run: (page: Page) => Promise<void>
  /** Website files under `public/landing-demos/` (mp4, webm, and a webp poster share the base name). */
  file: string
}

const APP = 'com.demo.app'
const VIEWPORT = { width: 1280, height: 800 }

/** Fake pointer: Playwright videos do not render the OS cursor. */
export const CURSOR_SCRIPT = `
  window.addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div')
    cursor.id = '__demo-cursor'
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    Object.assign(cursor.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-3px, -2px)', transition: 'scale 120ms', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.5))' })
    document.body.appendChild(cursor)
    document.addEventListener('mousemove', (e) => { cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px' }, true)
    document.addEventListener('mousedown', () => { cursor.style.scale = '0.85' }, true)
    document.addEventListener('mouseup', () => { cursor.style.scale = '1' }, true)
  })
`

/** Glide the fake pointer to an element, pause, and click it. */
async function glideClick(page: Page, target: Locator, pauseMs = 350) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box)
    throw new Error('Video step target is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 })
  await page.waitForTimeout(pauseMs)
  await target.click()
}

export const videoFlows: VideoFlow[] = [
  {
    name: 'video-observe-tour',
    path: `/app/${APP}?days=7`,
    viewport: VIEWPORT,
    file: 'videos/observe-tour',
    run: async (page) => {
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
      await page.waitForTimeout(1800)
      for (const tab of ['Update health', 'Native', 'Compatibility']) {
        await glideClick(page, page.getByText(tab, { exact: true }).first())
        await page.waitForLoadState('networkidle').catch(() => {})
        await page.waitForTimeout(2600)
      }
    },
  },
  {
    name: 'video-native-diff',
    path: `/app/${APP}/bundle/5/dependencies`,
    viewport: VIEWPORT,
    file: 'videos/native-diff',
    run: async (page) => {
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 3)
      await page.waitForTimeout(1500)
      // The page preselects the bundle live on the channel; pick another baseline to show the diff recompute.
      await glideClick(page, page.locator('.d-dropdown > button').first())
      await page.waitForTimeout(700)
      await glideClick(page, page.locator('.d-dropdown-content button', { hasText: '4.8.0' }).first())
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1200)
      await page.mouse.move(VIEWPORT.width * 0.55, VIEWPORT.height * 0.75, { steps: 30 })
      await page.waitForTimeout(3200)
    },
  },
  {
    name: 'video-rollout-pause',
    path: `/app/${APP}/channel/1`,
    viewport: VIEWPORT,
    file: 'videos/rollout-pause',
    run: async (page) => {
      const section = page.getByText('Progressive rollout', { exact: true }).first()
      await section.evaluate((el: Element) => el.scrollIntoView({ block: 'center' }))
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
      await page.waitForTimeout(1500)
      const rolloutRow = section.locator('xpath=ancestor::*[.//button[normalize-space()="Pause" or normalize-space()="Resume"]][1]')
      await glideClick(page, rolloutRow.getByRole('button', { name: 'Pause', exact: true }))
      const dialog = page.getByRole('dialog')
      await page.waitForTimeout(1400)
      await glideClick(page, dialog.getByRole('button', { name: /pause|confirm/i }).last())
      await page.waitForTimeout(2200)
      await glideClick(page, rolloutRow.getByRole('button', { name: 'Resume', exact: true }))
      await page.waitForTimeout(1200)
      await glideClick(page, page.getByRole('dialog').getByRole('button', { name: /resume|confirm/i }).last())
      await page.waitForTimeout(2200)
    },
  },
]
