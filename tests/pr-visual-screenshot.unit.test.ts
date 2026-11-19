import { describe, expect, it } from 'vitest'
import {
  descriptionHasScreenshot,
  isVisualPath,
  MISSING_SCREENSHOT_REVIEW,
  reviewVisualScreenshot,
} from '../scripts/pr-visual-screenshot.ts'

const template = `## Screenshots

<!-- Include screenshots/videos (if any) of how the PR works -->
<!-- Please include this if CLI/frontend behaviour has changed, can be skipped for backend changes -->
`

describe('visual screenshot review', () => {
  it('treats console, email, and native layout files as visual', () => {
    expect(isVisualPath('src/components/Sidebar.vue')).toBe(true)
    expect(isVisualPath('src/styles/style.css')).toBe(true)
    expect(isVisualPath('src/assets/assistant/assistant-cursor.svg')).toBe(true)
    expect(isVisualPath('supabase/templates/bento/deploy_report_24h.html')).toBe(true)
    expect(isVisualPath('cloudflare_workers/api/email_templates/email_change.html')).toBe(true)
    expect(isVisualPath('ios/App/App/Base.lproj/Main.storyboard')).toBe(true)
    expect(isVisualPath('android/app/src/main/res/layout/activity_main.xml')).toBe(true)
    expect(isVisualPath('android/app/src/main/res/drawable/splash.xml')).toBe(true)
  })

  it('ignores backend and docs changes', () => {
    expect(isVisualPath('supabase/functions/_backend/utils/pg.ts')).toBe(false)
    expect(isVisualPath('android/app/src/main/AndroidManifest.xml')).toBe(false)
    expect(isVisualPath('cloudflare_workers/api/email_templates/email_change.txt')).toBe(false)
    expect(isVisualPath('docs/DEPLOY_REPORT_EMAIL.md')).toBe(false)
  })

  it('fails visual changes when the description only has the screenshot heading', () => {
    expect(reviewVisualScreenshot(['src/pages/login.vue'], template)).toEqual({
      ok: false,
      message: MISSING_SCREENSHOT_REVIEW,
      files: ['src/pages/login.vue'],
    })
    expect(descriptionHasScreenshot(`${template}\nA screenshot is attached below.`)).toBe(false)
  })

  it('accepts an image in the description', () => {
    const bodies = [
      `${template}\n![login](https://github.com/user-attachments/assets/8f3c2c53-8d11-4c1a-9b22-668b5a01dd2e)`,
      `${template}\n<img src="https://private-user-images.githubusercontent.com/1/login.png" alt="login">`,
      `${template}\nhttps://camo.githubusercontent.com/abc`,
      `${template}\nSee https://example.com/after.webm`,
      `${template}\n![local](./login.png)`,
    ]
    for (const body of bodies) {
      expect(reviewVisualScreenshot(['src/pages/login.vue', 'supabase/functions/_backend/utils/pg.ts'], body)).toEqual({ ok: true })
    }
  })

  it('ignores images hidden in comments or code fences', () => {
    const hidden = `${template}\n<!-- ![login](https://github.com/user-attachments/assets/hidden) -->\n\`\`\`\n![login](./login.png)\n\`\`\``
    expect(descriptionHasScreenshot(hidden)).toBe(false)
  })

  it('ignores Cubic and Codesmith footer badges', () => {
    const footer = `${template}
<!-- codesmith:footer -->
<a href="https://example.com"><img alt="Autofix with codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark-3x.png"></a>
<!-- /codesmith:footer -->
<!-- This is an auto-generated description by cubic. -->
<img alt="View guided diff" src="https://www.cubic.dev/buttons/review-in-cubic-light.svg">
<!-- End of auto-generated description by cubic. -->
![P2](https://img.shields.io/badge/P2-yellow?style=flat)`
    expect(descriptionHasScreenshot(footer)).toBe(false)
    expect(reviewVisualScreenshot(['src/pages/login.vue'], footer)).toEqual({
      ok: false,
      message: MISSING_SCREENSHOT_REVIEW,
      files: ['src/pages/login.vue'],
    })
    expect(descriptionHasScreenshot(`${footer}\n![login](https://github.com/user-attachments/assets/abc-123)`)).toBe(true)
  })

  it('passes when no visual file changed', () => {
    expect(reviewVisualScreenshot(['supabase/functions/_backend/utils/pg.ts'], '')).toEqual({ ok: true })
    expect(reviewVisualScreenshot([], null)).toEqual({ ok: true })
  })
})
