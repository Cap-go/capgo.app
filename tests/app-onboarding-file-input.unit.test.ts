// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
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
    expect(noFiles?.getAttribute('aria-live')).toBe('polite')
    const labelFor = container.querySelector('label')?.getAttribute('for')
    const inputId = container.querySelector('input')?.id
    expect(labelFor).toBeTruthy()
    expect(labelFor).toBe(inputId)
  })

  it('uses a unique accessible input id for each rendered instance', async () => {
    const props = {
      chooseLabel: 'Choose file',
      emptyLabel: 'No file selected',
      label: 'App icon',
    }
    const app = createSSRApp({
      render: () => h('div', [
        h(AppOnboardingIconInput, props),
        h(AppOnboardingIconInput, props),
      ]),
    })

    const html = await renderToString(app)
    const container = document.createElement('div')
    container.innerHTML = html
    const inputIds = Array.from(container.querySelectorAll('input'), input => input.id)
    const labelTargets = Array.from(container.querySelectorAll('label'), label => label.htmlFor)

    expect(inputIds).toHaveLength(2)
    expect(new Set(inputIds).size).toBe(2)
    expect(labelTargets).toEqual(inputIds)
  })
})
