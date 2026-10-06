import { expect, test } from '@playwright/test'

async function setup(page: import('@playwright/test').Page) {
  await page.route('https://sb.capgo.app/__messages/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<html><body style="margin:0;height:900px"><button id="frame-control">Frame control</button><script>parent.postMessage({type:"inbox:ready"}, new URL(document.referrer || "http://localhost:5173").origin);document.addEventListener("keydown",e=>{if(e.key==="Escape")parent.postMessage({type:"inbox:escape"},"http://localhost:5173")})</script></body></html>',
  }))
  await page.goto('/playwright/fixtures/inbox-dialog.html')
  await page.getByRole('button', { name: 'Open message' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

test('embedded dialog keeps preferred content size and an accessible host close control', async ({ page }) => {
  await setup(page)
  const frame = page.locator('dialog iframe')
  await expect.poll(async () => (await frame.boundingBox())?.width).toBe(720)
  await expect.poll(async () => (await frame.boundingBox())?.height).toBe(520)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open message' })).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { inboxDialogFixture: { events: string[] } }).inboxDialogFixture.events)).toEqual(['shown', 'close_button'])
})

test('preferred dimensions shrink on a small viewport and iframe escape closes the host', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 })
  await setup(page)
  const size = await page.locator('dialog iframe').boundingBox()
  expect(size!.width).toBeLessThanOrEqual(358)
  expect(size!.height).toBeLessThanOrEqual(404)
  await page.frameLocator('dialog iframe').locator('#frame-control').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { inboxDialogFixture: { events: string[] } }).inboxDialogFixture.events)).toContain('escape')
})

test('clicking outside the embedded native dialog reports a backdrop dismissal', async ({ page }) => {
  await setup(page)
  await page.mouse.click(5, 5)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { inboxDialogFixture: { events: string[] } }).inboxDialogFixture.events)).toContain('backdrop')
})
