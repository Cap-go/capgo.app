import { expect, test } from '../support/commands'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`startup loader matches ${colorScheme} mode before app scripts load`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.addInitScript(theme => localStorage.setItem('theme', theme), colorScheme)
    await page.route('**/*', (route) => {
      if (route.request().resourceType() === 'script' && new URL(route.request().url()).pathname !== '/theme-bootstrap.js')
        return route.abort()
      return route.continue()
    })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const expectedBackground = colorScheme === 'light' ? 'rgb(248, 250, 252)' : 'rgb(15, 23, 42)'
    await expect(page.locator('#app-loader')).toBeVisible()
    await expect(page.locator('#app-loader')).toHaveCSS('background-color', expectedBackground)
    await expect(page.locator('body')).toHaveCSS('background-color', expectedBackground)
    await expect(page.locator('#app-loader img')).toBeVisible()
    await expect(page.locator('#app-loader img')).toHaveCSS('filter', colorScheme === 'light' ? 'invert(1)' : 'invert(0)')
  })
}
