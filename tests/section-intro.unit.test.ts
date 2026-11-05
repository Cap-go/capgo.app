// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import en from '../messages/en.json'
import SectionIntro from '../src/components/SectionIntro.vue'

let app: App | undefined

afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
  localStorage.removeItem('capgo-section-intro-dismissed')
})

async function mountIntro(hideExplanation: boolean) {
  localStorage.removeItem('capgo-section-intro-dismissed')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
  })
  app = createApp(SectionIntro, { section: 'channels', hideExplanation })
  app.use(router)
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
  await router.push('/app/com.example.channels/channels')
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  await nextTick()
  return container
}

describe('section introduction navigation', () => {
  it('retains the bundle/channel/device flow when the explanation is hidden', async () => {
    const container = await mountIntro(true)
    expect(container.textContent).not.toContain(en['channels-description'])
    expect(container.querySelector('[data-test="section-intro-toggle"]')).toBeNull()
    expect(container.querySelector('[data-test="section-intro-dismiss"]')).toBeNull()
    expect(container.querySelector('a[href="/app/com.example.channels/bundles"]')).not.toBeNull()
    expect(container.querySelector('a[href="/app/com.example.channels/devices"]')).not.toBeNull()
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Channel')
  })

  it('preserves the normal dismissible explanation for other callers', async () => {
    const container = await mountIntro(false)
    expect(container.textContent).toContain(en['channels-description'])
    container.querySelector<HTMLButtonElement>('[data-test="section-intro-dismiss"]')!.click()
    await nextTick()
    expect(container.textContent).not.toContain(en['channels-description'])
    expect(container.querySelector('[data-test="section-intro-toggle"]')).not.toBeNull()
  })
})
