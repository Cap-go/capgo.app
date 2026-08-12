// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import AppOnboardingIconInput from '../src/components/dashboard/AppOnboardingIconInput.vue'

describe('app onboarding file input', () => {
  it('keeps the rendered empty file status visible in dark mode', async () => {
    const app = createSSRApp(AppOnboardingIconInput, {
      chooseLabel: 'Choose file',
      emptyLabel: 'No file selected',
      label: 'App icon',
    })

    const html = await renderToString(app)
    const container = document.createElement('div')
    container.innerHTML = html
    const noFiles = Array.from(container.querySelectorAll('span'))
      .find(element => element.textContent?.trim() === 'No file selected')

    expect(noFiles).toBeDefined()
    expect(noFiles?.classList.contains('text-slate-600')).toBe(true)
    expect(noFiles?.classList.contains('dark:text-slate-300')).toBe(true)
  })
})
