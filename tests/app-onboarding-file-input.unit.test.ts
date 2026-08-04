// @vitest-environment happy-dom

import { defaultConfig, plugin } from '@formkit/vue'
import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { rootClasses } from '../formkit.theme'
import AppOnboardingIconInput from '../src/components/dashboard/AppOnboardingIconInput.vue'

describe('app onboarding file input', () => {
  it('keeps the rendered empty file status visible in dark mode', async () => {
    const app = createSSRApp(AppOnboardingIconInput, { label: 'App icon' })
    app.use(plugin, defaultConfig({ config: { rootClasses } }))

    const html = await renderToString(app)
    const container = document.createElement('div')
    container.innerHTML = html
    const noFiles = container.querySelector('.formkit-noFiles')

    expect(noFiles).not.toBeNull()
    expect(noFiles?.classList.contains('text-slate-600!')).toBe(true)
    expect(noFiles?.classList.contains('dark:text-slate-300!')).toBe(true)
  })
})
