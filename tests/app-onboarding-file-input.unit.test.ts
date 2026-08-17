// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { createApp, createSSRApp, h, nextTick, ref } from 'vue'
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

  it('clears the selected filename and native input when the model is reset', async () => {
    const selectedIcon = ref<unknown>(null)
    const container = document.createElement('div')
    document.body.append(container)
    const app = createApp({
      setup: () => () => h(AppOnboardingIconInput, {
        chooseLabel: 'Choose file',
        emptyLabel: 'No file selected',
        label: 'App icon',
        modelValue: selectedIcon.value,
        'onUpdate:modelValue': (value: unknown) => {
          selectedIcon.value = value
        },
      }),
    })

    try {
      app.mount(container)
      const input = container.querySelector('input') as HTMLInputElement
      const file = new File(['icon'], 'icon.png', { type: 'image/png' })
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      Object.defineProperty(input, 'value', { configurable: true, value: 'C:\\fakepath\\icon.png', writable: true })
      input.dispatchEvent(new Event('change'))
      await nextTick()

      expect((selectedIcon.value as File).name).toBe('icon.png')
      expect((selectedIcon.value as File).type).toBe('image/png')
      expect(container.textContent).toContain('icon.png')

      selectedIcon.value = null
      await nextTick()

      expect(container.textContent).toContain('No file selected')
      expect(input.value).toBe('')
    }
    finally {
      app.unmount()
      container.remove()
    }
  })
})
